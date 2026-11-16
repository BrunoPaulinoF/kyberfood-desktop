/**
 * Cofre da SESSÃO do Supabase guardada neste PC (access token + refresh token).
 *
 * O QUE MUDOU: o supabase-js gravava a sessão em claro no `localStorage`
 * (`kyberfood.desktop.auth`). O refresh token sozinho dá acesso à conta, então quem copiasse
 * a pasta do app entrava na loja. Agora o cliente do Supabase recebe este adaptador como
 * `auth.storage`, e o que vai ao disco é o texto CIFRADO pela DPAPI do Windows — os mesmos
 * `protect_secret`/`unprotect_secret` da senha (`credential-vault.ts`, `win_secret.rs`).
 * A sessão em claro só existe na MEMÓRIA deste processo.
 *
 * A REGRA QUE MANDA AQUI VEM ANTES DA CIFRA: a loja não pode ser deslogada nem ter de
 * digitar a senha por causa disto. Cada caminho falha para o lado de continuar conectado:
 *
 *   - LEITURA de valor em claro (versão anterior do app): vale na hora, sem esperar nada. A
 *     troca pelo cifrado roda depois, em segundo plano, e só grava depois de cifrar, decifrar
 *     de volta e conferir que voltou IGUAL. Qualquer falha deixa o claro onde está.
 *   - LEITURA de valor cifrado: espera a decifragem de verdade (leva milissegundos), com
 *     novas tentativas e teto. Se mesmo assim não abrir, devolve "sem sessão" — o piso que o
 *     app já tem: ele refaz o login sozinho com a credencial do cofre. O valor que não abriu
 *     NÃO é apagado: o cofre continua tentando em segundo plano e, quando abre, avisa o app
 *     (`onSessionUnlockedLate`), que volta a ficar conectado sem ninguém digitar nada.
 *   - ESCRITA (login e renovação do token, ~1x por hora): a sessão nova vale na hora, em
 *     memória. Vai ao disco cifrada; se a cifra falhar ou estourar o teto, vai em claro — o
 *     comportamento de antes. A sessão nova nunca se perde.
 *   - ESCRITAS CONCORRENTES: o refresh token é de USO ÚNICO. Um valor antigo gravado por cima
 *     de um novo é uma sessão morta na próxima renovação. Por isso cada chave tem um contador
 *     (`versions`): só a escrita MAIS NOVA chega ao disco; a que perdeu a vez desiste sem
 *     gravar, inclusive o plano B em claro e a migração.
 *   - REMOÇÃO (`removeItem`: o botão Sair, ou o servidor recusou a renovação): apaga na hora
 *     e invalida qualquer escrita ainda no ar — a sessão removida não volta.
 *
 * A reserva em arquivo (`device-state.json`) NÃO guarda a sessão, e continua não guardando.
 *
 * Trava: `src/lib/desktop-session-vault.test.ts`, no monorepo (executa este fonte).
 */
import { invoke } from '@tauri-apps/api/tauri';
import { SEALED_PREFIX } from './credential-vault';

/** Teto de cada chamada à cifra do Windows. Estourou: conta como falha, nunca fica pendurado. */
const CIPHER_TIMEOUT_MS = 4_000;
/**
 * Esperas ANTES de cada nova tentativa de abrir, dentro da própria leitura. A primeira é
 * imediata. Com a cifra respondendo erro na hora, a leitura inteira demora ~1,6s; com a
 * cifra pendurada, no máximo 3 x 4s + 1,6s. Depois disso a leitura devolve "sem sessão".
 */
const OPEN_RETRY_DELAYS_MS = [400, 1_200];
/** Novas tentativas em segundo plano para o valor que não abriu: espaça, nunca desiste. */
const LOCKED_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];

/** Sessão já decifrada, só em memória. Vale enquanto o `localStorage` tiver o MESMO valor. */
const unlocked = new Map<string, { raw: string; value: string }>();
/** Sessão recém-recebida que ainda está indo ao disco. A leitura olha aqui primeiro. */
const pending = new Map<string, string>();
/** Contador por chave: a escrita (ou remoção) mais nova invalida a que ainda estava no ar. */
const versions = new Map<string, number>();
/** Decifragem em andamento, por chave: leituras simultâneas esperam a MESMA chamada. */
const opening = new Map<string, { raw: string; work: Promise<string | null> }>();
/** Valor cifrado que não abriu: guardado como está, com nova tentativa agendada. */
const locked = new Map<string, { raw: string; attempt: number; timer: ReturnType<typeof setTimeout> | null }>();
/** Último valor em claro cuja troca pelo cifrado já foi tentada (uma tentativa por valor). */
const migrationTried = new Map<string, string>();
const lateUnlockListeners = new Set<() => void>();

