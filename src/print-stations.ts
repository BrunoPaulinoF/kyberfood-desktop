/**
 * IMPRESSORAS POR SETOR — pizza numa impressora, cozinha em outra, bebidas em outra.
 *
 * O QUE É. O lojista cadastra impressoras com NOME no painel (Integrações → Configurar
 * impressão) e diz o que cada uma imprime: SÓ OS ITENS das categorias dela (via de produção,
 * enxuta) ou o PEDIDO COMPLETO. No app, em cada computador, ele liga cada cadastro a uma
 * impressora do Windows. A impressora do CAIXA é a de sempre (`selectedPrinter`): ela é
 * obrigatória e continua imprimindo a comanda completa de todo pedido.
 *
 * A TRAVA ANTI-REGRESSÃO É A LISTA VAZIA. Loja sem cadastro (`stations` ausente, ilegível ou
 * `[]`) não passa por NENHUMA linha nova de impressão: a comanda do caixa sai exatamente como
 * sempre saiu. E o que é novo só ACRESCENTA papel — nada daqui tira item, via ou comanda da
 * impressora do caixa.
 *
 * O MODO DE FALHAR É SEMPRE "SAIU NO CAIXA", nunca "não saiu":
 *  - item sem categoria conhecida (iFood, Goomer, produto apagado) fica só na comanda do caixa;
 *  - impressora do setor sem resposta por `STATION_FALLBACK_AFTER_MS` → a via dela sai na
 *    impressora do caixa, com o aviso no topo de que a impressora está fora.
 *
 * AS OBSERVAÇÕES NUNCA FICAM DE FORA da via do setor, e não dependem das chaves "Informações
 * na comanda" (que são do papel do caixa): a do ITEM sai colada no item, a do PEDIDO sai em
 * TODAS as vias — não há como saber a qual setor ela se refere.
 *
 * ESTE ARQUIVO EXISTE DUAS VEZES, IGUAL BYTE A BYTE: `src/lib/print-stations.ts` (site) e
 * `kyberfood-desktop/src/print-stations.ts` (app). São projetos separados, sem import entre
 * eles, e por isso ele NÃO IMPORTA NADA: o que depende de cada projeto (limpeza de texto,
 * rótulo do tamanho, sabor de pizza) entra por `StationTicketDeps`. Mudou um, copie no outro.
 * Trava: src/lib/print-stations.test.ts.
 */

/** Teto de impressoras cadastradas por loja (além da do caixa). */
export const MAX_PRINT_STATIONS = 8;

/** Tamanho máximo do nome (cabe em destaque no papel de 58mm). */
export const PRINT_STATION_NAME_MAX = 24;

/** Teto de categorias por impressora — rede contra um jsonb estranho, não regra de negócio. */
export const MAX_STATION_CATEGORIES = 300;

/**
 * Quanto tempo o app insiste na impressora do setor antes de mandar a via para a do caixa.
 * Um minuto cobre a troca de bobina; mais que isso o pedido esfria sem ninguém saber.
 */
export const STATION_FALLBACK_AFTER_MS = 60_000;

export interface PrintStation {
  /** Identificador estável do cadastro: é por ele que cada computador guarda a impressora. */
  id: string;
  /** Nome que o lojista deu ("Pizza", "Cozinha", "Copa"). Sai no topo da via. */
  name: string;
  /**
   * `true` = esta impressora recebe o PEDIDO COMPLETO de todo pedido (igual à do caixa).
   * Ausente/`false` = só os itens das categorias dela. Só o `true` explícito liga.
   */
  fullReceipt: boolean;
  /** Categorias do cardápio que saem nesta impressora (ignorado com `fullReceipt`). */
  categoryIds: string[];
}

const STATION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CATEGORY_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Nome como vai para o papel: sem caractere de controle, sem espaço sobrando, no tamanho. */
export function cleanStationName(value: unknown): string {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += isControl ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, PRINT_STATION_NAME_MAX).trim();
}

/**
 * Lê a lista de impressoras do jsonb. Qualquer coisa ilegível vira "sem impressoras" — que é
 * o comportamento de sempre —, nunca erro: esta leitura está no caminho de TODA comanda.
 *
 * Uma categoria pertence a UMA impressora só (a primeira que a citar): duas vias do mesmo
 * item em setores diferentes fariam a pizza ser produzida duas vezes.
 */
export function normalizePrintStations(value: unknown): PrintStation[] {
  if (!Array.isArray(value)) return [];
  const stations: PrintStation[] = [];
  const usedIds = new Set<string>();
  const usedCategories = new Set<string>();
  for (const entry of value) {
    if (stations.length >= MAX_PRINT_STATIONS) break;
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!STATION_ID_RE.test(id) || usedIds.has(id)) continue;
    const name = cleanStationName(raw.name);
    if (!name) continue;
    const fullReceipt = raw.fullReceipt === true;
    const categoryIds: string[] = [];
    if (!fullReceipt && Array.isArray(raw.categoryIds)) {
      for (const categoryId of raw.categoryIds) {
        if (categoryIds.length >= MAX_STATION_CATEGORIES) break;
        if (typeof categoryId !== 'string' || !CATEGORY_ID_RE.test(categoryId)) continue;
        if (usedCategories.has(categoryId)) continue;
        usedCategories.add(categoryId);
        categoryIds.push(categoryId);
      }
    }
    usedIds.add(id);
    stations.push({ id, name, fullReceipt, categoryIds });
  }
  return stations;
}

