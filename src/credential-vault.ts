/**
 * Cofre da credencial guardada neste PC (relogin automático e preenchimento da tela de login).
 *
 * O QUE MUDOU: e-mail e senha ficavam em base64 — que não é criptografia — no `localStorage`
 * e na reserva em arquivo (`device-state.json`). Agora o que vai para o disco é o texto
 * CIFRADO pela DPAPI do Windows (`protect_secret`/`unprotect_secret`, em
 * `src-tauri/src/win_secret.rs`): a chave fica com o Windows, por computador; o app não guarda
 * chave nenhuma. A senha em claro só existe na MEMÓRIA deste processo.
 *
 * A REGRA QUE MANDA AQUI É OUTRA, E VEM ANTES DA CIFRA: a conta só sai pelo botão Sair. Por
 * isso tudo neste arquivo falha para o lado de continuar conectado:
 *
 *   - o formato antigo (base64) continua sendo LIDO, para sempre;
 *   - ele só é trocado pelo cifrado depois de cifrar, decifrar de volta e conferir que o
 *     resultado é IGUAL ao original (`sealIntoStorage`). Qualquer falha no meio deixa o
 *     antigo exatamente onde estava, e a troca é tentada de novo no próximo arranque;
 *   - se a cifra não funciona neste PC (API indisponível, perfil do Windows com problema,
 *     macOS/Linux de desenvolvimento), um login novo é guardado no formato antigo
 *     (`encodeLegacy`) — é o comportamento de antes, e é melhor que uma loja que desconecta;
 *   - o que está cifrado e não abre NÃO é apagado: a leitura devolve "sem credencial" (o
 *     mesmo que o app já faz quando não há nada guardado), tenta abrir de novo de tempos em
 *     tempos, e o próximo login digitado grava por cima.
 *
 * Trava: `src/lib/desktop-credential-vault.test.ts`, no monorepo (lê este fonte).
 */
import { invoke } from '@tauri-apps/api/tauri';
import {
  CREDENTIALS_STORAGE_KEY,
  LOGIN_PREFILL_STORAGE_KEY,
  readDeviceStateFile,
  writeDeviceStateFile,
} from './device-state';

export type SavedCredentials = { email: string; password: string };

/** Marca do valor cifrado. O formato antigo (base64 de JSON) nunca contém `:`. */
export const SEALED_PREFIX = 'dpapi1:';

/** As duas chaves do `localStorage` que carregam senha, e o campo de cada uma na reserva. */
const VAULT_KEYS = [
  { key: CREDENTIALS_STORAGE_KEY, field: 'credentials' },
  { key: LOGIN_PREFILL_STORAGE_KEY, field: 'loginPrefill' },
] as const;

/** Teto de espera pela cifra. Estourou: segue pelo formato antigo, nunca fica pendurado. */
const SEAL_TIMEOUT_MS = 8_000;
/** Intervalo mínimo entre novas tentativas de abrir um valor cifrado que não abriu. */
const UNLOCK_RETRY_MS = 5 * 60_000;

/** Credencial já decifrada, só em memória. Vale enquanto o `localStorage` tiver o MESMO valor. */
const unlocked = new Map<string, { raw: string; value: SavedCredentials }>();
/** Credencial recém-digitada que ainda está sendo cifrada. A leitura síncrona olha aqui primeiro. */
const pending = new Map<string, SavedCredentials>();
/** Contador por chave: uma gravação (ou o Sair) mais nova invalida a que ainda estava no ar. */
const versions = new Map<string, number>();

let unlocking: Promise<void> | null = null;
let lastUnlockAt = 0;

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

function parseCredentials(json: string): SavedCredentials | null {
  const parsed = JSON.parse(json);
  if (typeof parsed?.email === 'string' && typeof parsed?.password === 'string') {
    return { email: parsed.email, password: parsed.password };
  }
  return null;
}

