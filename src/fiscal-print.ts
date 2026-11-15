/**
 * CUPOM FISCAL (DANFE NFC-e) no app desktop: o que o app sabe da fila `fiscal_print_jobs`.
 *
 * O SERVIDOR MONTA, O APP SÓ DESENHA (plano PDV enxuto, 5.8). O job traz o cupom pronto
 * (`FiscalPrintJobContent` v1: linhas já quebradas em 32/48 colunas + o QR); aqui ele é
 * CONFERIDO e convertido nos blocos do modo gráfico (`mono`, `rule`, `qr`) que o Rust desenha
 * (`src-tauri/src/receipt_raster.rs`). A comanda não passa por nada disto.
 *
 * ESPELHO: `parseLine`, `parseVia` e `parseFiscalPrintJobContent` (e as constantes ao lado) são
 * CÓPIA de `src/lib/fiscal/print-job.ts` do monorepo (este app é outro projeto, sem import de
 * lá), e os tipos são cópia de `src/lib/pos/types.ts`. `desktop-fiscal-print.test.ts` (monorepo)
 * exige as funções iguais e as executa lado a lado — mudou lá, copie para cá. Conteúdo fora do
 * contrato volta `null` e NÃO É IMPRESSO: cupom torto é pior que cupom nenhum.
 *
 * PROTOCOLO COM O PAINEL (o painel é de outra frente; o mesmo da `desktop_print_jobs`):
 *  - o app só pega job `pending` com menos de 90 s pela hora do SERVIDOR, e só se ESTE PC
 *    pode imprimir (impressora escolhida, bobina do tamanho do cupom, opção ligada) — senão
 *    deixa para o outro computador;
 *  - pega por CAS `pending -> printing` + `device_id` (erro no CAS = relê por `id` + `device_id`
 *    antes de desistir) e devolve `printed`/`failed`; a 2ª via que não saiu depois da 1ª vira
 *    `printed` + `error = 'via2_failed'`. Desfecho que não gravou fica em DISCO e é REGRAVADO
 *    nas voltas seguintes (mesmo com a opção do PC desligada), NUNCA reimpresso;
 *  - o painel espera 60 s; antes do plano B (navegador/WhatsApp) faz o CAS
 *    `pending -> cancelled`. Perder essa corrida NÃO libera o navegador: o app já pegou, e o
 *    painel espera o desfecho (`failed` libera o plano B; `printing` preso há 60 s de
 *    `claimed_at` = plano B com aviso de dobro; `via2_failed` = só a via do estabelecimento).
 *
 * A MÁQUINA DE ESTADOS DA FILA (`runFiscalQueueRound`, `runFiscalPrintJob`,
 * `flushFiscalOutcomes`) é PURA: o banco e a impressora entram por `FiscalQueuePorts`. O
 * `App.tsx` só liga as portas ao Supabase e ao Rust — e o monorepo executa estas funções com
 * portas falsas para testar o COMPORTAMENTO (`desktop-fiscal-print.test.ts`).
 */
import qrcode from 'qrcode-generator';

export const FISCAL_PRINT_JOB_CONTENT_VERSION = 1 as const;

export type FiscalPrintPaperWidth = 32 | 48;

export type FiscalPrintAlign = 'left' | 'center' | 'right';

export interface FiscalPrintTextLine {
  type: 'text';
  text: string;
  emphasis?: boolean;
  align?: FiscalPrintAlign;
}

export interface FiscalPrintSeparatorLine {
  type: 'separator';
}

export interface FiscalPrintQrBlock {
  type: 'qr';
  payload: string;
  align?: FiscalPrintAlign;
}

export type FiscalPrintLine = FiscalPrintTextLine | FiscalPrintSeparatorLine | FiscalPrintQrBlock;

/** Uma via do cupom: um papel, com corte próprio (2 em contingência). */
export interface FiscalPrintVia {
  lines: FiscalPrintLine[];
}

export interface FiscalPrintJobContent {
  version: typeof FISCAL_PRINT_JOB_CONTENT_VERSION;
  paperWidth: FiscalPrintPaperWidth;
  vias: FiscalPrintVia[];
}

const ALIGNS: readonly FiscalPrintAlign[] = ['left', 'center', 'right'];