function isSealed(raw: string): boolean {
  return raw.startsWith(SEALED_PREFIX);
}

function currentVersion(key: string): number {
  return versions.get(key) ?? 0;
}

function bumpVersion(key: string): number {
  const next = currentVersion(key) + 1;
  versions.set(key, next);
  return next;
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tempo esgotado')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** `async` de propósito: um `invoke` que estoura na hora (fora do Tauri) vira rejeição. */
async function unprotect(raw: string): Promise<string> {
  const plain = await invoke<string>('unprotect_secret', { blob: raw.slice(SEALED_PREFIX.length) });
  if (typeof plain !== 'string' || plain.length === 0) throw new Error('decifragem devolveu vazio');
  return plain;
}

function clearLocked(key: string): void {
  const entry = locked.get(key);
  if (entry?.timer) clearTimeout(entry.timer);
  locked.delete(key);
}

/**
 * Cifra, CONFERE e só então grava no `localStorage`.
 *
 * A ordem é a trava: (1) cifra; (2) decifra o que acabou de cifrar; (3) confere que voltou
 * IGUAL; (4) grava; (5) lê de volta. Só o passo 4 mexe no que estava guardado.
 *
 * Devolve `false` SEM gravar quando uma escrita mais nova (ou a remoção) passou na frente,
 * ou — na migração — quando o valor guardado já não é mais o que estava sendo migrado.
 */
async function sealIntoStorage(
  key: string,
  value: string,
  version: number,
  previousRaw: string | null,
): Promise<boolean> {
  const blob = await invoke<string>('protect_secret', { plain: value });
  if (typeof blob !== 'string' || blob.length === 0) throw new Error('cifra devolveu vazio');
  const back = await invoke<string>('unprotect_secret', { blob });
  if (back !== value) throw new Error('o texto decifrado nao confere com o original');

  if (currentVersion(key) !== version) return false;
  if (previousRaw !== null && localStorage.getItem(key) !== previousRaw) return false;

  const raw = SEALED_PREFIX + blob;
  const before = localStorage.getItem(key);
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) {
    // Só a migração tem um valor anterior BOM para devolver; numa escrita nova, quem chama
    // cai no plano B e grava a sessão nova em claro.
    if (previousRaw !== null && before !== null) localStorage.setItem(key, before);
    throw new Error('o valor cifrado nao foi gravado como esperado');
  }
  unlocked.set(key, { raw, value });
  return true;
}

/** Leva a sessão nova ao disco: cifrada se der, em claro se não der. Nunca lança. */
async function persist(key: string, value: string, version: number): Promise<void> {
  let sealed = false;
  try {
    sealed = await withTimeout(sealIntoStorage(key, value, version, null), CIPHER_TIMEOUT_MS * 2);
  } catch (err) {
    console.warn('Nao consegui cifrar a sessao; guardo em claro, como antes:', err);
  }
  // Uma escrita mais nova (ou a remoção) passou na frente: esta NÃO grava nada.
  if (currentVersion(key) !== version) return;

  if (!sealed) {
    try {
      // A cifra falhou: comportamento de antes. Conectado vem antes de cifrado.
      localStorage.setItem(key, value);
      migrationTried.set(key, value);
    } catch {
      // Sem storage nenhum: a sessão fica só na memória (`pending`) até o app fechar.
      return;
    }
  }
  pending.delete(key);
}

/** Troca o valor em claro pelo cifrado, em segundo plano. Falhou: fica como está. */
function migrateLater(key: string, raw: string): void {
  if (migrationTried.get(key) === raw) return;
  migrationTried.set(key, raw);
  const version = currentVersion(key);
  void withTimeout(sealIntoStorage(key, raw, version, raw), CIPHER_TIMEOUT_MS * 2).catch((err) => {
    console.warn('Nao consegui cifrar a sessao guardada; ela continua valendo como esta:', err);
  });
}