/** A impressora (de itens) que recebe esta categoria, ou `null` = só na comanda do caixa. */
export function stationForCategory(stations: PrintStation[], categoryId: unknown): PrintStation | null {
  if (typeof categoryId !== 'string' || !categoryId) return null;
  for (const station of stations) {
    if (!station.fullReceipt && station.categoryIds.includes(categoryId)) return station;
  }
  return null;
}

/** Os produtos do pedido cuja categoria precisa ser conhecida (sem repetição). */
export function stationProductIds(items: Array<{ product_id?: unknown }> | null | undefined): string[] {
  const ids = new Set<string>();
  for (const item of items || []) {
    if (typeof item?.product_id === 'string' && item.product_id) ids.add(item.product_id);
  }
  return Array.from(ids);
}

/**
 * Separa os itens do pedido pelas impressoras de ITENS. Mantém a ordem das impressoras do
 * cadastro e a ordem dos itens do pedido; impressora sem item no pedido não entra.
 *
 * Item sem produto (iFood, Goomer) ou de categoria que nenhuma impressora pegou não aparece
 * em grupo nenhum: ele está na comanda completa do caixa, que não muda.
 */
export function splitItemsByStation<T extends { product_id?: unknown }>(
  items: T[] | null | undefined,
  categoryOfProduct: (productId: string) => string | null | undefined,
  stations: PrintStation[],
): Array<{ station: PrintStation; items: T[] }> {
  const byStation = new Map<string, T[]>();
  for (const item of items || []) {
    const productId = typeof item?.product_id === 'string' ? item.product_id : '';
    if (!productId) continue;
    const station = stationForCategory(stations, categoryOfProduct(productId));
    if (!station) continue;
    const list = byStation.get(station.id);
    if (list) list.push(item);
    else byStation.set(station.id, [item]);
  }
  const groups: Array<{ station: PrintStation; items: T[] }> = [];
  for (const station of stations) {
    const list = byStation.get(station.id);
    if (list && list.length > 0) groups.push({ station, items: list });
  }
  return groups;
}

/**
 * A impressora do Windows que ESTE computador ligou ao cadastro.
 *
 *  - `unset`: ninguém escolheu ainda neste computador → não imprime a via e o app AVISA.
 *  - `off`: escolheu "não imprimir neste computador" (loja com dois PCs) → silêncio.
 *  - `printer`: imprime nela.
 *
 * Nos dois primeiros nada se perde: os itens continuam na comanda completa do caixa.
 */
export type StationPrinterChoice =
  | { state: 'unset' }
  | { state: 'off' }
  | { state: 'printer'; printerName: string };

export function stationPrinterChoice(mapping: unknown, stationId: string): StationPrinterChoice {
  if (!mapping || typeof mapping !== 'object') return { state: 'unset' };
  const value = (mapping as Record<string, unknown>)[stationId];
  if (typeof value !== 'string') return { state: 'unset' };
  const printerName = value.trim();
  return printerName ? { state: 'printer', printerName } : { state: 'off' };
}

/**
 * Para onde vai a via AGORA: a impressora do setor ou, depois de `STATION_FALLBACK_AFTER_MS`
 * de falha seguida, a do caixa. Relógio que andou para trás não antecipa o plano B.
 */
export function stationPrintTarget(firstFailureAt: number | null | undefined, now: number): 'station' | 'cashier' {
  if (typeof firstFailureAt !== 'number' || !Number.isFinite(firstFailureAt)) return 'station';
  return now - firstFailureAt >= STATION_FALLBACK_AFTER_MS ? 'cashier' : 'station';
}

/** Um bloco do documento. MESMO formato de `ReceiptBlock` (site e app) e do raster em Rust. */
export type StationBlock =
  | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; strong?: boolean; big?: boolean; huge?: boolean; indent?: number }
  | { kind: 'row'; left: string; right: string; strong?: boolean; indent?: number }
  | { kind: 'rule'; double?: boolean }
  | { kind: 'space' };

/**
 * Aviso no topo da via que saiu no CAIXA porque a impressora do setor não respondeu. Diz o
 * que aconteceu e o que fazer com o papel — quem está no caixa não é quem produz.
 */
export function stationOutageBlocks(stationName: string): StationBlock[] {
  const name = cleanStationName(stationName).toUpperCase();
  return [
    { kind: 'text', text: `*** IMPRESSORA ${name} FORA ***`, align: 'center', strong: true, big: true },
    { kind: 'text', text: `LEVAR ESTA VIA PARA: ${name}`, align: 'center', strong: true },
    { kind: 'rule', double: true },
  ];
}