/** Teto de linhas de UMA via (proteção contra conteúdo absurdo, não regra fiscal). */
export const FISCAL_PRINT_MAX_LINES = 400;

/**
 * Job mais velho que isto, pela hora do SERVIDOR, o app não imprime. ESPELHA o de
 * `src/lib/fiscal/print-job.ts`.
 */
export const FISCAL_PRINT_JOB_MAX_AGE_MS = 90_000;

/** Quanto o painel espera o `printed` antes do CAS `pending -> cancelled` e do plano B. */
export const FISCAL_PRINT_PANEL_WAIT_MS = 60_000;

function parseLine(raw: unknown, width: number): FiscalPrintLine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const line = raw as Record<string, unknown>;
  if (line.align !== undefined && !ALIGNS.includes(line.align as FiscalPrintAlign)) return null;
  const align = line.align as FiscalPrintAlign | undefined;

  if (line.type === 'separator') return { type: 'separator' };

  if (line.type === 'text') {
    if (typeof line.text !== 'string') return null;
    // O servidor já quebrou a linha: nada passa da largura nem leva caractere de controle
    // (a marca de destaque é a propriedade `emphasis`, nunca um byte no texto — anti-forja).
    if (line.text.length > width || /[\u0000-\u001f\u007f]/.test(line.text)) return null;
    if (line.emphasis !== undefined && typeof line.emphasis !== 'boolean') return null;
    return { type: 'text', text: line.text, ...(line.emphasis ? { emphasis: true } : {}), ...(align ? { align } : {}) };
  }

  if (line.type === 'qr') {
    // Só ASCII imprimível: o QR da NFC-e é uma URL, e o `qrcode-generator` (app e navegador)
    // usa só o byte baixo de cada caractere — outro caractere viraria um QR que não abre.
    if (typeof line.payload !== 'string' || !line.payload.trim() || line.payload.length > 1000) return null;
    if (!/^[\x20-\x7e]+$/.test(line.payload)) return null;
    return { type: 'qr', payload: line.payload, ...(align ? { align } : {}) };
  }

  return null;
}

function parseVia(raw: unknown, width: number): FiscalPrintVia | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const via = raw as Record<string, unknown>;
  if (!Array.isArray(via.lines) || via.lines.length === 0 || via.lines.length > FISCAL_PRINT_MAX_LINES) return null;
  const lines: FiscalPrintLine[] = [];
  for (const rawLine of via.lines) {
    const line = parseLine(rawLine, width);
    if (!line) return null;
    lines.push(line);
  }
  // Via de NFC-e sem QR de consulta não vale como documento: o cupom inteiro não imprime.
  if (!lines.some((line) => line.type === 'qr')) return null;
  return { lines };
}

/** O conteúdo cru → contrato conferido, ou `null` (não imprimir). Nunca lança. */
export function parseFiscalPrintJobContent(raw: unknown): FiscalPrintJobContent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const content = raw as Record<string, unknown>;
  if (content.version !== FISCAL_PRINT_JOB_CONTENT_VERSION) return null;
  if (content.paperWidth !== 32 && content.paperWidth !== 48) return null;
  // 1 via; 2 em contingência (Consumidor e Estabelecimento).
  if (!Array.isArray(content.vias) || content.vias.length < 1 || content.vias.length > 2) return null;

  const vias: FiscalPrintVia[] = [];
  for (const rawVia of content.vias) {
    const via = parseVia(rawVia, content.paperWidth);
    if (!via) return null;
    vias.push(via);
  }

  return { version: FISCAL_PRINT_JOB_CONTENT_VERSION, paperWidth: content.paperWidth, vias };
}

// ---------------------------------------------------------------------------------------------
// Fila e desenho (só do app)
// ---------------------------------------------------------------------------------------------

export const FISCAL_PRINT_EXPIRED_ERROR = 'expirado';

/** `error` de um job `printed` cuja 2ª via não saiu. ESPELHA o de `src/lib/fiscal/print-job.ts`. */
export const FISCAL_PRINT_VIA2_FAILED = 'via2_failed';

/** Volta da fila em regime normal. O painel espera 60 s pelo cupom. */
export const FISCAL_PRINT_POLL_MS = 10_000;

