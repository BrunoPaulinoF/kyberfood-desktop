/**
 * Estado do DISPOSITIVO que precisa sobreviver a uma reinstalação do app.
 *
 * POR QUE EXISTE: as configurações (impressora, som, auto-impressão) e a credencial do
 * relogin automático viviam SÓ no `localStorage`, que fica no diretório de dados do
 * WebView2. A atualização automática roda um instalador, e a documentação do Tauri não
 * garante que esses dados sobrevivem.
 *
 * Sem uma reserva, o modo de falhar seria o pior possível e só apareceria DEPOIS do fato:
 * o app se atualiza sozinho em todas as lojas e elas acordam sem impressora selecionada e
 * deslogadas, no meio do expediente, sem ninguém ter clicado em nada. Comanda não sai, e
 * ninguém sabe por quê.
 *
 * O `localStorage` CONTINUA sendo a fonte primária — o caminho normal do app não mudou. O
 * arquivo (no diretório de configuração, que o instalador não toca) só é lido quando o
 * `localStorage` volta VAZIO, que é exatamente o cenário da reinstalação.
 *
 * Proteção: a mesma de antes — a pasta de perfil do usuário do Windows. Não há segredo
 * novo aqui; é o mesmo conteúdo que já estava no `localStorage`, num lugar que sobrevive.
 */
import { invoke } from '@tauri-apps/api/tauri';

export const SETTINGS_STORAGE_KEY = 'kyberfood.desktop.settings';
export const CREDENTIALS_STORAGE_KEY = 'kyberfood.desktop.credentials';
/**
 * Credencial só para PREENCHER a tela de login — é outra coisa da de cima.
 *
 * `CREDENTIALS_STORAGE_KEY` faz o app religar SOZINHO; ela é apagada pelo botão Sair,
 * senão "Sair" não sairia (o relogin automático reconectaria no segundo seguinte).
 * Esta aqui não dispara nada: ela só deixa e-mail e senha já digitados na tela, para o
 * lojista clicar em Entrar e pronto. Por isso ela SOBREVIVE ao Sair.
 */
export const LOGIN_PREFILL_STORAGE_KEY = 'kyberfood.desktop.lastLogin';

type DeviceState = { settings?: unknown; credentials?: string; loginPrefill?: string };

/** Lê a reserva. Arquivo ausente NÃO é erro: é o primeiro uso do app. */
async function readDeviceStateFile(): Promise<DeviceState | null> {
  try {
    const raw = await invoke<string | null>('read_device_state');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as DeviceState) : null;
  } catch (err) {
    console.warn('Nao consegui ler a reserva de configuracoes:', err);
    return null;
  }
}

/**
 * Grava a reserva com o que está no `localStorage` AGORA.
 *
 * Sempre escreve o estado INTEIRO, nunca um campo isolado: dois campos gravados em
 * momentos diferentes poderiam descrever dispositivos diferentes — a impressora de hoje
 * com a credencial de um login antigo.
 *
 * NUNCA lança: roda no caminho de salvar configuração e no do login, e uma exceção aqui
 * derrubaria os dois por causa de uma cópia de segurança.
 */
export async function writeDeviceStateFile(): Promise<void> {
  try {
    const settingsRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const credentialsRaw = localStorage.getItem(CREDENTIALS_STORAGE_KEY);
    const prefillRaw = localStorage.getItem(LOGIN_PREFILL_STORAGE_KEY);
    const state: DeviceState = {};
    if (settingsRaw) {
      try {
        state.settings = JSON.parse(settingsRaw);
      } catch {
        /* configuração ilegível não vira reserva: melhor sem reserva do que com lixo */
      }
    }
    if (credentialsRaw) state.credentials = credentialsRaw;
    if (prefillRaw) state.loginPrefill = prefillRaw;
    await invoke('write_device_state', { contents: JSON.stringify(state) });
  } catch (err) {
    console.warn('Nao consegui gravar a reserva de configuracoes:', err);
  }
}

/**
 * Devolve ao `localStorage` o que a reinstalação levou — e SÓ isso.
 *
 * A restauração é por CHAVE e só acontece quando a chave está AUSENTE: se o
 * `localStorage` sobreviveu (o caminho normal, e o que se espera na maioria das
 * atualizações), nada é sobrescrito. O contrário — a reserva vencendo o que está em uso —
 * devolveria a impressora antiga a quem acabou de trocar de impressora.
 *
 * Roda ANTES de o React montar: `loadStoredSettings()` lê o `localStorage` de forma
 * síncrona na criação do estado, então restaurar depois já seria tarde.
 *
 * NUNCA lança: um app que não abre é muito pior que um app sem a reserva.
 */
export async function restoreDeviceStateIfEmpty(): Promise<void> {
  try {
    const hasSettings = localStorage.getItem(SETTINGS_STORAGE_KEY) !== null;
    const hasCredentials = localStorage.getItem(CREDENTIALS_STORAGE_KEY) !== null;
    const hasPrefill = localStorage.getItem(LOGIN_PREFILL_STORAGE_KEY) !== null;
    if (hasSettings && hasCredentials && hasPrefill) return;

    const state = await readDeviceStateFile();
    if (!state) return;

    if (!hasSettings && state.settings !== undefined) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
      console.info('Configuracoes do dispositivo restauradas apos atualizacao.');
    }
    if (!hasCredentials && typeof state.credentials === 'string') {
      localStorage.setItem(CREDENTIALS_STORAGE_KEY, state.credentials);
      console.info('Sessao da loja restaurada apos atualizacao.');
    }
    if (!hasPrefill && typeof state.loginPrefill === 'string') {
      localStorage.setItem(LOGIN_PREFILL_STORAGE_KEY, state.loginPrefill);
    }
  } catch (err) {
    console.warn('Nao consegui restaurar a reserva de configuracoes:', err);
  }
}