export interface StationTicketItem {
  quantity?: unknown;
  product_name?: unknown;
  size_name?: string | null;
  notes?: unknown;
  complements?: Array<{ name?: string; groupName?: string | null }> | null;
}

export interface StationTicketInput {
  stationName: string;
  /** "*** ENTREGA ***" / "*** RETIRADA ***" / "*** MESA 12 ***" — o mesmo do topo da comanda. */
  typeLabel: string;
  /** "PEDIDO #123". */
  orderLabel: string;
  /** Data e hora do pedido, já formatada. */
  dateTimeText?: string | null;
  /** Hora marcada do pedido agendado, já formatada (ou vazio). */
  scheduledText?: string | null;
  customerName: string;
  items: StationTicketItem[];
  /** Observação do PEDIDO: sai em todas as vias. */
  orderNotes?: unknown;
  /** A via está saindo no caixa porque a impressora do setor não respondeu. */
  outage?: boolean;
}

/** O que vem de cada projeto (site/app): os MESMOS ajudantes e rótulos da comanda do caixa. */
export interface StationTicketDeps {
  clean: (value: unknown) => string;
  sizeLabel: (raw?: string | null) => string | null;
  isFlavorComplement: (comp: { groupName?: string | null }) => boolean;
  scheduledLabel: string;
  orderNotesLabel: string;
  itemNotePrefix: string;
}

/**
 * A VIA DO SETOR: só o que quem PRODUZ precisa — setor, tipo do pedido, número, cliente, os
 * itens daquele setor com sabores/adicionais e as observações. Sem preço, endereço, telefone
 * e pagamento (isso é da comanda completa do caixa).
 */
export function buildStationTicketLayout(input: StationTicketInput, deps: StationTicketDeps): StationBlock[] {
  const blocks: StationBlock[] = [];
  if (input.outage) blocks.push(...stationOutageBlocks(input.stationName));
  blocks.push({ kind: 'text', text: cleanStationName(input.stationName).toUpperCase(), align: 'center', strong: true, big: true });
  blocks.push({ kind: 'rule', double: true });
  blocks.push({ kind: 'text', text: input.typeLabel, align: 'center', strong: true, big: true });
  if (input.scheduledText) {
    blocks.push({ kind: 'rule', double: true });
    blocks.push({ kind: 'text', text: deps.scheduledLabel, align: 'center', strong: true, big: true, huge: true });
    blocks.push({ kind: 'text', text: String(input.scheduledText), align: 'center', strong: true, big: true, huge: true });
  }
  blocks.push({ kind: 'rule', double: true });
  if (input.dateTimeText) blocks.push({ kind: 'row', left: input.orderLabel, right: String(input.dateTimeText), strong: true });
  else blocks.push({ kind: 'text', text: input.orderLabel, strong: true });
  blocks.push({ kind: 'text', text: `CLIENTE: ${input.customerName}` });
  blocks.push({ kind: 'rule' });

  input.items.forEach((item, index) => {
    if (index > 0) blocks.push({ kind: 'space' });
    const size = deps.sizeLabel(item.size_name);
    const quantity = Number(item.quantity) || 1;
    blocks.push({
      kind: 'text',
      text: `${quantity}x ${String(item.product_name || '').toUpperCase()}${size ? ` (${size})` : ''}`,
      strong: true,
    });
    const complements = Array.isArray(item.complements) ? item.complements : [];
    const flavorCount = complements.filter((comp) => comp && deps.isFlavorComplement(comp)).length;
    for (const comp of complements) {
      const name = String(comp?.name || '').trim().toUpperCase();
      if (!name) continue;
      if (deps.isFlavorComplement(comp)) {
        blocks.push({ kind: 'text', text: `- ${flavorCount >= 2 ? `1/${flavorCount} ` : ''}${name}`, indent: 1 });
      } else {
        blocks.push({ kind: 'text', text: `+ ${name}`, indent: 1 });
      }
    }
    const notes = String(item.notes ?? '').trim();
    if (notes) blocks.push({ kind: 'text', text: `${deps.itemNotePrefix.trim()} ${notes}`, indent: 1, strong: true });
  });

  const orderNotes = String(input.orderNotes ?? '').trim();
  if (orderNotes) {
    blocks.push({ kind: 'rule' });
    blocks.push({ kind: 'text', text: deps.orderNotesLabel, strong: true });
    blocks.push({ kind: 'text', text: orderNotes, strong: true });
  }
  blocks.push({ kind: 'rule', double: true });

  // TRAVA ANTI-FORJA, a mesma da comanda: nenhum texto do pedido cria linha nova nem destaque.
  return blocks.map((block) => {
    if (block.kind === 'text') return { ...block, text: deps.clean(block.text) };
    if (block.kind === 'row') return { ...block, left: deps.clean(block.left), right: deps.clean(block.right) };
    return block;
  });
}