/** Teto da espera entre voltas quando a leitura falha (internet caída, relógio não medido). */
export const FISCAL_PRINT_POLL_MAX_MS = 30_000;

/** Jobs lidos por volta: os mais velhos primeiro, dentro da janela de 90 s. */
export const FISCAL_PRINT_POLL_LIMIT = 10;

/** Desfecho (`printed`/`failed`) que não gravou: quantas voltas ele ainda é regravado. */
export const FISCAL_OUTCOME_MAX_RETRIES = 30;

/** Espera até a próxima volta: 10 s; dobrando a cada falha seguida, até 30 s. */
export function fiscalPrintPollDelayMs(consecutiveFailures: number): number {
  const failures = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0 ? Math.floor(consecutiveFailures) : 0;
  return Math.min(FISCAL_PRINT_POLL_MS * 2 ** Math.min(failures, 10), FISCAL_PRINT_POLL_MAX_MS);
}

/**
 * Âncora da hora do SERVIDOR: a hora do servidor medida em `checkClock` (`measureClockSkew`) e
 * o `performance.now()` do MESMO instante. Daí em diante o tempo decorrido é contado pelo relógio
 * MONOTÔNICO: acertar (ou desacertar) o relógio do PC no meio do expediente não move a janela de
 * 90 s. `null` sem medida confiável.
 */
export interface FiscalServerClock {
  serverMs: number;
  perfMs: number;
}

export function fiscalClockAnchor(receivedAtMs: number, clockSkewMs: number | null, perfMs: number): FiscalServerClock | null {
  if (typeof clockSkewMs !== 'number' || !Number.isFinite(clockSkewMs)) return null;
  if (!Number.isFinite(receivedAtMs) || !Number.isFinite(perfMs)) return null;
  return { serverMs: receivedAtMs - clockSkewMs, perfMs };
}

/** A hora do servidor AGORA, pela âncora + o tempo monotônico decorrido. `null` sem âncora. */
export function fiscalServerNowMs(clock: FiscalServerClock | null, perfNowMs: number): number | null {
  if (!clock || !Number.isFinite(perfNowMs)) return null;
  return clock.serverMs + (perfNowMs - clock.perfMs);
}

/**
 * O job passou da idade (pela hora do servidor)? Data ilegível conta como VENCIDO: sem saber
 * quando o cupom foi pedido, imprimir pode repetir um cupom que o plano B já resolveu.
 */
export function isFiscalPrintJobExpired(createdAt: unknown, serverNowMs: number): boolean {
  const createdMs = typeof createdAt === 'string' ? new Date(createdAt).getTime() : Number.NaN;
  if (!Number.isFinite(createdMs)) return true;
  return serverNowMs - createdMs > FISCAL_PRINT_JOB_MAX_AGE_MS;
}

/** O que ESTE computador sabe de si para decidir se pega o cupom. */
export interface FiscalPcState {
  printerName: string | null | undefined;
  paperWidth: number;
  /**
   * "Imprimir cupom fiscal neste computador": `true` imprime; `false` não; AUSENTE = o lojista
   * ainda não escolheu, e enquanto não escolher este PC não imprime (com dois PCs, o cupom sairia
   * no primeiro que pegasse — não necessariamente no do caixa).
   */
  fiscalPrintHere: boolean | undefined;
}

/** Por que ESTE PC não pega o cupom. */
export type FiscalPrintBlock = 'not_chosen' | 'off' | 'no_printer' | 'paper';

/** O aviso fixo que o app mostra para cada bloqueio que o lojista precisa resolver. */
export const FISCAL_BLOCK_NOTICES: Record<FiscalPrintBlock, string> = {
  not_chosen: 'Escolha se este computador imprime o cupom fiscal',
  off: 'Cupom fiscal desligado neste computador',
  no_printer: 'Cupom fiscal: escolha a impressora deste computador em Configurações',
  paper: 'Cupom fiscal de 80 mm, mas este computador imprime em 58 mm (configure a bobina no painel)',
};

/**
 * ESTE computador pode imprimir o cupom? Conferido ANTES do CAS: se não pode, o job fica
 * `pending` para o outro PC da loja (ou para o plano B do painel). Devolve o bloqueio, ou `null`.
 */