/** Abre um valor cifrado, com novas tentativas. `null` = não abriu (o valor fica guardado). */
async function openWithRetries(raw: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTimeout(unprotect(raw), CIPHER_TIMEOUT_MS);
    } catch (err) {
      console.warn('Nao consegui abrir a sessao guardada:', err);
    }
    if (attempt >= OPEN_RETRY_DELAYS_MS.length) return null;
    await sleep(OPEN_RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * O valor cifrado não abriu. Ele continua no `localStorage`, intocado, e o cofre tenta de
 * novo sozinho (15s, 30s, depois de minuto em minuto, para sempre) enquanto o valor guardado
 * for o MESMO. Abriu: avisa o app, que volta a ficar conectado sem ninguém digitar nada.
 */
function scheduleLockedRetry(key: string, raw: string, attempt: number): void {
  clearLocked(key);
  const delay = LOCKED_RETRY_DELAYS_MS[Math.min(attempt, LOCKED_RETRY_DELAYS_MS.length - 1)];
  const timer = setTimeout(() => {
    const entry = locked.get(key);
    if (!entry || entry.raw !== raw) return;
    entry.timer = null;
    if (readRaw(key) !== raw || pending.has(key)) {
      // Um login novo gravou por cima (ou a sessão foi removida): não é mais este que vale.
      locked.delete(key);
      return;
    }
    void withTimeout(unprotect(raw), CIPHER_TIMEOUT_MS).then(
      (value) => {
        if (locked.get(key)?.raw !== raw) return;
        locked.delete(key);
        if (readRaw(key) !== raw || pending.has(key)) return;
        unlocked.set(key, { raw, value });
        for (const listener of lateUnlockListeners) {
          try {
            listener();
          } catch {
            /* quem escuta não pode derrubar o cofre */
          }
        }
      },
      () => {
        if (locked.get(key)?.raw === raw) scheduleLockedRetry(key, raw, attempt + 1);
      },
    );
  }, delay);
  locked.set(key, { raw, attempt, timer });
}

async function getItem(key: string): Promise<string | null> {
  // No máximo uma volta extra: se o valor guardado mudou enquanto a decifragem rodava
  // (login novo no meio), a leitura recomeça e devolve o valor NOVO, nunca o que ficou velho.
  for (let round = 0; round < 3; round++) {
    const waiting = pending.get(key);
    if (waiting !== undefined) return waiting;

    const raw = readRaw(key);
    if (!raw) return null;
    if (!isSealed(raw)) {
      // Valor em claro (versão anterior, ou cifra indisponível): vale na hora.
      migrateLater(key, raw);
      return raw;
    }
    const hit = unlocked.get(key);
    if (hit && hit.raw === raw) return hit.value;
    // Já tentou abrir este mesmo valor e não deu: não segura a leitura de novo. A nova
    // tentativa é a do segundo plano (`scheduleLockedRetry`).
    if (locked.get(key)?.raw === raw) return null;

    let job = opening.get(key);
    if (!job || job.raw !== raw) {
      const work = openWithRetries(raw).finally(() => {
        if (opening.get(key)?.work === work) opening.delete(key);
      });
      job = { raw, work };
      opening.set(key, job);
    }
    const value = await job.work;

    if (pending.has(key) || readRaw(key) !== raw) continue;
    if (value === null) {
      if (locked.get(key)?.raw !== raw) scheduleLockedRetry(key, raw, 0);
      return null;
    }
    unlocked.set(key, { raw, value });
    return value;
  }
  return pending.get(key) ?? null;
}

async function setItem(key: string, value: string): Promise<void> {
  const version = bumpVersion(key);
  pending.set(key, value);
  // Um login novo vale mais que o valor antigo que não abriu: para de tentar abri-lo.
  clearLocked(key);
  await persist(key, value, version).catch(() => {});
}

async function removeItem(key: string): Promise<void> {
  bumpVersion(key);
  pending.delete(key);
  unlocked.delete(key);
  migrationTried.delete(key);
  clearLocked(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* sem storage não há o que apagar */
  }
}

/**
 * Adaptador de armazenamento para `createClient(..., { auth: { storage } })`. O supabase-js
 * aceita os três métodos assíncronos e espera cada um terminar.
 */
export const sessionVaultStorage = { getItem, setItem, removeItem };

/**
 * Avisa quando uma sessão que NÃO abriu na leitura abre depois, em segundo plano. Sem isto o
 * app ficaria na tela de login com uma sessão boa guardada. Devolve a função que cancela.
 */
export function onSessionUnlockedLate(listener: () => void): () => void {
  lateUnlockListeners.add(listener);
  return () => {
    lateUnlockListeners.delete(listener);
  };
}