/** LEITURA do formato antigo. Fica para sempre: é o que mantém conectado quem ainda não migrou. */
function decodeLegacy(raw: string): SavedCredentials | null {
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    return parseCredentials(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * ESCRITA do formato antigo — o ÚNICO lugar do app que ainda produz base64 de senha, e só é
 * chamado quando a cifra FALHOU (ver `persist`). Não use em caminho nenhum que deu certo.
 */
function encodeLegacy(value: SavedCredentials): string {
  const json = JSON.stringify(value);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

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

/**
 * Cifra, CONFERE e só então grava no `localStorage`.
 *
 * A ordem é a trava: (1) cifra; (2) decifra o que acabou de cifrar; (3) confere que voltou
 * IGUAL; (4) grava; (5) lê de volta. Só o passo 4 mexe no que estava guardado — até ali,
 * qualquer falha (exceção, resposta estranha, tempo esgotado) deixa o valor anterior intacto.
 * Se a releitura do passo 5 não bater, o valor anterior é devolvido ao lugar.
 *
 * Devolve `false` sem gravar quando uma gravação mais nova (ou o Sair) passou na frente.
 */
async function sealIntoStorage(
  key: string,
  value: SavedCredentials,
  version: number,
  previousRaw: string | null,
): Promise<boolean> {
  const json = JSON.stringify(value);
  const blob = await invoke<string>('protect_secret', { plain: json });
  if (typeof blob !== 'string' || blob.length === 0) throw new Error('cifra devolveu vazio');
  const back = await invoke<string>('unprotect_secret', { blob });
  if (back !== json) throw new Error('o texto decifrado nao confere com o original');

  if (currentVersion(key) !== version) return false;
  // Migração: se o valor guardado mudou enquanto a cifra rodava, não é mais este que vale.
  if (previousRaw !== null && localStorage.getItem(key) !== previousRaw) return false;

  const raw = SEALED_PREFIX + blob;
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) {
    if (previousRaw !== null) localStorage.setItem(key, previousRaw);
    throw new Error('o valor cifrado nao foi gravado como esperado');
  }
  unlocked.set(key, { raw, value });
  return true;
}

/** Grava a credencial recém-digitada: cifrada se der, no formato antigo se não der. */
async function persist(key: string, value: SavedCredentials, version: number): Promise<void> {
  let sealed = false;
  try {
    sealed = await withTimeout(sealIntoStorage(key, value, version, null), SEAL_TIMEOUT_MS);
  } catch (err) {
    console.warn('Nao consegui cifrar a credencial; guardo no formato antigo:', err);
  }
  if (currentVersion(key) !== version) return;

  if (!sealed) {
    try {
      // A cifra falhou: comportamento de antes. Conectado vem antes de cifrado.
      localStorage.setItem(key, encodeLegacy(value));
    } catch {
      // Sem storage nenhum: a credencial fica só na memória (`pending`) até o app fechar.
      return;
    }
  }
  pending.delete(key);
  // Espelha na reserva: é o que mantém a loja conectada depois de uma atualização.
  await writeDeviceStateFile();
}

/**
 * Leitura SÍNCRONA (o app decide o relogin sem esperar nada): memória primeiro, depois o
 * formato antigo, depois o que já foi decifrado no arranque.
 */
export function loadSavedCredentials(key: string): SavedCredentials | null {
  try {
    const waiting = pending.get(key);
    if (waiting) return waiting;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    if (!isSealed(raw)) return decodeLegacy(raw);
    const hit = unlocked.get(key);
    if (hit && hit.raw === raw) return hit.value;
    // Está cifrado e ainda não abriu: tenta de novo em segundo plano, com freio.
    retryUnlockLater();
    return null;
  } catch {
    return null;
  }
}

/** Guarda a credencial. Vale na hora (memória); a gravação cifrada segue em segundo plano. */
export function saveSavedCredentials(key: string, value: SavedCredentials): void {
  const version = bumpVersion(key);
  pending.set(key, value);
  void persist(key, value, version).catch(() => {});
}

/**
 * Esquece o que está em memória (o botão Sair). Quem chama remove a chave do `localStorage`
 * e regrava a reserva — ver `clearCredentials` em `App.tsx`.
 */
export function forgetSavedCredentials(key: string): void {
  bumpVersion(key);
  pending.delete(key);
  unlocked.delete(key);
}

async function unlockKey(key: string): Promise<void> {
  const raw = localStorage.getItem(key);
  if (!raw) return;

  if (isSealed(raw)) {
    if (unlocked.get(key)?.raw === raw) return;
    const json = await invoke<string>('unprotect_secret', { blob: raw.slice(SEALED_PREFIX.length) });
    const value = parseCredentials(json);
    if (value && localStorage.getItem(key) === raw) unlocked.set(key, { raw, value });
    return;
  }

  // MIGRAÇÃO silenciosa do formato antigo. Falhou: fica como está (e continua funcionando).
  const legacy = decodeLegacy(raw);
  if (!legacy) return;
  await sealIntoStorage(key, legacy, currentVersion(key), raw);
}

/**
 * Abre o que está cifrado e migra o que ainda está no formato antigo. Roda no arranque,
 * antes de o React montar (ver `main.tsx`).
 *
 * NUNCA lança, e uma chave que falha não impede a outra.
 */
export function unlockSavedCredentials(): Promise<void> {
  if (unlocking) return unlocking;
  lastUnlockAt = Date.now();
  const run = (async () => {
    for (const { key } of VAULT_KEYS) {
      try {
        await unlockKey(key);
      } catch (err) {
        console.warn('Nao consegui abrir/migrar a credencial guardada:', err);
      }
    }
  })().finally(() => {
    unlocking = null;
  });
  unlocking = run;
  return run;
}

function retryUnlockLater(): void {
  if (unlocking || Date.now() - lastUnlockAt < UNLOCK_RETRY_MS) return;
  void unlockSavedCredentials().catch(() => {});
}

function plainFields(state: Record<string, unknown>): string[] {
  return VAULT_KEYS.filter(({ field }) => {
    const value = state[field];
    return typeof value === 'string' && !isSealed(value);
  }).map(({ field }) => field);
}

/**
 * Tira a senha em base64 das CÓPIAS em arquivo, depois que o `localStorage` já está cifrado:
 * a reserva (`device-state.json`) e o arquivo do lugar antigo, que só existia para migrar.
 *
 * Só regrava a reserva quando o `localStorage` tem o valor CIFRADO de cada campo que ainda
 * está em claro nela — regravar com o `localStorage` vazio apagaria a única cópia. E só apaga
 * o arquivo antigo depois de reler a reserva e conferir que ela bate com o `localStorage`.
 *
 * NUNCA lança.
 */
export async function scrubPlaintextCopies(): Promise<void> {
  try {
    let state = (await readDeviceStateFile()) as Record<string, unknown> | null;
    if (!state) return;

    const plain = plainFields(state);
    if (plain.length > 0) {
      const allSealedInStorage = VAULT_KEYS.filter(({ field }) => plain.includes(field)).every(
        ({ key }) => {
          const raw = localStorage.getItem(key);
          return raw !== null && isSealed(raw);
        },
      );
      if (!allSealedInStorage) return;
      await writeDeviceStateFile();
      state = (await readDeviceStateFile()) as Record<string, unknown> | null;
      if (!state || plainFields(state).length > 0) return;
    }

    for (const { key, field } of VAULT_KEYS) {
      const raw = localStorage.getItem(key);
      if (raw !== null && state[field] !== raw) return;
    }
    await invoke('remove_legacy_device_state');
  } catch (err) {
    console.warn('Nao consegui limpar as copias antigas da credencial:', err);
  }
}