export function fiscalPrintBlocker(content: FiscalPrintJobContent, pc: FiscalPcState): FiscalPrintBlock | null {
  if (pc.fiscalPrintHere === undefined) return 'not_chosen';
  if (pc.fiscalPrintHere !== true) return 'off';
  if (!pc.printerName || !pc.printerName.trim()) return 'no_printer';
  // Cupom de 80 mm numa bobina de 58 mm sairia cortado à direita (o valor, a chave).
  if (content.paperWidth > pc.paperWidth) return 'paper';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Máquina de estados da fila (PURA: o banco e a impressora entram pelas portas)
// ---------------------------------------------------------------------------------------------

/** Resposta de uma porta: deu certo (com o valor) ou não (401 = sessão vencida, relogin). */
export type FiscalPortResult<T> = { ok: true; value: T } | { ok: false; unauthorized?: boolean };

/** Uma linha da fila como a leitura devolve. */
export interface FiscalJobRow {
  id?: unknown;
  status?: unknown;
  created_at?: unknown;
  content?: unknown;
}

/** Desfecho de um job que este PC pegou. `finishedAt` é a hora do SERVIDOR do desfecho. */
export interface FiscalOutcome {
  jobId: string;
  status: 'printed' | 'failed';
  error: string | null;
  finishedAt: string;
}

/** Desfecho que o PAPEL já resolveu e o banco ainda não gravou (vai para o disco). */
export interface PendingFiscalOutcome extends FiscalOutcome {
  attempts: number;
}

/**
 * As portas. TODO horário gravado no banco vem da máquina de estados, já na hora do SERVIDOR
 * (`claimedAt`, `finishedAt`): o painel compara `claimed_at` com a hora dele (60 s do job preso),
 * e o relógio do PC pode estar minutos errado.
 */
export interface FiscalQueuePorts {
  /** `pending` da loja com `created_at >= sinceIso`, os mais velhos primeiro. */
  list(sinceIso: string): Promise<FiscalPortResult<FiscalJobRow[]>>;
  /** CAS `pending -> printing` + `device_id` + `claimed_at`; `true` = este PC pegou. */
  claim(jobId: string, claimedAt: string): Promise<FiscalPortResult<boolean>>;
  /** Releitura por `id` + `device_id`: o status do job se ele é DESTE PC, `null` se não é. */
  readOwn(jobId: string): Promise<FiscalPortResult<string | null>>;
  /** CAS `pending -> failed` com `error = 'expirado'` e `finished_at`. */
  expire(jobId: string, finishedAt: string): Promise<FiscalPortResult<void>>;
  /** Grava o desfecho (só vale para `printing` deste PC). */
  finish(outcome: FiscalOutcome): Promise<FiscalPortResult<void>>;
  /** Imprime UMA via (layout raster, corte próprio). Lança na falha. */
  printVia(printerName: string, layout: string, width: FiscalPrintPaperWidth): Promise<void>;
}

export type FiscalJobResult =
  /** Não é para este PC agora. `block` = o que o lojista precisa resolver (aviso no app). */
  | { kind: 'skipped'; jobId: string; reason: string; block?: FiscalPrintBlock }
  /** Velho demais: encerrado como `failed` "expirado" (`recorded` = a gravação deu certo). */
  | { kind: 'expired'; jobId: string; recorded: boolean }
  /** Perdeu o CAS: o painel cancelou ou outro PC pegou. Nada sai. */
  | { kind: 'lost'; jobId: string }
  /** Erro no CAS e a releitura não mostrou o job como deste PC: desiste (o painel cobre). */
  | { kind: 'claim_unknown'; jobId: string }
  | { kind: 'unauthorized'; jobId: string }
  /** Este PC imprimiu (ou tentou). `pending` = o desfecho não gravou e vai para o disco. */
  | { kind: 'done'; jobId: string; outcome: FiscalOutcome; printedVias: number; pending: PendingFiscalOutcome | null };

function errorText(err: unknown): string {
  const message = err && typeof err === 'object' && 'message' in err ? (err as { message?: unknown }).message : err;
  return String(message ?? 'erro').slice(0, 300);
}

/**
 * UM job, do começo ao fim: idade (hora do servidor) → conferência → este PC pode? → CAS (com
 * releitura se o CAS errar) → uma impressão por via → desfecho. Nunca imprime sem ganhar o CAS
 * (ou sem a releitura provar que o job é deste PC), e nunca imprime de novo. `serverNow` é
 * relido a cada passo (imprimir leva tempo): os horários gravados são os do servidor.
 */
export async function runFiscalPrintJob(
  job: FiscalJobRow,
  ctx: {
    serverNow: () => number | null;
    pc: FiscalPcState;
    /** Chamado com o desfecho ANTES de gravá-lo no banco (o app o põe no disco antes). */
    beforeFinish?: (outcome: FiscalOutcome) => void;
  },
  ports: FiscalQueuePorts,
): Promise<FiscalJobResult> {
  const jobId = typeof job?.id === 'string' ? job.id : '';
  if (!jobId) return { kind: 'skipped', jobId, reason: 'job sem id' };
  if (job.status !== 'pending') return { kind: 'skipped', jobId, reason: 'job não está pendente' };
  const startedAt = ctx.serverNow();
  if (startedAt === null) return { kind: 'skipped', jobId, reason: 'sem a hora do servidor' };
  const serverIso = () => new Date(ctx.serverNow() ?? startedAt).toISOString();

  if (isFiscalPrintJobExpired(job.created_at, startedAt)) {
    const expired = await ports.expire(jobId, serverIso());
    if (!expired.ok && expired.unauthorized) return { kind: 'unauthorized', jobId };
    return { kind: 'expired', jobId, recorded: expired.ok };
  }

  // ESTE PC PODE? Antes do CAS: versão que este app não entende pode ser de um app mais novo
  // (outro PC imprime), e sem impressora/bobina certa o job fica para o outro computador.
  const content = parseFiscalPrintJobContent(job.content);
  if (!content) return { kind: 'skipped', jobId, reason: 'conteúdo fora do contrato deste app' };
  const block = fiscalPrintBlocker(content, ctx.pc);
  if (block) return { kind: 'skipped', jobId, reason: FISCAL_BLOCK_NOTICES[block], block };
  const layouts = buildFiscalRasterLayouts(content);
  if (!layouts) return { kind: 'skipped', jobId, reason: 'QR Code ilegível' };
  const printerName = String(ctx.pc.printerName);

  const claim = await ports.claim(jobId, serverIso());
  if (!claim.ok) {
    if (claim.unauthorized) return { kind: 'unauthorized', jobId };
    // A RESPOSTA do CAS pode ter se perdido com o UPDATE aplicado: relê por id + device_id.
    // Só um `printing` DESTE PC autoriza imprimir; o resto desiste (o painel cobre no prazo).
    const own = await ports.readOwn(jobId);
    if (!own.ok || own.value !== 'printing') return { kind: 'claim_unknown', jobId };
  } else if (!claim.value) {
    return { kind: 'lost', jobId };
  }

  let printedVias = 0;
  let failure: string | null = null;
  for (const layout of layouts) {
    try {
      await ports.printVia(printerName, layout, content.paperWidth);
      printedVias += 1;
    } catch (err) {
      failure = errorText(err);
      break;
    }
  }
  const finishedAt = serverIso();
  const outcome: FiscalOutcome =
    printedVias === layouts.length
      ? { jobId, status: 'printed', error: null, finishedAt }
      : printedVias === 0
        ? { jobId, status: 'failed', error: failure, finishedAt }
        : // A via do consumidor saiu e a do estabelecimento não: o cupom do cliente EXISTE, então
          // não é `failed` (o painel ofereceria o cupom inteiro de novo); só a 2ª via falta.
          { jobId, status: 'printed', error: FISCAL_PRINT_VIA2_FAILED, finishedAt };
  ctx.beforeFinish?.(outcome);
  const saved = await ports.finish(outcome);
  return { kind: 'done', jobId, outcome, printedVias, pending: saved.ok ? null : { ...outcome, attempts: 1 } };
}

/**
 * Regrava os desfechos pendentes (o papel JÁ saiu ou já falhou): nunca imprime nada. Devolve o
 * que continua pendente. Desiste de um desfecho depois de `FISCAL_OUTCOME_MAX_RETRIES` voltas.
 */
export async function flushFiscalOutcomes(
  pending: PendingFiscalOutcome[],
  ports: Pick<FiscalQueuePorts, 'finish'>,
): Promise<{ remaining: PendingFiscalOutcome[]; unauthorized: boolean }> {
  const remaining: PendingFiscalOutcome[] = [];
  let unauthorized = false;
  for (const item of pending) {
    const saved = await ports.finish({ jobId: item.jobId, status: item.status, error: item.error, finishedAt: item.finishedAt });
    if (saved.ok) continue;
    if (saved.unauthorized) unauthorized = true;
    const attempts = item.attempts + 1;
    if (attempts <= FISCAL_OUTCOME_MAX_RETRIES) remaining.push({ ...item, attempts });
  }
  return { remaining, unauthorized };
}

export interface FiscalRoundInput {
  /** A hora do servidor agora (relida a cada passo: imprimir leva tempo). `null` = sem medida. */
  serverNow: () => number | null;
  /** A nota ligada na loja E o cupom escolhido para este PC: só então a fila é LIDA. */
  polling: boolean;
  pc: FiscalPcState;
  /** Desfechos pendentes lidos do disco. */
  outcomes: PendingFiscalOutcome[];
  /** Jobs já resolvidos nesta sessão (rede de segurança contra releitura atrasada). */
  seen: Set<string>;
  /**
   * Grava os pendentes em DISCO — chamada depois de regravar e A CADA JOB (antes e depois do
   * desfecho ir ao banco): o app pode ser fechado no meio da volta, e o desfecho do papel que já
   * saiu não pode ficar só na memória.
   */
  persist: (outcomes: PendingFiscalOutcome[]) => void;
}

export interface FiscalRoundResult {
  /** A volta não teve erro: a próxima é a normal (10 s). */
  ok: boolean;
  unauthorized: boolean;
  /** Falta medir a hora do servidor (`checkClock`). */
  needsClock: boolean;
  /** Desfechos ainda pendentes (já gravados em disco por `persist`). */
  outcomes: PendingFiscalOutcome[];
  jobs: FiscalJobResult[];
}

/**
 * UMA volta da fila: primeiro regrava os desfechos pendentes (com ou sem a opção do PC); depois,
 * só com `polling`, lê os `pending` dos últimos 90 s (hora do servidor) e processa um a um.
 */
export async function runFiscalQueueRound(input: FiscalRoundInput, ports: FiscalQueuePorts): Promise<FiscalRoundResult> {
  const flushed = await flushFiscalOutcomes(input.outcomes, ports);
  const outcomes = flushed.remaining;
  input.persist(outcomes);
  let unauthorized = flushed.unauthorized;
  const jobs: FiscalJobResult[] = [];
  if (!input.polling) return { ok: !unauthorized, unauthorized, needsClock: false, outcomes, jobs };

  const listedAt = input.serverNow();
  if (listedAt === null) return { ok: false, unauthorized, needsClock: true, outcomes, jobs };
  const listed = await ports.list(new Date(listedAt - FISCAL_PRINT_JOB_MAX_AGE_MS).toISOString());
  if (!listed.ok) return { ok: false, unauthorized: unauthorized || listed.unauthorized === true, needsClock: false, outcomes, jobs };

  for (const job of listed.value) {
    const jobId = typeof job?.id === 'string' ? job.id : '';
    if (jobId && input.seen.has(jobId)) continue;
    // O desfecho vai ao DISCO antes de ir ao banco (o app pode morrer entre os dois) e sai de lá
    // quando o banco confirma: o papel que já saiu nunca fica só na memória.
    const result = await runFiscalPrintJob(
      job,
      {
        serverNow: input.serverNow,
        pc: input.pc,
        beforeFinish: (outcome) => {
          outcomes.push({ ...outcome, attempts: 0 });
          input.persist(outcomes);
        },
      },
      ports,
    );
    jobs.push(result);
    if (result.kind === 'unauthorized') {
      unauthorized = true;
      break;
    }
    if (result.kind === 'done' || (result.kind === 'expired' && result.recorded)) input.seen.add(jobId);
    if (result.kind === 'done') {
      const at = outcomes.findIndex((item) => item.jobId === jobId);
      if (at !== -1) {
        if (result.pending) outcomes[at] = result.pending;
        else outcomes.splice(at, 1);
        input.persist(outcomes);
      }
    }
  }
  return { ok: !unauthorized, unauthorized, needsClock: false, outcomes, jobs };
}

/**
 * Trava de "volta em curso": UMA volta da fila por vez neste app, mesmo quando o efeito reinicia
 * (troca de loja, novo login) com a volta anterior ainda imprimindo.
 */
export function createFiscalRoundGate(): { tryEnter(): boolean; leave(): void; busy(): boolean } {
  let running = false;
  return {
    tryEnter() {
      if (running) return false;
      running = true;
      return true;
    },
    leave() {
      running = false;
    },
    busy() {
      return running;
    },
  };
}

/** Desfechos pendentes guardados em disco (JSON) → lista conferida. Ilegível = lista vazia. */
export function parseStoredFiscalOutcomes(raw: string | null | undefined): PendingFiscalOutcome[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingFiscalOutcome =>
        !!item &&
        typeof item.jobId === 'string' &&
        !!item.jobId &&
        (item.status === 'printed' || item.status === 'failed') &&
        (item.error === null || typeof item.error === 'string') &&
        typeof item.finishedAt === 'string' &&
        typeof item.attempts === 'number' &&
        Number.isFinite(item.attempts),
    );
  } catch {
    return [];
  }
}

/**
 * Matriz do QR (uma string de '0'/'1' por linha) para o bloco `qr` do Rust. Nível M, modo Byte
 * e `trim` do payload — o MESMO tratamento do QR do navegador (`buildPixQrCodeShape`, no
 * monorepo), com teste de igualdade das matrizes. Só ASCII imprimível: a biblioteca mutilaria
 * em silêncio qualquer outro caractere (ela usa só o byte baixo). `null` = não dá para
 * desenhar → o cupom não sai. Nunca lança.
 */
export function fiscalQrModules(payload: string): string[] | null {
  const data = typeof payload === 'string' ? payload.trim() : '';
  if (!data || !/^[\x20-\x7e]+$/.test(data)) return null;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(data, 'Byte');
    qr.make();
    const size = qr.getModuleCount();
    const rows: string[] = [];
    for (let row = 0; row < size; row += 1) {
      let modules = '';
      for (let col = 0; col < size; col += 1) modules += qr.isDark(row, col) ? '1' : '0';
      rows.push(modules);
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Um bloco do modo gráfico do CUPOM. ESPELHA `Block::Mono`/`Rule`/`Qr` de receipt_raster.rs: os
 * NOMES dos campos são os do serde de lá (trava `desktop-fiscal-print.test.ts`).
 */
export type FiscalRasterBlock =
  | { kind: 'mono'; text: string; align: FiscalPrintAlign; strong: boolean; tall: boolean }
  | { kind: 'rule' }
  | { kind: 'qr'; modules: string[]; align: FiscalPrintAlign };

/**
 * As linhas de UMA via → o layout (JSON) que `print_fiscal_receipt` desenha. O destaque vira
 * negrito + altura dupla (como a comanda: só a ALTURA dobra, as colunas ficam). `null` quando o
 * QR não pode ser desenhado: nesse caso o cupom não sai.
 */
export function buildFiscalRasterLayout(lines: FiscalPrintLine[]): string | null {
  const blocks: FiscalRasterBlock[] = [];
  for (const line of lines) {
    if (line.type === 'separator') {
      blocks.push({ kind: 'rule' });
    } else if (line.type === 'qr') {
      const modules = fiscalQrModules(line.payload);
      if (!modules) return null;
      blocks.push({ kind: 'qr', modules, align: line.align ?? 'center' });
    } else {
      const emphasis = line.emphasis === true;
      blocks.push({ kind: 'mono', text: line.text, align: line.align ?? 'left', strong: emphasis, tall: emphasis });
    }
  }
  return JSON.stringify({ blocks });
}

/** Um layout por via, na ordem; `null` se alguma via não puder ser desenhada (nada sai). */
export function buildFiscalRasterLayouts(content: FiscalPrintJobContent): string[] | null {
  const layouts: string[] = [];
  for (const via of content.vias) {
    const layout = buildFiscalRasterLayout(via.lines);
    if (!layout) return null;
    layouts.push(layout);
  }
  return layouts;
}
