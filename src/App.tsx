import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient, RealtimeChannel, processLock } from '@supabase/supabase-js';
import { 
  Bell, 
  Printer, 
  Settings, 
  Volume2, 
  VolumeX, 
  Check, 
  X, 
  Clock,
  MapPin,
  Phone,
  User,
  ShoppingCart,
  RefreshCw,
  Download,
  LogOut,
  CheckCircle2
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  SETTINGS_STORAGE_KEY,
  CREDENTIALS_STORAGE_KEY,
  LOGIN_PREFILL_STORAGE_KEY,
  writeDeviceStateFile,
} from './device-state';
import { getVersion } from '@tauri-apps/api/app';
import { open as openExternal } from '@tauri-apps/api/shell';
import { checkUpdate, installUpdate } from '@tauri-apps/api/updater';
import { relaunch } from '@tauri-apps/api/process';
import { fetch as tauriFetch, Body, ResponseType } from '@tauri-apps/api/http';

const isTauri = typeof window !== 'undefined' && '__TAURI_IPC__' in window;

/**
 * Requisição HTTP que sai pelo RUST quando rodando dentro do app.
 *
 * O `window.fetch` do webview parte de uma origem própria (tauri://localhost) e sofre
 * CORS: o manifesto de atualização mora numa release do GitHub, que redireciona para
 * objects.githubusercontent.com — domínio que não libera outra origem. Resultado: a
 * verificação de atualização falhava SEMPRE, em silêncio, e o botão de atualizar nunca
 * aparecia. Pelo cliente do Tauri a requisição é feita pelo processo nativo, onde CORS
 * simplesmente não existe.
 *
 * Fora do app (ex.: `npm run dev` aberto no navegador) cai no fetch normal. Se o caminho
 * nativo falhar por qualquer motivo, ainda tentamos o fetch do webview: para a nossa
 * própria API ele comprovadamente funciona, e o heartbeat é idempotente (upsert), então
 * repetir a chamada é inofensivo — bem melhor que ficar sem batida.
 */
async function httpJson<T = any>(
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; timeoutSeconds?: number } = {},
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const method = options.method || 'GET';

  if (isTauri) {
    try {
      const res = await tauriFetch<T>(url, {
        method,
        headers: options.headers,
        responseType: ResponseType.JSON,
        timeout: options.timeoutSeconds ?? 20,
        ...(options.body !== undefined ? { body: Body.json(options.body as any) } : {}),
      });
      return { ok: res.ok, status: res.status, data: (res.data ?? null) as T | null };
    } catch (err) {
      console.warn('Requisição nativa falhou, tentando pelo webview:', err);
    }
  }

  const res = await fetch(url, {
    method,
    headers: options.headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data: data as T | null };
}

// Manifesto publicado pelo GitHub Actions a cada build do app desktop.
// O app o consulta para saber se há uma versão mais nova (atualização opcional).
const UPDATE_MANIFEST_URL = 'https://github.com/BrunoPaulinoF/kyberfood-desktop/releases/latest/download/latest.json';
const FALLBACK_DOWNLOAD_URL = 'https://github.com/BrunoPaulinoF/kyberfood-desktop/releases/latest/download/KyberFood-Setup.exe';

type UpdateManifest = { version?: string; url_win?: string | null; notes?: string | null };

/**
 * Descobre a versão publicada, em duas fontes.
 *
 * Primeiro pelo nosso servidor (que já é consultado pelo app e devolve o manifesto em
 * cache) e, se ele não responder, direto no GitHub. Duas fontes porque a resposta precisa
 * ser confiável: uma falha aqui reaparece para o lojista como "não consigo saber se estou
 * atualizado", que foi exatamente o problema relatado.
 */
async function fetchLatestManifest(): Promise<UpdateManifest | null> {
  try {
    const res = await httpJson<UpdateManifest>(`${apiUrl}/api/desktop/latest-version`);
    if (res.ok && res.data?.version) return res.data;
  } catch (err) {
    console.warn('Versão publicada indisponível pelo servidor do KyberFood:', err);
  }

  const res = await httpJson<UpdateManifest>(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.data;
}

/**
 * Instala a atualização SOZINHO, pelo updater nativo do Tauri.
 *
 * POR QUE SÓ NO ARRANQUE: instalar reinicia o app (é o que a própria documentação do Tauri
 * diz do Windows). No meio do expediente isso derruba o recebimento de pedidos e a
 * impressão por alguns segundos — e uma comanda perdida custa muito mais que uma
 * atualização adiada. No arranque, ninguém está esperando comanda ainda.
 *
 * Depois disso, a atualização segue existindo como o BOTÃO que já existia: o lojista decide
 * a hora.
 *
 * DEVOLVE `true` só quando de fato vai reiniciar — aí o chamador não deve seguir com a
 * checagem normal, porque o app está de saída.
 *
 * NUNCA lança. Com o updater desligado no build (é o estado enquanto não houver chave de
 * assinatura), `checkUpdate` rejeita — e o app tem que continuar subindo exatamente como
 * sobe hoje. Esta função é uma melhoria opcional, nunca um caminho crítico.
 */
async function installUpdateOnLaunch(): Promise<boolean> {
  try {
    const { shouldUpdate } = await checkUpdate();
    if (!shouldUpdate) return false;

    // A reserva é gravada ANTES de instalar: se o instalador limpar os dados do WebView,
    // é ela que devolve impressora, som e sessão no primeiro arranque da versão nova.
    await writeDeviceStateFile();

    await installUpdate();
    await relaunch();
    return true;
  } catch (err) {
    console.warn('Atualizacao automatica indisponivel:', err);
    return false;
  }
}

interface UpdateInfo {
  version: string;
  url: string;
  notes?: string;
}

// Resultado da última verificação de atualização. 'idle' é o repouso: nada a dizer.
type UpdateCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  // Instalando e prestes a reiniciar: o lojista precisa saber por que o app vai sumir.
  | { state: 'installing' }
  | { state: 'up-to-date'; latest: string }
  | { state: 'outdated'; latest: string }
  | { state: 'error' };

// Compara duas versões no formato "1.2.3". Retorna >0 se a > b, <0 se a < b, 0 se iguais.
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ===== Configuração de impressão =====
// Espelha src/lib/desktop-print-config.ts do app web. O lojista edita na página
// de Integrações (com pré-visualização) e o desktop aplica na comanda.
type PrintFontSize = 'small' | 'normal' | 'large';
/**
 * COMO a comanda é desenhada: `printer` = modo TEXTO (a fonte da própria impressora, o de
 * sempre); `graphic` = modo GRÁFICO (o app desenha a comanda como imagem com uma fonte de
 * verdade e manda como bitmap raster ESC/POS — ver src-tauri/src/receipt_raster.rs).
 * ESPELHA PrintFontStyle de src/lib/desktop-print-config.ts.
 */
type PrintFontStyle = 'printer' | 'graphic';

interface PrintConfig {
  fontSize: PrintFontSize;
  fontStyle: PrintFontStyle;
  paperWidth: 32 | 48; // 32 = 58mm, 48 = 80mm
  /**
   * Vias da MESMA comanda em CADA pedido novo, escolhidas pelo lojista em Integrações.
   *
   * É por COMPUTADOR, e é isso que o lojista quer: com o app em dois PCs, cada um imprime as
   * suas vias na própria impressora. Quem sabe em qual máquina está é o app — o servidor não
   * tem como mandar "imprima neste PC".
   */
  copies: number;
  showStoreAddress: boolean;
  showDateTime: boolean;
  showCustomerPhone: boolean;
  showDeliveryAddress: boolean;
  showItemNotes: boolean;
  showPayment: boolean;
  showOrderNotes: boolean;
  footerText: string;
}

const DEFAULT_PRINT_CONFIG: PrintConfig = {
  fontSize: 'normal',
  fontStyle: 'printer',
  // 80mm (48 colunas) é o padrão do mercado das impressoras térmicas.
  paperWidth: 48,
  copies: 1,
  showStoreAddress: true,
  showDateTime: true,
  showCustomerPhone: true,
  showDeliveryAddress: true,
  showItemNotes: true,
  showPayment: true,
  showOrderNotes: true,
  footerText: 'OBRIGADO E BOM APETITE!',
};

// Tamanho da fonte (em pt) enviado ao comando de impressão do Rust.
const FONT_SIZE_PT: Record<PrintFontSize, number> = { small: 7, normal: 9, large: 12 };

/**
 * Idade máxima de um job de impressão vindo do painel que ainda vale imprimir.
 *
 * ESPELHA PRINT_JOB_MAX_AGE_MS de src/lib/desktop-print-jobs.ts no app web. Protege o caso
 * em que o painel morreu no meio da espera (aba fechada, queda de rede) e não cancelou o
 * job: sem o teto, o app imprimiria o fechamento de horas atrás ao reconectar o realtime.
 */
const PRINT_JOB_MAX_AGE_MS = 2 * 60_000;

/** Varredura de segurança da fila, para quando o realtime não entregar o INSERT. */
const PRINT_JOB_SWEEP_MS = 15_000;

/**
 * Teto de vias por pedido. ESPELHA MAX_PRINT_COPIES de src/lib/desktop-print-config.ts: o
 * painel não deixa escolher mais que isso, e aqui é a rede contra um valor estranho virar
 * meia bobina em cada pedido.
 */
const MAX_PRINT_COPIES = 3;

/** Vias válidas: inteiro de 1 a MAX_PRINT_COPIES. Valor ilegível cai em 1, nunca em papel a mais. */
function normalizePrintCopies(value: any): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_PRINT_COPIES);
}

function normalizePrintConfig(value: any): PrintConfig {
  const raw = value && typeof value === 'object' ? value : {};
  const fontSize: PrintFontSize = raw.fontSize === 'small' || raw.fontSize === 'large' ? raw.fontSize : 'normal';
  // Só o valor EXPLÍCITO liga o modo gráfico: config antiga (sem o campo) fica no texto.
  const fontStyle: PrintFontStyle = raw.fontStyle === 'graphic' ? 'graphic' : 'printer';
  // Padrão 80mm (48); só cai para 58mm quando a loja escolheu 32 explicitamente.
  const paperWidth: 32 | 48 = Number(raw.paperWidth) === 32 ? 32 : 48;
  const bool = (v: any, fallback: boolean) => (v === undefined ? fallback : Boolean(v));
  return {
    fontSize,
    fontStyle,
    paperWidth,
    copies: normalizePrintCopies(raw.copies),
    showStoreAddress: bool(raw.showStoreAddress, true),
    showDateTime: bool(raw.showDateTime, true),
    showCustomerPhone: bool(raw.showCustomerPhone, true),
    showDeliveryAddress: bool(raw.showDeliveryAddress, true),
    showItemNotes: bool(raw.showItemNotes, true),
    showPayment: bool(raw.showPayment, true),
    showOrderNotes: bool(raw.showOrderNotes, true),
    footerText: raw.footerText !== undefined ? String(raw.footerText) : DEFAULT_PRINT_CONFIG.footerText,
  };
}

// Types
interface Order {
  id: string;
  order_number?: string | null;
  created_at: string;
  /** Última escrita no pedido — para o PIX é o instante em que o pagamento confirmou. */
  updated_at?: string | null;
  status: string;
  total: number;
  subtotal: number;
  delivery_fee: number;
  discount_amount?: number | null;
  increase_amount?: number | null;
  coupon_code?: string | null;
  scheduled_at?: string | null;
  payment_method: string;
  payment_status: string;
  // Troco (pedidos antigos, sem metadata.saipos.payment_types).
  change_for?: number | null;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  delivery_neighborhood: string;
  notes: string;
  items: OrderItem[];
  // Formas de pagamento detalhadas (formato Saipos) gravadas pelo web app em
  // metadata.saipos.payment_types — cobre pagamento dividido, troco e formas
  // personalizadas. payment_method sozinho não conta essa história.
  metadata?: {
    saipos?: {
      payment_types?: Array<{
        code?: string;
        amount?: number;
        change_for?: number;
        complement?: string;
        type?: string;
      }>;
    } | null;
    /** 'pickup' | 'delivery' — tipo do pedido gravado na criação pelo app web. */
    order_type?: string | null;
  } | null;
}

// Nomes amigáveis dos códigos Saipos para exibição/impressão.
const PAYMENT_CODE_LABELS: Record<string, string> = {
  PARTNER_PAYMENT: 'PIX Online',
  DIN: 'Dinheiro',
  CRE: 'Cartao de Credito',
  DEB: 'Cartao de Debito',
  CARD: 'Cartao',
  VALE: 'Vale',
  OTHER: 'Outro',
};

// Dinheiro na comanda com VÍRGULA nos centavos ("R$ 83,00"), como todo documento
// brasileiro. ESPELHA formatReceiptMoney de src/lib/desktop-print-config.ts.
function formatReceiptMoney(value: number): string {
  const n = Number(value) || 0;
  const abs = Math.abs(n).toFixed(2).replace('.', ',');
  return `${n < 0 ? '-' : ''}R$ ${abs}`;
}

// Telefone no formato brasileiro ("(19) 97125-3411") no lugar do JID cru do WhatsApp.
// ESPELHA formatReceiptPhone de src/lib/desktop-print-config.ts.
function formatReceiptPhone(raw?: string | null): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (!/^[\d\s()+-]+$/.test(text)) return text;
  let digits = text.replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return text;
}

// Nome do cliente sem o "~" que o WhatsApp põe na frente do contato não salvo.
// ESPELHA receiptCustomerName de src/lib/desktop-print-config.ts.
function receiptCustomerName(raw?: string | null): string {
  const name = String(raw || '').replace(/^[\s~]+/, '').trim();
  return name || 'Cliente';
}

// Tamanho do item como vai para a comanda: SÓ o que a cozinha usa. O parêntese descritivo
// do cadastro ("Grande (35cm, 8 fatias)") cai — "não tem a necessidade de ter a quantidade
// de fatias, o centímetro também não" (Disk Pizzaiolo, 04/09/2026) — e o "Único" que o PDV
// anexa a todo produto sem variação some. O peso do produto por quilo passa intacto.
// ESPELHA receiptSizeLabel de src/lib/desktop-print-config.ts.
function receiptSizeLabel(raw?: string | null): string | null {
  let size = String(raw || '').trim();
  if (!size) return null;
  if (/^[uú]nico$/i.test(size)) return null;
  let previous = '';
  while (previous !== size) {
    previous = size;
    size = size.replace(/\s*\([^()]*\)\s*$/, '').trim();
  }
  return size || null;
}

// Texto do pagamento do pedido: usa payment_types quando existir (dividido,
// personalizado, troco); senão cai no payment_method cru (pedidos antigos).
function formatOrderPayments(order: Order): string {
  const payments = order.metadata?.saipos?.payment_types;
  if (Array.isArray(payments) && payments.length > 0) {
    const showAmount = payments.length > 1;
    return payments
      .map((p) => {
        const code = String(p.code || '').toUpperCase();
        const complement = String(p.complement || '').trim();
        const isCustom = (code === 'OTHER' || code === 'VALE') && complement;
        const name = isCustom ? complement : (PAYMENT_CODE_LABELS[code] || 'Outro');
        const complementText = !isCustom && complement && complement.toUpperCase() !== 'PIX' ? ` ${complement}` : '';
        const amountText = showAmount ? ` ${formatReceiptMoney(Number(p.amount) || 0)}` : '';
        const changeFor = Number(p.change_for) || 0;
        const changeText = changeFor > 0 ? ` (troco p/ ${formatReceiptMoney(changeFor)})` : '';
        return `${name}${complementText}${amountText}${changeText}`;
      })
      .join(' + ');
  }
  const orderChangeFor = Number(order.change_for) || 0;
  const orderChangeText = orderChangeFor > 0 ? ` (troco p/ ${formatReceiptMoney(orderChangeFor)})` : '';
  return `${(order.payment_method || '').toUpperCase()}${orderChangeText}`;
}

// PIX pago ONLINE ainda aguardando o pagamento cair. O pedido nasce em
// 'ai_attention' com payment_status 'pending' — o QR é gerado, mas o cliente
// ainda não pagou. Só quando o webhook do Asaas confirma o PIX é que o pedido é
// liberado para produção ('confirmed'/'preparing'/'delivering') e/ou vira
// payment_status 'paid'. Enquanto isso NÃO acontece, o desktop não pode
// imprimir a comanda nem tocar o som (senão a cozinha recebe pedido não pago).
// Formas offline (dinheiro, cartão na entrega) não passam por aqui: imprimem na
// hora, como sempre.
function isAwaitingOnlinePixPayment(order: Order): boolean {
  const payments = order.metadata?.saipos?.payment_types;
  const requiresOnlinePix =
    (order.payment_method || '').toLowerCase() === 'pix' ||
    (Array.isArray(payments) &&
      payments.some((p) => p?.type === 'ONLINE' || String(p?.code || '').toUpperCase() === 'PARTNER_PAYMENT'));
  if (!requiresOnlinePix) return false;
  // Pagamento já caiu → liberado para imprimir/tocar. Cobre o PIX puro
  // (payment_status 'paid') e o pagamento misto (parte online cai, pedido vira
  // 'confirmed' mas segue 'pending' porque falta a parte da entrega).
  const released =
    order.payment_status === 'paid' ||
    ['confirmed', 'preparing', 'delivering'].includes(order.status);
  return !released;
}

// Formata created_at no fuso da loja (a máquina Windows pode estar em outro
// fuso/locale). ESPELHA formatDateTimeBR de src/lib/store-timezone.ts do web,
// para a comanda sair idêntica à pré-visualização do painel.
function formatOrderDateTime(value: string, timezone?: string | null): string {
  const date = new Date(value);
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone || 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date).replace(', ', ' ');
  } catch {
    return date.toLocaleString('pt-BR');
  }
}

interface OrderItem {
  id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  notes: string;
  complements: Array<{ name?: string; price?: number; groupName?: string | null }>;
  // Tamanho escolhido (colunas novas em order_items; pedidos antigos não têm).
  size_id?: string | null;
  size_name?: string | null;
  // Item de CORTESIA (brinde por valor mínimo). Pedidos anteriores à feature não têm.
  is_gift?: boolean | null;
}

interface Store {
  id: string;
  name: string;
  address: string;
  phone: string;
  timezone?: string | null;
}

interface Settings {
  autoPrint: boolean;
  soundEnabled: boolean;
  selectedPrinter: string;
  volume: number;
}

// Número curto do pedido exibido na comanda/telas (4 últimos dígitos do telefone, com
// sufixo -2, -3 em colisão no mesmo dia). Gravado pelo web app em orders.order_number;
// pedidos antigos ficam sem e caem no fallback dos 8 primeiros caracteres do UUID.
// Espelha formatOrderNumber() de src/lib/order-number.ts no web app.
function orderDisplayNumber(order: { order_number?: string | null; id: string }): string {
  const stored = order.order_number;
  if (stored && String(stored).trim()) return String(stored).trim();
  return String(order.id ?? '').slice(0, 8).toUpperCase();
}

/**
 * FILA DA COMANDA — o pedido que não imprimiu tem que sair quando o computador voltar.
 *
 * O INCIDENTE (Fogão a Lenha, 04/09/2026): caiu a energia três vezes e as comandas desses
 * momentos nunca saíram. O app JÁ retentava a impressão a cada 10s, mas só ENQUANTO
 * LIGADO: a lista de "o que já imprimi" vivia em `useRef`, ou seja, em RAM. Desligou, a
 * lista sumiu — e ao abrir, a linha de base marcava como já impresso tudo o que
 * encontrasse em aberto, exceto o confirmado nos últimos 5 minutos. Esses 5 minutos foram
 * dimensionados para o watchdog do webview (120s até o reload), NUNCA para queda de
 * energia, que dura muito mais. Resultado: energia voltando depois de 5 minutos, o pedido
 * nascia "já impresso" e a comanda não saía — em silêncio, sem aviso para ninguém.
 *
 * A CORREÇÃO É A LISTA SOBREVIVER AO DESLIGAMENTO. Ela passa a ser gravada em disco
 * (localStorage), e a linha de base deixa de afirmar "já imprimiu" sobre o que ela nunca
 * viu imprimir: ao voltar, o app compara o que o servidor tem em aberto com o que ELE
 * imprimiu, e manda para a impressora a diferença.
 *
 * A FILA É DESTE COMPUTADOR, e não da loja. Numa loja com dois PCs, cada um precisa
 * imprimir a SUA comanda — foi por isso que as vias extras pelo servidor foram revertidas
 * (`20260903234500_drop_order_extra_receipts.sql`). Por isso o carimbo que o servidor
 * guarda (`orders.receipt_printed_at`) serve ao painel e ao diagnóstico, e NUNCA veta a
 * impressão aqui: a máquina que perdesse a corrida ficaria sem papel nenhum, e "a comanda
 * some numa das duas máquinas" é bem pior de diagnosticar do que sair repetida.
 *
 * Espelha `src/lib/order-receipt-queue.ts` do web (projetos separados, sem import entre
 * eles); a varredura que amarra os dois lados está em `desktop-order-intake.test.ts`.
 */
const PRINTED_ORDERS_STORAGE_KEY = 'kyberfood.desktop.printedOrders';
const RECEIPT_QUEUE_SINCE_STORAGE_KEY = 'kyberfood.desktop.receiptQueueSince';

/**
 * Até quando um pedido pendente ainda merece papel.
 *
 * Seis horas cobrem qualquer queda dentro do MESMO expediente, que é o caso em que a
 * comanda ainda tem uso. Acima disso o pedido já foi resolvido de outro jeito, e cuspir a
 * comanda do almoço às 20h põe na bancada um pedido fantasma. O que fica de fora não é
 * engolido: vira aviso (`notifyStaleReceipt`).
 */
const RECEIPT_QUEUE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Por quanto tempo a lista gravada em disco é mantida — depois disso nada mais imprime mesmo. */
const PRINTED_ORDERS_TTL_MS = 24 * 60 * 60 * 1000;

function printedOrdersKey(storeId: string): string {
  // Por LOJA: o app pode ser reapontado para outra loja, e a lista de uma não diz nada
  // sobre a outra.
  return `${PRINTED_ORDERS_STORAGE_KEY}.${storeId}`;
}

/** Pedidos já impressos NESTA máquina: id -> quando saiu. Poda o que passou do TTL. */
function loadPrintedOrders(storeId: string): Map<string, number> {
  const printed = new Map<string, number>();
  try {
    const raw = localStorage.getItem(printedOrdersKey(storeId));
    if (!raw) return printed;
    const parsed = JSON.parse(raw) as Record<string, number>;
    const cutoff = Date.now() - PRINTED_ORDERS_TTL_MS;
    Object.entries(parsed || {}).forEach(([id, at]) => {
      if (typeof at === 'number' && at > cutoff) printed.set(id, at);
    });
  } catch {
    // Disco ilegível: o app volta ao comportamento de quem nunca imprimiu nada — e é o
    // `queueSince` (também perdido, logo redefinido para agora) que impede isso de virar
    // uma bobina inteira de histórico.
  }
  return printed;
}

function savePrintedOrders(storeId: string, printed: Map<string, number>) {
  try {
    const cutoff = Date.now() - PRINTED_ORDERS_TTL_MS;
    const obj: Record<string, number> = {};
    printed.forEach((at, id) => { if (at > cutoff) obj[id] = at; });
    localStorage.setItem(printedOrdersKey(storeId), JSON.stringify(obj));
  } catch {
    // Sem disco a fila degrada para o que era antes (memória): a impressão continua
    // funcionando, só não sobrevive ao desligamento.
  }
}

/**
 * Desde quando ESTA instalação mantém fila.
 *
 * Na primeira execução da versão com fila — e depois de uma reinstalação, que leva a lista
 * junto — não há como saber o que já foi impresso antes. Sem este corte, o app cuspiria de
 * uma vez todas as comandas em aberto no instante da atualização.
 */
function resolveReceiptQueueSince(storeId: string): number {
  const key = `${RECEIPT_QUEUE_SINCE_STORAGE_KEY}.${storeId}`;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) return saved;
    const now = Date.now();
    localStorage.setItem(key, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

/**
 * O instante que conta para a idade do pedido: a CONFIRMAÇÃO (no PIX, quando o pagamento
 * caiu), que é o momento em que a comanda passou a ser devida.
 */
function receiptReferenceTime(order: Order): number | null {
  const stamp = Date.parse(order.updated_at || order.created_at);
  return Number.isFinite(stamp) ? stamp : null;
}

type ReceiptQueueVerdict = 'print' | 'already_printed' | 'not_printable' | 'before_queue' | 'too_old';

function classifyReceiptPrint(
  order: Order,
  opts: { printedLocally: boolean; queueSince: number; now: number },
): ReceiptQueueVerdict {
  if (!['confirmed', 'preparing', 'delivering'].includes(order.status)) return 'not_printable';
  if (opts.printedLocally) return 'already_printed';

  const reference = receiptReferenceTime(order);
  // Sem data legível não dá para saber se é o pedido de agora ou o da semana passada;
  // tratar como antigo mantém o comportamento de sempre, e o oposto arriscaria despejar
  // histórico na bobina por causa de um campo malformado.
  if (reference === null) return 'before_queue';
  if (reference < opts.queueSince) return 'before_queue';
  if (opts.now - reference > RECEIPT_QUEUE_MAX_AGE_MS) return 'too_old';
  return 'print';
}

/**
 * Comanda que ficou pendente tempo demais NÃO sai calada.
 *
 * Papel do almoço saindo à noite vira pedido fantasma na bancada, então ela não é impressa
 * — mas era exatamente esse silêncio que fazia o lojista descobrir o problema pelo cliente
 * cobrando a entrega. Uma notificação por pedido, como a de falha de impressão.
 */
const staleReceiptNotifiedIds = new Set<string>();
function notifyStaleReceipt(order: Order) {
  if (staleReceiptNotifiedIds.has(order.id)) return;
  staleReceiptNotifiedIds.add(order.id);
  try {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification('Comanda antiga NÃO impressa', {
        body: `Pedido ${orderDisplayNumber(order)} ficou horas sem imprimir. Confira no painel e reimprima se ainda for preciso.`,
        icon: '/icon.png',
      });
    }
  } catch {
    /* o aviso é secundário: nunca pode derrubar o caminho da impressão */
  }
}

/**
 * Avisa o balcão de que uma comanda NÃO saiu.
 *
 * O app passa a vida escondido na bandeja, então `setPrintError` (texto na tela) não é
 * visto por ninguém — era por isso que uma falha de impressão sumia sem deixar rastro.
 * UMA notificação por pedido: o polling retenta a cada 10s e avisar a cada tentativa
 * viraria spam, que é o jeito mais rápido de a equipe aprender a ignorar o aviso.
 */
const printFailureNotifiedIds = new Set<string>();
function notifyPrintFailure(order: Order, reason: string) {
  if (printFailureNotifiedIds.has(order.id)) return;
  printFailureNotifiedIds.add(order.id);
  try {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification('Comanda NÃO impressa', {
        body: `Pedido ${orderDisplayNumber(order)} — ${reason}. Confira a impressora.`,
        icon: '/icon.png',
      });
    }
  } catch {
    /* o aviso é secundário: nunca pode derrubar o caminho da impressão */
  }
}

const DEFAULT_SETTINGS: Settings = {
  autoPrint: true,
  soundEnabled: true,
  selectedPrinter: '',
  volume: 0.5,
};

// Por enquanto o app desktop serve APENAS para receber pedidos, imprimir a
// comanda e tocar o som — a visualização/gerência de pedidos é feita no site.
// A UI de pedidos (filas, detalhes, aceitar/recusar, mudar status) fica OCULTA
// atrás desta flag, mas o código é mantido para reativar no futuro sem reescrever.
const SHOW_ORDER_MANAGEMENT = false;

// Carrega as configurações do dispositivo (impressora, som, auto-impressão)
// persistidas localmente, para não se perderem ao reabrir o app.
function loadStoredSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Supabase config.
// Fallbacks públicos: a URL do projeto e a anon key são as MESMAS embutidas no
// app web (públicas por design, protegidas por RLS). Usá-las como fallback
// garante que o app desktop funcione mesmo quando o build não injeta as
// variáveis VITE_* — antes, createClient('') estourava no carregamento do
// módulo, ANTES do React renderizar, e o resultado era a tela toda branca.
const FALLBACK_SUPABASE_URL = 'https://ieghgwrmzoewezzyxvfn.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllZ2hnd3Jtem9ld2V6enl4dmZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNzg0MTYsImV4cCI6MjA4OTg1NDQxNn0.iRnTWaiRohfC_i98mldxuhNKk1Gx23dySrkKhefArec';
// URL do painel web em produção (mesma origem da API que o desktop consome).
const FALLBACK_API_URL = 'https://kyberfood.com.br';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || FALLBACK_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_SUPABASE_ANON_KEY;
const apiUrl = import.meta.env.VITE_API_URL || FALLBACK_API_URL;
// Login persistente: o app roda numa loja e precisa ficar SEMPRE conectado —
// o lojista não pode ter que refazer login toda vez que liga o PC. Guardamos a
// sessão no localStorage (persistSession) e renovamos o token automaticamente
// (autoRefreshToken), de modo que enquanto o refresh token for válido o app
// reautentica sozinho ao abrir, sem pedir senha de novo.
const AUTH_STORAGE_KEY = 'kyberfood.desktop.auth';

/**
 * Credenciais salvas para o RELOGIN AUTOMÁTICO.
 *
 * Regra do produto: uma vez que a conta foi conectada neste PC, ela NUNCA se desconecta
 * sozinha. Sessão perdida (refresh token expirado depois de dias sem internet, relógio do
 * PC errado, sessão revogada do outro lado) não pode virar "tela de login esperando alguém
 * digitar" — isso é a loja muda, sem IA e sem comanda, até alguém reparar. Só o botão Sair
 * desconecta de verdade, e é ele que apaga o que está aqui.
 *
 * Sobre guardar a senha: fica no mesmo localStorage onde o Supabase JÁ guarda o refresh
 * token — que, sozinho, também dá acesso total à conta. Ou seja, a proteção real (aqui e
 * lá) é a pasta de perfil do usuário do Windows. O base64 não é criptografia, é só para o
 * arquivo não expor a senha a olho nu.
 */

/**
 * Cadência do heartbeat. O servidor dá a loja como offline após 5 min sem batida
 * (DESKTOP_PRESENCE_GRACE_MS, em src/lib/store-availability.ts do app web), então 30s
 * significa 10 batidas de folga antes de a IA parar de atender.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

type SavedCredentials = { email: string; password: string };

function saveCredentials(credentials: SavedCredentials) {
  try {
    const json = JSON.stringify(credentials);
    localStorage.setItem(CREDENTIALS_STORAGE_KEY, btoa(String.fromCharCode(...new TextEncoder().encode(json))));
    // Espelha na reserva: é o que mantém a loja conectada depois de uma atualização.
    void writeDeviceStateFile();
  } catch {
    /* sem storage o relogin automático não existe, mas o login normal continua */
  }
}

function loadCredentials(): SavedCredentials | null {
  try {
    const raw = localStorage.getItem(CREDENTIALS_STORAGE_KEY);
    if (!raw) return null;
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed?.email === 'string' && typeof parsed?.password === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function clearCredentials() {
  try {
    localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
    // A reserva TAMBÉM some: sem isto o botão Sair não desconectaria de verdade — a
    // restauração devolveria a credencial apagada no próximo arranque.
    void writeDeviceStateFile();
  } catch {
    /* ignora */
  }
}

/**
 * PREENCHIMENTO da tela de login — deliberadamente separado da credencial de cima.
 *
 * A de cima faz o app religar SOZINHO e por isso o botão Sair a apaga; se não apagasse,
 * "Sair" não sairia — o relogin automático reconectaria no segundo seguinte. Esta aqui
 * não dispara nada: ela só deixa o e-mail e a senha já digitados, para quem clicou em
 * Sair (ou teve a sessão recusada) voltar clicando UMA vez em Entrar.
 *
 * Guardá-la não é exposição nova: é o mesmo conteúdo que a outra chave já guarda, no
 * mesmo lugar (a pasta de perfil do usuário do Windows).
 */
function saveLoginPrefill(credentials: SavedCredentials) {
  try {
    const json = JSON.stringify(credentials);
    localStorage.setItem(
      LOGIN_PREFILL_STORAGE_KEY,
      btoa(String.fromCharCode(...new TextEncoder().encode(json))),
    );
    void writeDeviceStateFile();
  } catch {
    /* sem storage a tela só abre vazia, como antes */
  }
}

function loadLoginPrefill(): SavedCredentials | null {
  try {
    const raw = localStorage.getItem(LOGIN_PREFILL_STORAGE_KEY);
    if (!raw) return null;
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed?.email === 'string' && typeof parsed?.password === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * A senha salva foi RECUSADA (o lojista trocou a senha da conta). O e-mail continua
 * preenchido — ele não mudou —, mas a senha sai: deixá-la ali prometeria "é só clicar em
 * Entrar" para uma senha que o servidor acabou de rejeitar.
 */
function forgetPrefillPassword() {
  try {
    const prefill = loadLoginPrefill();
    if (!prefill) return;
    saveLoginPrefill({ email: prefill.email, password: '' });
  } catch {
    /* ignora */
  }
}

// Timeout em TODA chamada HTTP do Supabase (auth + REST). Sem isto, uma chamada
// pendurada (rede instável, endpoint lento, refresh de token) fica esperando
// PARA SEMPRE — foi o que deixava o app preso em "Conectando…" ao reabrir.
// Aborta em 15s para o fluxo nunca ficar travado.
const fetchWithTimeout: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const external = init?.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: AUTH_STORAGE_KEY,
    // Lock EM MEMÓRIA (processLock) no lugar do navigator.locks padrão: o
    // navigator.locks podia DEADLOCKAR ao reabrir o app após sair pela bandeja,
    // travando getSession/refresh e, com eles, a tela de "Conectando…" para
    // sempre. processLock é seguro para uma única janela (serializa os refreshes
    // em memória, sem depender de locks do navegador que não são liberados).
    lock: processLock,
  },
  global: { fetch: fetchWithTimeout },
});

// Identidade estável desta instalação. Uma loja pode ter mais de um PC com o app aberto;
// o servidor guarda uma linha de presença por dispositivo e considera a loja online se
// QUALQUER um estiver batendo. Sem um id por máquina, um PC sobrescreveria o outro.
const DEVICE_ID_STORAGE_KEY = 'kyberfood.desktop.deviceId';

function getDeviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (saved) return saved;
    const generated = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    // Sem localStorage o app continua contando como presença, só perde a distinção
    // entre dispositivos da mesma loja.
    return 'default';
  }
}

// A API web exige autenticação (cookie ou Bearer); o desktop envia o token da sessão Supabase.
async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

// Audio context for notifications
let audioContext: AudioContext | null = null;

// Alarme de novo pedido: precisa ser CHAMATIVO e ALTO para a equipe ouvir na hora,
// mas curto (no máx. ~2s). Tocamos uma tríade ascendente repetida 3 vezes (~1,8s),
// com volume elevado, agendada com precisão pelo relógio do AudioContext.
function playNotificationSound() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  const ctx = audioContext;
  // O contexto pode estar "suspended" (política de autoplay): tenta retomar.
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const tone = (
    freq: number,
    startOffset: number,
    duration: number,
    type: OscillatorType = 'triangle',
    peak = 0.6,
  ) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    const startAt = ctx.currentTime + startOffset;
    // Envelope com ataque rápido e cauda curta -> soa "urgente" e recortado.
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.015);
    gain.gain.setValueAtTime(peak, startAt + Math.max(0.04, duration - 0.04));
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  };

  // 3 ciclos de ~0,6s = ~1,8s de alarme (dentro do teto de 2s). Cada ciclo é uma
  // tríade ascendente (Sol -> Si -> Mi agudo), em volume alto, que chama atenção.
  const CYCLE_COUNT = 3;
  const CYCLE_INTERVAL = 0.6; // segundos entre o início de cada ciclo
  for (let i = 0; i < CYCLE_COUNT; i++) {
    const base = i * CYCLE_INTERVAL;
    tone(784, base + 0.0, 0.15); // Sol5
    tone(988, base + 0.17, 0.15); // Si5
    tone(1319, base + 0.34, 0.22, 'sine', 0.7); // Mi6, acento mais forte
  }
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  // Enquanto restauramos a sessão salva no arranque, mostramos um splash em vez
  // de piscar a tela de login (que faria o lojista achar que foi deslogado).
  const [authLoading, setAuthLoading] = useState(true);
  const [store, setStore] = useState<Store | null>(null);
  const [newOrders, setNewOrders] = useState<Order[]>([]);
  const [inProgressOrders, setInProgressOrders] = useState<Order[]>([]);
  const [settings, setSettings] = useState<Settings>(loadStoredSettings);
  const [printConfig, setPrintConfig] = useState<PrintConfig>(DEFAULT_PRINT_CONFIG);
  // Estado da trava de presença, respondido pelo heartbeat. `aiServing` começa true para
  // a tela não acusar problema antes da primeira batida; `heartbeatFailing` só liga depois
  // das retentativas, e é o que avisa o lojista de que a IA está prestes a parar.
  const [aiServing, setAiServing] = useState(true);
  const [heartbeatFailing, setHeartbeatFailing] = useState(false);
  // Relogin automático em andamento: mostra "Reconectando…" em vez da tela de login, para
  // ninguém achar que precisa digitar a senha (e para o app não parecer deslogado).
  const [reconnecting, setReconnecting] = useState(false);
  // true SÓ durante o logout explícito (botão Sair). É o que separa "o lojista quis sair"
  // de "a sessão caiu" — no segundo caso o app tem que voltar sozinho.
  const loggingOutRef = useRef(false);
  const reloginBusyRef = useRef(false);
  const reloginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  // Refs para o handler de realtime sempre imprimir com os valores mais recentes
  // (o efeito de subscribe não re-roda a cada atualização de config/settings).
  const settingsRef = useRef(settings);
  const printConfigRef = useRef(printConfig);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { printConfigRef.current = printConfig; }, [printConfig]);
  // Refs das listas para os handlers de realtime/reconciliação lerem o estado
  // atual sem recriar o canal a cada mudança.
  const newOrdersRef = useRef(newOrders);
  const inProgressOrdersRef = useRef(inProgressOrders);
  useEffect(() => { newOrdersRef.current = newOrders; }, [newOrders]);
  useEffect(() => { inProgressOrdersRef.current = inProgressOrders; }, [inProgressOrders]);
  // Pedidos que já ALERTAMOS (som + notificação), para não tocar duas vezes —
  // seja pelo realtime, seja pelo polling de segurança. Dedup SEPARADO da
  // impressão: o alerta pode sair na chegada ('ai_attention') e a comanda só ao
  // CONFIRMAR — por isso o mesmo pedido precisa ser reprocessado depois do alerta.
  const seenOrderIdsRef = useRef<Set<string>>(new Set());
  // Pedidos cuja comanda já IMPRIMIMOS, para imprimir exatamente 1x. A regra do
  // negócio é: imprimir SÓ quando o pedido chega em CONFIRMADO (nunca em
  // 'ai_attention'/aguardando aprovação). Ver processIncomingOrder.
  const printedOrderIdsRef = useRef<Set<string>>(new Set());
  // Pedidos com impressão EM ANDAMENTO. `printedOrderIdsRef` só recebe o pedido depois
  // que o spooler aceita a comanda; enquanto a impressão corre, é este conjunto que
  // impede o realtime e o polling (que rodam em paralelo) de mandarem a mesma comanda
  // duas vezes. Sem ele, mover a marcação para depois do sucesso abriria duplicata.
  const printingOrderIdsRef = useRef<Set<string>>(new Set());
  /**
   * Quantas vias de cada pedido JÁ SAÍRAM nesta máquina.
   *
   * Sem isto, uma falha na 2ª via faria a retentativa do polling imprimir a comanda INTEIRA
   * de novo — a cozinha receberia a 1ª via duas vezes. Com o contador, a retentativa continua
   * de onde parou, e o pedido só é dado como impresso quando TODAS as vias saíram: nenhum
   * pedido fica com menos vias do que o lojista configurou.
   */
  const printedViasRef = useRef<Map<string, number>>(new Map());
  // Linha de base: na 1ª sincronização após o login NÃO alertamos os pedidos que
  // já existiam. Ela vale só para o SOM/notificação — a impressão é decidida pela fila
  // gravada em disco, senão a comanda pendente de uma queda de energia nasceria "já
  // impressa" e nunca sairia (ver o bloco da fila da comanda).
  const baselineDoneRef = useRef(false);
  /**
   * Contexto da fila de comandas: a loja e desde quando ESTA instalação a mantém.
   *
   * Vive num ref porque `processIncomingOrder` é memoizado com deps vazias (para o polling
   * não recriar o callback a cada render) e mesmo assim precisa do valor atual.
   */
  const receiptQueueRef = useRef<{ storeId: string; since: number }>({ storeId: '', since: Date.now() });
  // Ref sempre apontando para o printOrder mais recente, para o polling (memoizado)
  // imprimir sem capturar um closure antigo.
  const printOrderRef = useRef<(order: Order) => Promise<boolean>>(async () => false);
  // Mesmo motivo: avisar o servidor de que a comanda saiu, a partir do callback memoizado.
  const markReceiptPrintedRef = useRef<(orderId: string) => Promise<void>>(async () => {});
  const [showSettings, setShowSettings] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Erro de impressão visível na tela (o app vive na bandeja: console não basta).
  const [printError, setPrintError] = useState<string | null>(null);
  // Aviso ao mudar status (falha de rede, conflito de concorrência, Saipos) —
  // sem isto o botão "parecia" não funcionar quando a chamada falhava.
  const [actionError, setActionError] = useState<string | null>(null);
  // Última atividade (pedido recebido/impresso) — mostrada no painel de status
  // para a equipe ter certeza de que o app está recebendo e imprimindo.
  const [lastOrderInfo, setLastOrderInfo] = useState<{ number: string; at: number; printed: boolean } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>({ state: 'idle' });

  /**
   * Verifica se há versão mais nova publicada.
   *
   * Roda sozinha ao abrir e a cada 6h, mas TAMBÉM é acionável pelo lojista (`manual`):
   * antes só existia a checagem silenciosa, então quem não via o botão aparecer não tinha
   * como saber se estava atualizado ou se a checagem tinha simplesmente falhado. No modo
   * manual o resultado é sempre dito em voz alta — inclusive "já está atualizado".
   */
  const checkForUpdate = useCallback(async (manual = false) => {
    if (manual) setUpdateCheck({ state: 'checking' });

    try {
      const currentVersion = await getVersion();
      // Reaproveitado no heartbeat: saber qual versão está em cada loja ajuda a
      // diagnosticar uma presença que não aparece, e alimenta a comparação de versões
      // na página de Integrações do painel.
      setAppVersion(currentVersion);

      const manifest = await fetchLatestManifest();
      const latest = String(manifest?.version ?? '').trim();
      if (!latest) throw new Error('manifesto sem versão');

      if (compareVersions(latest, currentVersion) > 0) {
        setUpdateInfo({
          version: latest,
          url: String(manifest?.url_win || FALLBACK_DOWNLOAD_URL),
          notes: manifest?.notes ? String(manifest.notes) : undefined,
        });
        // Uma versão nova reabre o aviso mesmo que a anterior tenha sido dispensada.
        setUpdateDismissed(false);
        setUpdateCheck({ state: 'outdated', latest });
      } else {
        setUpdateInfo(null);
        setUpdateCheck({ state: 'up-to-date', latest });
      }
    } catch (err) {
      console.warn('Falha ao verificar atualização:', err);
      setUpdateCheck({ state: 'error' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // No ARRANQUE a atualização é aplicada sozinha (o app reinicia já na versão nova).
    // Não instalando nada — updater desligado, sem versão nova, ou falha — cai na checagem
    // de sempre, que só AVISA. Ou seja: esta linha nunca tira um aviso que já existia.
    void (async () => {
      const restarting = await installUpdateOnLaunch();
      if (restarting || cancelled) return;
      checkForUpdate();
    })();

    // Reverifica a cada 6 horas enquanto o app estiver aberto. Aqui NÃO se instala: só
    // acende o botão, porque reiniciar no meio do expediente perde pedido.
    const interval = setInterval(() => checkForUpdate(), 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [checkForUpdate]);

  // A confirmação "já está atualizado" é passageira: some sozinha para não virar ruído
  // permanente no cabeçalho.
  useEffect(() => {
    if (updateCheck.state !== 'up-to-date' && updateCheck.state !== 'error') return;
    const timer = setTimeout(() => setUpdateCheck({ state: 'idle' }), 6000);
    return () => clearTimeout(timer);
  }, [updateCheck]);

  const handleUpdateClick = async () => {
    if (!updateInfo) return;

    // Com o updater nativo ligado, o botão INSTALA e reinicia — o lojista não precisa
    // baixar nem passar pelo instalador do Windows. Aqui reiniciar é seguro: foi ele quem
    // pediu, na hora que escolheu.
    try {
      const { shouldUpdate } = await checkUpdate();
      if (shouldUpdate) {
        setUpdateCheck({ state: 'installing' });
        await writeDeviceStateFile();
        await installUpdate();
        await relaunch();
        return;
      }
    } catch (err) {
      console.warn('Instalacao automatica indisponivel, abrindo o download:', err);
    }

    // Sem updater nativo (ou se ele falhar), o caminho é o de sempre: baixar o instalador.
    setUpdateCheck({ state: 'idle' });
    try {
      await openExternal(updateInfo.url);
    } catch {
      window.open(updateInfo.url, '_blank');
    }
  };

  // Persiste as configurações do dispositivo sempre que mudam.
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      // Espelha na reserva: é o que devolve a impressora e o som depois de uma atualização.
      void writeDeviceStateFile();
    } catch {
      /* ignora falha de storage */
    }
  }, [settings]);

  // Sinal de vida para o watchdog NATIVO (RendererWatchdog, em src-tauri/src/main.rs).
  //
  // Fora de qualquer condição de login de propósito: se o WebView2 congelar — o que já
  // derrubou a IA com o app aberto na bandeja —, quem percebe e ressuscita é o Rust, e ele
  // só consegue perceber pela ausência deste ping.
  useEffect(() => {
    if (!isTauri) return;
    const ping = () => { invoke('renderer_alive').catch(() => {}); };
    ping();
    const id = setInterval(ping, 15_000);
    return () => clearInterval(id);
  }, []);

  // Heartbeat: avisa o servidor que o app está online e busca a configuração de impressão
  // atual definida pelo lojista.
  //
  // Este heartbeat NÃO é mais só cosmético: é ele que mantém a IA atendendo no WhatsApp
  // (o servidor considera a loja offline após 5 min sem batida). Por isso ele bate a cada
  // 30s — 10 batidas de folga —, tem retentativa curta em caso de falha, volta a bater
  // assim que a máquina acorda ou a rede retorna, e o resultado vira um selo na tela.
  useEffect(() => {
    if (!isAuthenticated || !store) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const sendHeartbeat = async (attempt = 0) => {
      if (cancelled) return;
      try {
        // Pelo cliente nativo (httpJson): é ESTE heartbeat que mantém a IA atendendo, e
        // um bloqueio de CORS aqui deixaria a loja "offline" para o servidor sem nenhum
        // sintoma visível — o mesmo tipo de falha silenciosa que quebrava a verificação
        // de atualização.
        const res = await httpJson<{ print_config?: unknown; ai_gate?: { ai_serving?: boolean } }>(
          `${apiUrl}/api/desktop/heartbeat?storeId=${store.id}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
            body: { device_id: getDeviceId(), app_version: appVersion || null },
          }
        );
        // 401 = o token da sessão não vale mais. Não adianta repetir a batida com ele: a
        // conta precisa voltar, e é o relogin automático que faz isso (com a credencial
        // salva). Sem este ramo, a loja ficaria offline até alguém abrir o app e digitar.
        if (res.status === 401) {
          void reloginRef.current();
          throw new Error('HTTP 401');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = res.data;
        if (cancelled) return;
        if (data?.print_config) setPrintConfig(normalizePrintConfig(data.print_config));
        setAiServing(data?.ai_gate?.ai_serving !== false);
        setHeartbeatFailing(false);
      } catch (err) {
        console.warn('Falha no heartbeat do desktop:', err);
        if (cancelled) return;
        // Backoff curto (5s, 10s, 20s) DENTRO do ciclo de 30s: um soluço de rede não pode
        // derrubar a IA por engano. Esgotadas as tentativas, só acende o aviso na tela — o
        // intervalo continua batendo, então o app se recupera sozinho quando a rede volta.
        if (attempt < 2) {
          retryTimer = setTimeout(() => sendHeartbeat(attempt + 1), 5_000 * 2 ** attempt);
        } else {
          setHeartbeatFailing(true);
        }
      }
    };

    const beatNow = () => sendHeartbeat();

    beatNow();
    // A cada 30s: mantém o status "conectado" e sincroniza a config de impressão.
    const interval = setInterval(beatNow, HEARTBEAT_INTERVAL_MS);
    // Voltar de suspensão do PC ou de queda de rede: bate na hora em vez de esperar o
    // próximo tick — é justamente o momento em que a IA está parada esperando o app.
    window.addEventListener('online', beatNow);
    window.addEventListener('focus', beatNow);
    document.addEventListener('visibilitychange', beatNow);

    // Detector de congelamento/suspensão: se o relógio andou MUITO mais que o tique de 5s,
    // este webview esteve parado (PC suspenso, timer estrangulado) e o servidor pode já ter
    // dado a loja como offline. Bate imediatamente em vez de esperar o ciclo normal.
    let lastTick = Date.now();
    const driftWatch = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > 20_000) beatNow();
      lastTick = now;
    }, 5_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(driftWatch);
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('online', beatNow);
      window.removeEventListener('focus', beatNow);
      document.removeEventListener('visibilitychange', beatNow);
    };
  }, [isAuthenticated, store, appVersion]);

  // Alerta (som + notificação) e IMPRESSÃO da comanda de um pedido. Idempotente:
  // chamado por realtime e polling, com dedup próprio para cada ação, então pode
  // ser invocado à vontade a cada avistamento do pedido.
  //
  // Regra de impressão (a que o lojista pediu): a comanda sai UMA vez, e SÓ
  // quando o pedido chega em CONFIRMADO (ou além) — NUNCA em 'ai_attention'
  // (pedido ainda aguardando aprovação). Como o alerta pode sair antes (na
  // chegada), o dedup de impressão é SEPARADO do dedup de alerta: um pedido que
  // já tocou o som em 'ai_attention' ainda precisa imprimir ao virar 'confirmed'.
  const processIncomingOrder = useCallback((order: Order) => {
    // PIX pago online: segura o som + a impressão até o pagamento cair. NÃO marca
    // como visto/impresso — assim, quando o pedido virar 'confirmed'/'paid', o
    // polling ou o realtime reprocessam e a comanda sai (com som) no momento certo.
    if (isAwaitingOnlinePixPayment(order)) return;

    // ALERTA: som + notificação uma vez por pedido, no primeiro avistamento
    // (inclusive em 'ai_attention', para o balcão saber que chegou pedido a aprovar).
    const firstSighting = !seenOrderIdsRef.current.has(order.id);
    if (firstSighting) {
      seenOrderIdsRef.current.add(order.id);
      if (settingsRef.current.soundEnabled) {
        playNotificationSound();
      }
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Novo Pedido!', {
          body: `Cliente: ${order.customer_name} - R$ ${Number(order.total).toFixed(2)}`,
          icon: '/icon.png',
        });
      }
    }

    // IMPRESSÃO: exatamente 1x, e só a partir de CONFIRMADO. Antes disso não
    // imprime nada (pedido ainda não aprovado). Se a janela 'confirmed' for
    // perdida (realtime cai + pulo de poll) e o pedido só for avistado já em
    // 'preparing'/'delivering', a comanda ainda sai (1x) — melhor tarde que nunca.
    //
    // O pedido só entra em `printedOrderIdsRef` DEPOIS que o spooler aceita a comanda.
    // Marcar antes (como era) transformava qualquer falha — impressora sem papel,
    // desligada, nenhuma selecionada — em comanda PERDIDA: o pedido ficava marcado como
    // impresso, o polling nunca tentava de novo, e o único aviso era um texto numa
    // janela que vive escondida na bandeja. Falhando, o pedido volta à fila e a próxima
    // passada do polling (10s) tenta outra vez.
    //
    // QUEM DECIDE É A FILA, não a linha de base: o pedido que ficou sem comanda numa queda
    // de energia continua pendente depois do desligamento, porque a lista de impressos é
    // gravada em disco. `too_old` é o único caso em que a comanda pendente não sai — e
    // mesmo esse avisa em vez de calar.
    const verdict = classifyReceiptPrint(order, {
      printedLocally: printedOrderIdsRef.current.has(order.id),
      queueSince: receiptQueueRef.current.since,
      now: Date.now(),
    });
    if (verdict === 'too_old') notifyStaleReceipt(order);

    const canPrint = verdict === 'print'
      && settingsRef.current.autoPrint
      && !printingOrderIdsRef.current.has(order.id);

    if (firstSighting) {
      setLastOrderInfo({ number: orderDisplayNumber(order), at: Date.now(), printed: false });
    }

    if (canPrint) {
      printingOrderIdsRef.current.add(order.id);
      void printOrderRef.current(order)
        .then((ok) => {
          if (!ok) return;
          printedOrderIdsRef.current.add(order.id);
          // Em DISCO, e não só em memória: é o que faz a queda de energia deixar de
          // reimprimir o que já saiu — e o que impede a fila de virar duplicata.
          const { storeId } = receiptQueueRef.current;
          if (storeId) {
            const printed = loadPrintedOrders(storeId);
            printed.set(order.id, Date.now());
            savePrintedOrders(storeId, printed);
          }
          // Avisa o servidor que a comanda saiu (best-effort — ver markReceiptPrinted).
          void markReceiptPrintedRef.current(order.id);
          setLastOrderInfo({ number: orderDisplayNumber(order), at: Date.now(), printed: true });
        })
        .finally(() => {
          printingOrderIdsRef.current.delete(order.id);
        });
    }
  }, []);

  // PILAR CONFIÁVEL de recebimento de pedidos. Busca os pedidos no backend (REST,
  // autenticado por Bearer) — que funciona mesmo quando o realtime do Supabase
  // falha/derruba eventos — e:
  //  - detecta QUALQUER pedido novo (independente de como entrou e mesmo que já
  //    tenha virado 'confirmed' pela Saipos em segundos) para imprimir + tocar som;
  //  - mantém as listas (usadas pela UI de pedidos, hoje oculta) sincronizadas.
  // Na 1ª execução após o login estabelece a linha de base (não alerta o que já
  // existia), para não reimprimir pedidos antigos ao abrir o app.
  const syncFromServer = useCallback(async (storeId: string) => {
    try {
      // Pelo cliente NATIVO (httpJson), nunca pelo fetch do webview: este polling é o
      // PILAR de recebimento de pedidos e o fetch do webview NÃO chega até aqui. A
      // requisição sai de tauri://localhost com header Authorization, o que obriga o
      // navegador a um preflight OPTIONS — e o preflight não carrega o Bearer, então o
      // middleware do site o responde com 307 para /login, sem cabeçalho CORS nenhum.
      // O navegador então bloqueia a chamada real, o catch abaixo só escreve no console
      // e o app fica dependendo SÓ do realtime. Foi exatamente assim que o pedido da
      // Daliane (Leley Tanabi, 30/08/2026 19:46) se perdeu: o realtime do Supabase
      // reiniciou entre 19:44 e 19:47, ninguém entregou o INSERT nem o UPDATE do
      // pagamento, e a comanda nunca saiu. O heartbeat já tinha sido migrado para o
      // caminho nativo pelo MESMO motivo; este ficou para trás.
      const res = await httpJson<{ orders?: Order[] }>(`${apiUrl}/api/orders?storeId=${storeId}`, {
        headers: await getAuthHeaders(),
      });
      // 401 = sessão expirada. Sem o relogin o polling ficaria mudo até alguém abrir o
      // app e digitar a senha — e é ele que garante a comanda quando o realtime falha.
      if (res.status === 401) {
        void reloginRef.current();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = res.data;
      if (!data?.orders) return;
      const all = data.orders as Order[];
      const queue = all.filter(o => o.status === 'ai_attention');
      const inProgress = all.filter(o => ['confirmed', 'preparing', 'delivering'].includes(o.status));
      const active = [...queue, ...inProgress];

      if (!baselineDoneRef.current) {
        // LINHA DE BASE: vale só para o ALERTA (som + notificação). Abrir o app não pode
        // tocar o alarme por cada pedido que já estava em aberto. Pedido PIX online ainda
        // aguardando pagamento fica de fora, para alertar normalmente quando o PIX cair.
        //
        // ELA NÃO DECIDE MAIS IMPRESSÃO — era exatamente isso que engolia a comanda depois
        // de uma queda de energia: ela afirmava "já imprimiu" sobre pedidos que nunca viu
        // imprimir. Quem responde por papel agora é a fila gravada em disco, e por isso os
        // pedidos são processados logo abaixo, na mesma passada: o que ficou pendente sai.
        active.forEach(o => {
          if (isAwaitingOnlinePixPayment(o)) return;
          seenOrderIdsRef.current.add(o.id);
        });
        baselineDoneRef.current = true;
      }

      // Reprocessa todos os ativos na ordem de chegada; o dedup interno (alerta e
      // impressão separados) garante que cada ação ocorra 1x. Sem pré-filtro por "visto":
      // um pedido que já alertou em 'ai_attention' precisa ser reavaliado para imprimir
      // quando chegar em CONFIRMADO.
      active
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .forEach(o => processIncomingOrder(o));

      setNewOrders(queue);
      setInProgressOrders(inProgress);
    } catch (err) {
      console.error('Erro ao sincronizar pedidos:', err);
    }
  }, [processIncomingOrder]);

  // PILAR CONFIÁVEL de recebimento: sincroniza com o backend no arranque e a
  // cada 10s, SEMPRE (independente do realtime). Garante que TODO pedido novo —
  // não importa como entrou — apareça, imprima e toque o som em no máximo ~10s,
  // mesmo quando o realtime do Supabase falha (visto nos logs: replicação/CDC
  // derrubando eventos). O app vive na bandeja, então o intervalo segue ativo
  // com a janela escondida.
  useEffect(() => {
    if (!isAuthenticated || !store) return;
    // Nova sessão/loja: zera a linha de base (não a reaproveita entre lojas).
    seenOrderIdsRef.current = new Set();
    // A lista de impressos vem do DISCO, não vazia: é ela que sobrevive a uma queda de
    // energia e faz o app saber, ao voltar, quais comandas ainda faltam sair — e quais já
    // saíram, para não repetir.
    printedOrderIdsRef.current = new Set(loadPrintedOrders(store.id).keys());
    receiptQueueRef.current = { storeId: store.id, since: resolveReceiptQueueSince(store.id) };
    printedViasRef.current = new Map();
    baselineDoneRef.current = false;
    syncFromServer(store.id);
    const interval = setInterval(() => syncFromServer(store.id), 10 * 1000);
    return () => clearInterval(interval);
  }, [isAuthenticated, store, syncFromServer]);

  // ACELERADOR OPCIONAL: realtime do Supabase para imprimir "na hora" quando ele
  // está saudável. NÃO é a fonte da verdade — o polling acima garante a entrega.
  // O dedup por seenOrderIdsRef evita imprimir/alertar o mesmo pedido duas vezes.
  useEffect(() => {
    if (!isAuthenticated || !store) return;

    let channel: RealtimeChannel;
    // Evita que handlers assíncronos atualizem o estado após o cleanup do efeito.
    let disposed = false;

    const subscribeToOrders = () => {
      channel = supabase
        .channel(`orders:${store.id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'orders', filter: `store_id=eq.${store.id}` },
          async (payload) => {
            const base = payload.new as Order;
            // Dedup rápido: se o polling já processou, nem busca os itens.
            if (seenOrderIdsRef.current.has(base.id)) return;

            // O evento traz só a linha de `orders`; os itens ficam em
            // `order_items`. Buscamos o pedido completo para a comanda sair certa.
            let newOrder = base;
            try {
              const { data: full } = await supabase
                .from('orders')
                .select('*, items:order_items(*)')
                .eq('id', base.id)
                .single();
              if (full) newOrder = full as unknown as Order;
            } catch (err) {
              console.error('Erro ao carregar itens do novo pedido:', err);
            }
            if (disposed) return;

            // Toca som + auto-imprime (com dedup). Se o polling correu em paralelo
            // e já marcou como visto, processIncomingOrder ignora.
            processIncomingOrder(newOrder);
            setNewOrders(prev => prev.some(o => o.id === newOrder.id) ? prev : [newOrder, ...prev]);
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'orders', filter: `store_id=eq.${store.id}` },
          (payload) => {
            const updatedOrder = payload.new as Order;
            const wasInQueue = newOrdersRef.current.find(o => o.id === updatedOrder.id);
            const wasInProgress = inProgressOrdersRef.current.some(o => o.id === updatedOrder.id);

            // Mantém as listas (usadas pela UI de pedidos, hoje oculta) coerentes.
            if (updatedOrder.status !== 'ai_attention') {
              setNewOrders(prev => prev.filter(o => o.id !== updatedOrder.id));
            } else {
              setNewOrders(prev =>
                prev.map(o => o.id === updatedOrder.id
                  ? { ...o, ...updatedOrder, items: updatedOrder.items ?? o.items }
                  : o)
              );
            }

            if (updatedOrder.status === 'completed' || updatedOrder.status === 'cancelled') {
              setInProgressOrders(prev => prev.filter(o => o.id !== updatedOrder.id));
              return;
            }

            setInProgressOrders(prev =>
              prev.map(o => o.id === updatedOrder.id
                ? { ...o, ...updatedOrder, items: updatedOrder.items ?? o.items }
                : o)
            );

            if (['confirmed', 'preparing', 'delivering'].includes(updatedOrder.status) && !wasInProgress) {
              if (wasInQueue) {
                const merged = { ...wasInQueue, ...updatedOrder, items: updatedOrder.items ?? wasInQueue.items };
                setInProgressOrders(prev => prev.some(o => o.id === merged.id) ? prev : [merged, ...prev]);
                // PIX pago online: a impressão/som foi segurada no INSERT (pedido
                // ainda não pago). Este UPDATE é a liberação para produção — é a
                // hora certa de imprimir + tocar. O dedup por seenOrderIdsRef
                // evita reimprimir pedidos offline que já saíram no INSERT.
                processIncomingOrder(merged);
              } else {
                (async () => {
                  try {
                    const { data: full } = await supabase
                      .from('orders')
                      .select('*, items:order_items(*)')
                      .eq('id', updatedOrder.id)
                      .single();
                    if (disposed || !full) return;
                    const fullOrder = full as unknown as Order;
                    setInProgressOrders(prev => prev.some(o => o.id === fullOrder.id) ? prev : [fullOrder, ...prev]);
                    // Mesmo caso do ramo acima, mas para pedidos que não estavam
                    // na fila local (ex.: app aberto depois do pedido criado).
                    processIncomingOrder(fullOrder);
                  } catch (err) {
                    console.error('Erro ao carregar pedido atualizado:', err);
                  }
                })();
              }
            }
          }
        )
        .subscribe((status) => {
          // Ao (re)conectar, sincroniza para recuperar o que possa ter sido
          // perdido enquanto o realtime esteve fora.
          if (status === 'SUBSCRIBED' && !disposed) {
            syncFromServer(store.id);
          }
        });
    };

    subscribeToOrders();

    return () => {
      disposed = true;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [isAuthenticated, store, syncFromServer, processIncomingOrder]);

  // ===========================================================================
  // FILA DE IMPRESSÃO DO PAINEL (desktop_print_jobs)
  //
  // O painel monta o documento (hoje, o Fechamento do Dia) e enfileira um job; aqui ele
  // sai em ESC/POS direto no spooler, com corte no fim. É o que evita o caminho antigo, em
  // que o navegador imprimia uma folha A4 e a bobina andava até completar a altura dela.
  //
  // O JOB É GENÉRICO: ele traz o TEXTO já montado, a largura em colunas e o tamanho da
  // fonte. O app não sabe o que é um fechamento — impressão nova pedida pelo painel passa a
  // funcionar sem build novo do desktop, que é atualizado loja a loja.
  //
  // QUEM EVITA IMPRESSÃO EM DOBRO É O CAS EM `status`: reivindicamos com
  // `pending -> printing` e o painel, ao desistir da espera, faz `pending -> cancelled`.
  // Só um dos dois vence, então o realtime que chega atrasado não reimprime o que o
  // navegador já imprimiu.
  // ===========================================================================
  const printJobSeenRef = useRef<Set<string>>(new Set());

  const finishPrintJob = useCallback(async (jobId: string, status: 'printed' | 'failed', error: string | null) => {
    try {
      await supabase
        .from('desktop_print_jobs')
        .update({ status, error, finished_at: new Date().toISOString() })
        .eq('id', jobId);
    } catch (err) {
      // O papel já saiu (ou já falhou): não conseguir gravar o desfecho só faz o painel
      // esperar o prazo dele e imprimir pelo navegador. Nada a desfazer aqui.
      console.warn('Falha ao registrar o desfecho da impressao:', err);
    }
  }, []);

  const runPrintJob = useCallback(async (job: any) => {
    const jobId = String(job?.id || '');
    if (!jobId || printJobSeenRef.current.has(jobId)) return;
    if (job?.status && job.status !== 'pending') return;

    const createdMs = job?.created_at ? new Date(job.created_at).getTime() : NaN;
    if (Number.isFinite(createdMs) && Date.now() - createdMs > PRINT_JOB_MAX_AGE_MS) return;

    // Reivindicação atômica. Lista vazia = o painel cancelou ou outro dispositivo pegou.
    let claimed: any = null;
    try {
      const { data, error } = await supabase
        .from('desktop_print_jobs')
        .update({ status: 'printing', claimed_at: new Date().toISOString(), device_id: getDeviceId() })
        .eq('id', jobId)
        .eq('status', 'pending')
        .select('id, content, paper_width, font_size_pt');
      if (error) throw error;
      claimed = Array.isArray(data) ? data[0] : data;
    } catch (err) {
      console.warn('Falha ao reivindicar a impressao:', err);
      return;
    }
    if (!claimed) return;
    printJobSeenRef.current.add(jobId);

    const printerName = settingsRef.current.selectedPrinter;
    if (!printerName) {
      setPrintError('Nenhuma impressora configurada — abra Configurações');
      await finishPrintJob(jobId, 'failed', 'Nenhuma impressora configurada');
      return;
    }

    try {
      // Sem avanço extra de linhas: o build_escpos do Rust já avança o papel e corta. O
      // pedido de origem foi justamente sobra de papel em branco.
      await invoke('print_receipt', {
        printerName,
        content: String(claimed.content || ''),
        width: Number(claimed.paper_width) || 48,
        fontSize: Number(claimed.font_size_pt) || FONT_SIZE_PT.normal,
      });
      setPrintError(null);
      await finishPrintJob(jobId, 'printed', null);
    } catch (err: any) {
      setPrintError(`Falha ao imprimir na impressora "${printerName}" — verifique a impressora`);
      await finishPrintJob(jobId, 'failed', String(err?.message || err).slice(0, 300));
    }
  }, [finishPrintJob]);

  useEffect(() => {
    if (!isAuthenticated || !store) return;
    let disposed = false;

    // Varredura: pega o que o realtime não entregou (ele cai com frequência neste app —
    // é o mesmo motivo do polling de pedidos). Só o que ainda está pendente e recente.
    const sweep = async () => {
      if (disposed) return;
      try {
        const since = new Date(Date.now() - PRINT_JOB_MAX_AGE_MS).toISOString();
        const { data, error } = await supabase
          .from('desktop_print_jobs')
          .select('id, status, created_at')
          .eq('store_id', store.id)
          .eq('status', 'pending')
          .gte('created_at', since)
          .order('created_at', { ascending: true })
          .limit(5);
        if (error || !Array.isArray(data)) return;
        for (const job of data) {
          if (disposed) return;
          await runPrintJob(job);
        }
      } catch (err) {
        console.warn('Falha ao varrer a fila de impressao:', err);
      }
    };

    const channel = supabase
      .channel(`print_jobs:${store.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'desktop_print_jobs', filter: `store_id=eq.${store.id}` },
        (payload) => { if (!disposed) void runPrintJob(payload.new); },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && !disposed) void sweep();
      });

    const timer = setInterval(() => { void sweep(); }, PRINT_JOB_SWEEP_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, [isAuthenticated, store, runPrintJob]);

  // Request notification permission
  useEffect(() => {
    if (window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Print order
  //
  // Devolve `true` só quando a comanda foi ACEITA pelo spooler. Quem chama usa isso para
  // decidir se marca o pedido como impresso — falso significa "tente de novo", e é o que
  // impede uma falha momentânea de virar comanda perdida.
  const printOrder = async (order: Order, options?: { copies?: number }): Promise<boolean> => {
    // Sem impressora configurada não há para onde imprimir: o app vive na
    // bandeja, então o diálogo do window.open(...).print() nunca seria visto.
    // Mostra um aviso e deixa o pedido disponível para reimpressão manual.
    const printerName = settingsRef.current.selectedPrinter;
    if (!printerName) {
      setPrintError('Nenhuma impressora configurada — abra Configurações');
      notifyPrintFailure(order, 'Nenhuma impressora configurada');
      return false;
    }
    // REIMPRESSÃO SAI SEMPRE EM UMA VIA (decisão de produto): quem aperta o botão quer uma
    // folha na mão, e o pedido já saiu no número de vias configurado quando chegou.
    const reimpressao = options?.copies !== undefined;
    const totalVias = reimpressao ? Math.max(1, options!.copies!) : normalizePrintCopies(printConfigRef.current.copies);
    // De onde continuar: a via que falhou na tentativa anterior, nunca a comanda inteira.
    const jaSairam = reimpressao ? 0 : (printedViasRef.current.get(order.id) || 0);
    if (jaSairam >= totalVias) return true;

    try {
      // Generate plain text receipt for thermal printer (respeita a config do lojista)
      const cfg = printConfigRef.current;
      const receiptText = encodeReceiptText(buildReceiptDoc(order, store!, cfg)) + '\n\n\n';
      // MODO GRÁFICO: o mesmo documento vai como blocos (JSON) e o Rust o desenha como
      // imagem com a fonte embutida. O texto de sempre viaja junto como fallback — se o
      // spooler recusar o raster, a comanda sai no modo texto em vez de não sair.
      const receiptLayout = cfg.fontStyle === 'graphic'
        ? encodeReceiptLayout(buildReceiptLayout(order, store!, cfg))
        : null;

      // UMA CHAMADA POR VIA: o build_escpos do Rust corta o papel no fim de cada impressão, e
      // o texto repetido numa chamada só sairia como uma tira única para alguém rasgar no meio.
      for (let via = jaSairam + 1; via <= totalVias; via += 1) {
        try {
          // Invoke Rust print command
          if (receiptLayout) {
            await invoke('print_receipt_graphic', {
              printerName,
              layout: receiptLayout,
              fallbackContent: receiptText,
              width: cfg.paperWidth,
              fontSize: FONT_SIZE_PT[cfg.fontSize],
            });
          } else {
            await invoke('print_receipt', {
              printerName,
              content: receiptText,
              width: cfg.paperWidth,
              fontSize: FONT_SIZE_PT[cfg.fontSize],
            });
          }
        } catch (err) {
          if (via === 1) throw err;
          // Vias anteriores JÁ SAÍRAM: reimprimir a comanda inteira daria a mesma via duas
          // vezes para a cozinha. Guarda o que já saiu e devolve `false` — o polling volta em
          // 10s e imprime só o que falta, até o pedido ter todas as vias.
          console.error(`Erro ao imprimir a ${via}a via:`, err);
          printedViasRef.current.set(order.id, via - 1);
          setPrintError(`A ${via}ª via do pedido ${orderDisplayNumber(order)} não saiu — verifique a impressora`);
          notifyPrintFailure(order, `A ${via}ª via não saiu na impressora "${printerName}"`);
          return false;
        }
        if (!reimpressao) printedViasRef.current.set(order.id, via);
      }

      // Todas as vias saíram: o contador não serve mais (quem lembra do pedido impresso é o
      // printedOrderIdsRef) e ficaria crescendo sem fim numa loja de movimento.
      printedViasRef.current.delete(order.id);
      setPrintError(null);
      console.log('Order printed successfully');
      return true;
    } catch (err) {
      console.error('Error printing order:', err);
      setPrintError(`Falha ao imprimir na impressora "${printerName}" — verifique a impressora e reimprima`);
      notifyPrintFailure(order, `Impressora "${printerName}" não respondeu`);
      // Fallback to browser printing if it fails
      const receiptHtml = generateReceiptHtml(order, store!);
      const printWindow = window.open('', '_blank', 'width=400,height=600');
      if (printWindow) {
        printWindow.document.write(receiptHtml);
        printWindow.document.close();
        printWindow.print();
        setTimeout(() => printWindow.close(), 1000);
      }
      // NÃO é sucesso: com a janela escondida na bandeja o window.print() acima não
      // imprime nada que alguém veja. O pedido volta à fila para o polling retentar.
      return false;
    }
  };

  /**
   * Avisa o servidor de que a comanda deste pedido SAIU.
   *
   * BEST-EFFORT DE PROPÓSITO: quando isto roda, o papel já está na mão da cozinha. O
   * carimbo serve ao painel (mostrar quais pedidos ficaram sem comanda) e ao próximo
   * diagnóstico — no incidente do Fogão a Lenha não havia como dizer QUAIS comandas não
   * saíram, porque o banco não guardava nada sobre isso. Falhar aqui (internet caída, que é
   * justamente o cenário da queda de energia) não pode custar nada: a fila que decide a
   * impressão é a lista gravada NESTE computador, não este registro.
   *
   * Pelo cliente NATIVO (httpJson), como o polling e o heartbeat: o fetch do webview morre
   * no preflight CORS e o erro só apareceria no console.
   */
  const markReceiptPrinted = async (orderId: string): Promise<void> => {
    if (!store) return;
    try {
      await httpJson(`${apiUrl}/api/desktop/receipt-printed?storeId=${store.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
        body: { order_id: orderId, device_id: getDeviceId() },
      });
    } catch (err) {
      console.warn('Não consegui registrar a comanda impressa no servidor:', err);
    }
  };

  // Mantém o ref de impressão apontando para o printOrder atual, para o polling
  // (memoizado) imprimir sempre com as configurações/loja mais recentes.
  useEffect(() => { printOrderRef.current = printOrder; });
  useEffect(() => { markReceiptPrintedRef.current = markReceiptPrinted; });

  // Aplica a mudança de status localmente (otimista), movendo o pedido entre as
  // listas na hora. O realtime confirma/reconcilia em seguida. Lê o estado atual
  // pelos refs para não depender da ordem de execução dos setState.
  const applyStatusLocally = (orderId: string, newStatus: string) => {
    const withStatus = (o: Order): Order => ({ ...o, status: newStatus });
    const source =
      newOrdersRef.current.find(o => o.id === orderId) ??
      inProgressOrdersRef.current.find(o => o.id === orderId);

    setSelectedOrder(prev => (prev && prev.id === orderId ? withStatus(prev) : prev));

    // Concluído/cancelado saem de todas as listas.
    if (newStatus === 'cancelled' || newStatus === 'completed') {
      setNewOrders(prev => prev.filter(o => o.id !== orderId));
      setInProgressOrders(prev => prev.filter(o => o.id !== orderId));
      return;
    }

    // confirmed/preparing/delivering: sai da fila de novos e entra/atualiza em andamento.
    setNewOrders(prev => prev.filter(o => o.id !== orderId));
    setInProgressOrders(prev => {
      if (prev.some(o => o.id === orderId)) {
        return prev.map(o => (o.id === orderId ? withStatus(o) : o));
      }
      return source ? [withStatus(source), ...prev] : prev;
    });
  };

  // Update order status — mantém desktop, painel web e Saipos em sintonia.
  // A rota compartilhada (/api/orders/[id]/status) grava no banco, notifica o
  // cliente e sincroniza com a Saipos; o realtime propaga para as demais telas.
  const updateOrderStatus = async (orderId: string, status: string) => {
    // Reflete a mudança imediatamente para a equipe (o realtime confirma depois).
    applyStatusLocally(orderId, status);
    setActionError(null);
    try {
      // Cliente NATIVO, mesmo motivo do polling: o fetch do webview morre no preflight
      // CORS (o middleware responde 307 ao OPTIONS, que não leva o Bearer).
      const response = await httpJson<any>(`${apiUrl}/api/orders/${orderId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
        body: { status },
      });

      if (response.ok) {
        syncFromServer(store!.id);
        return;
      }

      const data: any = response.data;

      if (response.status === 502) {
        // O status FOI salvo no KyberFood; apenas a sincronização com a Saipos
        // falhou. Mantemos a mudança (não desfazemos o trabalho da equipe) e avisamos.
        setActionError('Status atualizado, mas a sincronização com a Saipos falhou. Verifique a integração.');
        syncFromServer(store!.id);
        return;
      }

      // 409 (mudou em outra tela), 400, 401, 404…: nossa suposição otimista pode
      // estar errada — recarrega o estado real do servidor e avisa.
      setActionError(data?.error || 'Não foi possível atualizar o status. A tela foi recarregada.');
      syncFromServer(store!.id);
    } catch (err) {
      console.error('Error updating order:', err);
      setActionError('Sem conexão ao atualizar o status. Tente novamente.');
      syncFromServer(store!.id);
    }
  };

  // Busca a loja "principal" do usuário — usuários com 2+ lojas quebravam o
  // .single(); pega a loja mais antiga sem errar quando há várias.
  //
  // Filtra is_active=true DE PROPÓSITO: o backend (validateAuth/validateBearerAuth)
  // resolve a loja com esse mesmo filtro. Sem ele aqui, um usuário cuja loja mais
  // antiga esteja INATIVA mandaria o heartbeat com o storeId da inativa, enquanto o
  // painel lê a presença da ativa — a loja apareceria "desconectada" mesmo com o app
  // batendo. Manter os dois lados idênticos garante que a presença cai na loja certa.
  const loadStoreForUser = useCallback(async (userId: string): Promise<Store | null> => {
    const { data: storeData } = await supabase
      .from('stores')
      // Colunas explicitas: a linha de stores carrega o certificado A1 do Sicoob + a senha
      // dele e os tokens de PIX/PDV, e este app roda com a chave PUBLICA no PC da loja.
      // Este componente so usa estes cinco campos (ver a interface Store, acima).
      .select('id, name, address, phone, timezone')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return (storeData as Store) ?? null;
  }, []);

  /**
   * Refaz o login sozinho com a credencial salva. A conta só sai de verdade pelo botão Sair.
   *
   * Retenta PARA SEMPRE (backoff até 60s) enquanto o erro puder ser temporário — rede caída,
   * Supabase fora do ar, PC recém-ligado sem internet. A única saída é a credencial ser
   * REJEITADA (senha trocada): aí a máquina não tem como resolver e o lojista precisa
   * digitar de novo.
   */
  const attemptAutoRelogin = useCallback(async (attempt = 0) => {
    if (loggingOutRef.current || reloginBusyRef.current) return;
    const credentials = loadCredentials();
    if (!credentials) return;

    reloginBusyRef.current = true;
    setReconnecting(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword(credentials);
      if (error) throw error;
      if (!data.session) throw new Error('sessão vazia');
      // Daqui o onAuthStateChange assume: recarrega a loja e religa o realtime.
      setError(null);
      setReconnecting(false);
    } catch (err: any) {
      const message = String(err?.message || '').toLowerCase();
      const rejected =
        message.includes('invalid login') ||
        message.includes('invalid credentials') ||
        message.includes('email not confirmed') ||
        message.includes('user not found');

      if (rejected) {
        clearCredentials();
        // A senha guardada não vale mais; o e-mail continua preenchido na tela.
        forgetPrefillPassword();
        setReconnecting(false);
        setError('A senha salva não vale mais. Entre novamente para o app voltar a receber pedidos.');
        return;
      }

      console.warn('Relogin automático falhou, vou tentar de novo:', err);
      const delay = Math.min(60_000, 5_000 * 2 ** attempt);
      if (reloginTimerRef.current) clearTimeout(reloginTimerRef.current);
      reloginTimerRef.current = setTimeout(() => { void attemptAutoRelogin(attempt + 1); }, delay);
    } finally {
      reloginBusyRef.current = false;
    }
  }, []);

  // Ref estável para quem precisa disparar o relogin sem entrar na lista de dependências
  // (o heartbeat, por exemplo, que não pode ser recriado a cada render).
  const reloginRef = useRef(attemptAutoRelogin);
  useEffect(() => { reloginRef.current = attemptAutoRelogin; }, [attemptAutoRelogin]);

  // Sentinela da sessão: a cada minuto confere se a conta continua conectada. Existe porque
  // nem toda perda de sessão emite SIGNED_OUT — um refresh que falha em silêncio deixa o app
  // "logado" na tela e sem token válido, e a loja some do ar sem ninguém perceber.
  useEffect(() => {
    const check = async () => {
      if (loggingOutRef.current || !loadCredentials()) return;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) void attemptAutoRelogin();
      } catch {
        // Falha de rede: o próprio relogin (ou a próxima checagem) resolve.
      }
    };
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [attemptAutoRelogin]);

  useEffect(() => () => { if (reloginTimerRef.current) clearTimeout(reloginTimerRef.current); }, []);

  // Restauração de sessão no arranque + sincronização contínua.
  // Usamos onAuthStateChange como fonte da verdade: ele emite INITIAL_SESSION no
  // arranque lendo a sessão salva do storage (sem depender de rede), o que evita
  // ficar preso esperando um getSession() que pode travar ao reabrir o app.
  useEffect(() => {
    let active = true;

    // Rede de segurança: o splash "Conectando…" NUNCA fica preso. Em no máximo
    // 6s some; se a sessão voltar depois, o onAuthStateChange loga sozinho.
    const splashTimer = setTimeout(() => {
      if (active) setAuthLoading(false);
    }, 6000);

    // Carrega a loja do usuário e libera a tela. Chamado FORA do callback do
    // onAuthStateChange (via setTimeout) porque chamadas ao Supabase dentro do
    // callback rodam sob o lock do auth e podem deadlockar.
    const ensureStoreLoaded = async (userId: string) => {
      try {
        const storeData = await loadStoreForUser(userId);
        if (!active) return;
        if (storeData) {
          setStore(storeData);
          setIsAuthenticated(true);
        }
      } catch (err) {
        console.warn('Falha ao carregar a loja:', err);
      } finally {
        if (active) setAuthLoading(false);
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'SIGNED_OUT' || !session?.user) {
        // Sem sessão (INITIAL_SESSION vazio ou logout): volta o realtime ao token
        // anônimo e mostra a tela de login.
        supabase.realtime.setAuth(supabaseKey);
        setIsAuthenticated(false);
        setStore(null);
        setAuthLoading(false);
        // ...a não ser que a conta já tenha sido conectada neste PC: aí isto NÃO é um
        // logout, é uma falha, e o app se reconecta sozinho com a credencial salva.
        if (!loggingOutRef.current && loadCredentials()) {
          // Já marca aqui (e não só dentro do relogin) para a tela de login não PISCAR
          // entre a perda da sessão e a primeira tentativa.
          setReconnecting(true);
          setTimeout(() => { if (active) void attemptAutoRelogin(); }, 0);
        }
        return;
      }
      // CRÍTICO p/ o realtime: a RLS de `orders` exige auth.uid() = dono da loja.
      // Propaga o token do usuário (inclusive em TOKEN_REFRESHED, senão o realtime
      // "morre" ~1h depois). setAuth do realtime é seguro dentro do callback.
      supabase.realtime.setAuth(session.access_token);
      // INITIAL_SESSION (arranque) / SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED:
      // garante a loja carregada e tira o splash. Deferido para fora do callback.
      const userId = session.user.id;
      setTimeout(() => { if (active) ensureStoreLoaded(userId); }, 0);
    });

    return () => {
      active = false;
      clearTimeout(splashTimer);
      subscription.unsubscribe();
    };
  }, [loadStoreForUser, attemptAutoRelogin]);

  // Login handler
  const handleLogin = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      const storeData = await loadStoreForUser(data.user.id);

      if (storeData) {
        // Credencial guardada no ato: a partir daqui este PC se reconecta sozinho a
        // qualquer perda de sessão, sem depender de alguém estar na frente da tela.
        saveCredentials({ email, password });
        // E o preenchimento da tela, que sobrevive ao Sair: se um dia alguém sair, a
        // volta é um clique em Entrar, não redigitar e-mail e senha no balcão.
        saveLoginPrefill({ email, password });
        loggingOutRef.current = false;
        setStore(storeData);
        setIsAuthenticated(true);
        setReconnecting(false);
        setError(null);
      } else {
        setError('Nenhuma loja encontrada para este usuário');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Logout EXPLÍCITO (botão dentro do app) — a ÚNICA forma de a conta sair de verdade.
  // Fora daqui o login é permanente: fechar pela bandeja, reiniciar o PC, ficar dias sem
  // internet ou perder a sessão não desconectam nada — o app refaz o login sozinho com a
  // credencial salva. Por isso este é também o único ponto que apaga essa credencial.
  const handleLogout = async () => {
    loggingOutRef.current = true;
    if (reloginTimerRef.current) {
      clearTimeout(reloginTimerRef.current);
      reloginTimerRef.current = null;
    }
    clearCredentials();
    setReconnecting(false);
    try {
      // ESCOPO LOCAL, NUNCA O PADRÃO (o mesmo cuidado do painel, em `useAuth.tsx`).
      // `signOut()` sem opções usa `scope: 'global'` e revoga TODAS as sessões da conta:
      // sair aqui derrubaria o painel do lojista no navegador e os outros PCs da loja.
      // Sair deste app é sair DESTE computador — a credencial salva já foi apagada acima.
      await supabase.auth.signOut({ scope: 'local' });
    } catch (err) {
      console.warn('Falha ao sair da conta:', err);
    }
    // Zera o estado local; o onAuthStateChange também refletirá o SIGNED_OUT.
    seenOrderIdsRef.current = new Set();
    printedOrderIdsRef.current = new Set();
    printedViasRef.current = new Map();
    baselineDoneRef.current = false;
    setNewOrders([]);
    setInProgressOrders([]);
    setSelectedOrder(null);
    setLastOrderInfo(null);
    setShowSettings(false);
    setStore(null);
    setIsAuthenticated(false);
  };

  // Render error if config is missing
  if (!supabaseUrl || !supabaseKey) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6 text-center">
        <div className="bg-gray-800 p-8 rounded-xl max-w-md border border-red-500/30">
          <h1 className="text-2xl font-bold text-red-500 mb-4">Erro de Configuração</h1>
          <p className="text-gray-300 mb-6">
            As variáveis de ambiente <b>VITE_SUPABASE_URL</b> e <b>VITE_SUPABASE_ANON_KEY</b> não foram configuradas no arquivo .env
          </p>
          <div className="bg-black/30 p-4 rounded text-left font-mono text-xs text-orange-400 mb-6">
            Verifique o arquivo .env do aplicativo desktop.
          </div>
          <button 
            onClick={() => window.location.reload()}
            className="bg-orange-600 hover:bg-orange-700 text-white font-bold py-2 px-6 rounded-lg transition-colors"
          >
            Tentar Novamente
          </button>
        </div>
      </div>
    );
  }

  // Enquanto verificamos a sessão salva, evita piscar a tela de login.
  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-gray-400">
          <RefreshCw className="w-8 h-8 text-orange-500 animate-spin" />
          <span className="text-sm">Conectando…</span>
        </div>
      </div>
    );
  }

  // Relogin automático em curso: a conta NÃO saiu, só caiu. Mostrar a tela de login aqui
  // faria a equipe achar que precisa digitar a senha — e, pior, esconderia que o app está
  // se recuperando sozinho.
  if (!isAuthenticated && reconnecting) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 text-center text-gray-400">
          <RefreshCw className="w-8 h-8 text-orange-500 animate-spin" />
          <span className="text-sm">Reconectando à sua conta…</span>
          <span className="max-w-xs text-xs text-gray-500">
            A conexão caiu e o app está entrando de novo sozinho. Não precisa fazer nada.
          </span>
        </div>
      </div>
    );
  }

  // Render login if not authenticated
  if (!isAuthenticated) {
    return <LoginScreen onLogin={handleLogin} error={error} />;
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-orange-500">KyberFood</h1>
            <span className="text-gray-400">|</span>
            <span className="text-gray-300">{store?.name}</span>

            {/* Versão SEMPRE visível e clicável. Antes o app não dizia em que versão
                estava, então não havia como conferir se um ajuste recente já tinha
                chegado — e a checagem só acontecia em silêncio, sem confirmar nada. */}
            <button
              type="button"
              onClick={() => checkForUpdate(true)}
              disabled={updateCheck.state === 'checking' || updateCheck.state === 'installing'}
              title="Clique para verificar se há atualização do app"
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:cursor-wait ${
                updateCheck.state === 'up-to-date'
                  ? 'border-green-600 bg-green-600/20 text-green-300'
                  : updateCheck.state === 'error'
                    ? 'border-yellow-600 bg-yellow-600/20 text-yellow-300'
                    : updateInfo && !updateDismissed
                      ? 'border-orange-600 bg-orange-600/20 text-orange-300'
                      : 'border-gray-600 bg-gray-700/50 text-gray-300 hover:border-gray-500 hover:text-white'
              }`}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  updateCheck.state === 'checking' || updateCheck.state === 'installing' ? 'animate-spin' : ''
                }`}
              />
              {/* "Instalando" precisa aparecer: o app vai REINICIAR sozinho em seguida, e
                  uma janela que some sem explicação parece travamento. */}
              {updateCheck.state === 'installing'
                ? 'Instalando a atualização…'
                : updateCheck.state === 'checking'
                ? 'Verificando…'
                : updateCheck.state === 'up-to-date'
                  ? `v${appVersion} · atualizado`
                  : updateCheck.state === 'error'
                    ? 'Não consegui verificar'
                    : updateInfo
                      ? `v${appVersion} · atualização disponível`
                      : `v${appVersion || '—'}`}
            </button>
          </div>
          
          <div className="flex items-center gap-4">
            {/* Selo da trava de presença. Fica SEMPRE visível: o app aberto é o que
                mantém a IA atendendo no WhatsApp, então o lojista precisa enxergar essa
                relação na tela onde ele opera — e não descobrir pelo silêncio. */}
            <div
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium border ${
                heartbeatFailing
                  ? 'bg-yellow-600/20 border-yellow-600 text-yellow-300'
                  : aiServing
                    ? 'bg-green-600/20 border-green-600 text-green-300'
                    : 'bg-red-600/20 border-red-600 text-red-300'
              }`}
              title={
                heartbeatFailing
                  ? 'Sem conexão com o servidor. Se não voltar em alguns minutos, a IA para de atender.'
                  : aiServing
                    ? 'A IA está atendendo os clientes no WhatsApp enquanto este app estiver aberto.'
                    : 'A IA NÃO está atendendo: mantenha este app aberto e conectado.'
              }
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  heartbeatFailing ? 'bg-yellow-400' : aiServing ? 'bg-green-400' : 'bg-red-400'
                }`}
              />
              {heartbeatFailing ? 'Sem conexão' : aiServing ? 'IA atendendo' : 'IA parada'}
            </div>

            {/* Update available (optional) */}
            {updateInfo && !updateDismissed && (
              <div className="flex items-center gap-1 bg-orange-600/20 border border-orange-600 rounded-full pl-3 pr-1 py-1">
                <button
                  onClick={handleUpdateClick}
                  className="flex items-center gap-2 text-orange-300 hover:text-orange-200 font-medium text-sm"
                  title={updateInfo.notes || `Baixar a versão ${updateInfo.version}`}
                >
                  <Download className="w-4 h-4" />
                  Atualizar ({updateInfo.version})
                </button>
                <button
                  onClick={() => setUpdateDismissed(true)}
                  className="p-1 hover:bg-orange-600/30 rounded-full"
                  title="Agora não"
                >
                  <X className="w-3.5 h-3.5 text-orange-300" />
                </button>
              </div>
            )}

            {/* Fila de novos pedidos + atualizar: só na UI de gerência (oculta). */}
            {SHOW_ORDER_MANAGEMENT && newOrders.length > 0 && (
              <div className="flex items-center gap-2 bg-red-600 px-3 py-1 rounded-full animate-pulse">
                <Bell className="w-4 h-4" />
                <span className="font-bold">{newOrders.length} Novo(s)</span>
              </div>
            )}
            {SHOW_ORDER_MANAGEMENT && (
              <button
                onClick={() => syncFromServer(store!.id)}
                className="p-2 hover:bg-gray-700 rounded-lg"
                title="Atualizar"
              >
                <RefreshCw className="w-5 h-5" />
              </button>
            )}

            {/* Settings button */}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 hover:bg-gray-700 rounded-lg"
              title="Configurações"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Aviso de impressão (o app fica na bandeja; erro só no console passa batido) */}
      {printError && (
        <div className="bg-red-900/60 border-b border-red-500 text-red-200 px-6 py-2 flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Printer className="w-4 h-4" />
            {printError}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setPrintError(null); setShowSettings(true); }}
              className="bg-red-600 hover:bg-red-700 text-white font-medium px-3 py-1 rounded-lg"
            >
              Abrir Configurações
            </button>
            <button
              onClick={() => setPrintError(null)}
              className="p-1 hover:bg-red-800 rounded-full"
              title="Fechar aviso"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Aviso ao mudar status (rede/conflito/Saipos) — o botão não some em silêncio */}
      {actionError && (
        <div className="bg-amber-900/60 border-b border-amber-500 text-amber-100 px-6 py-2 flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            {actionError}
          </span>
          <button
            onClick={() => setActionError(null)}
            className="p-1 hover:bg-amber-800 rounded-full"
            title="Fechar aviso"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!SHOW_ORDER_MANAGEMENT && (
        <StatusPanel
          store={store!}
          settings={settings}
          lastOrderInfo={lastOrderInfo}
          onOpenSettings={() => setShowSettings(true)}
          onLogout={handleLogout}
        />
      )}

      {SHOW_ORDER_MANAGEMENT && (
      <main className="flex h-[calc(100vh-73px)]">
        {/* New Orders Queue */}
        <div className="w-96 bg-gray-800 border-r border-gray-700 overflow-y-auto">
          <div className="p-4 border-b border-gray-700">
            <h2 className="font-bold text-lg flex items-center gap-2">
              <Bell className="w-5 h-5 text-red-500" />
              Novos Pedidos ({newOrders.length})
            </h2>
          </div>
          
          <div className="p-4 space-y-4">
            {newOrders.map(order => (
              <OrderCard
                key={order.id}
                order={order}
                isNew
                onSelect={() => setSelectedOrder(order)}
                onPrint={() => printOrder(order, { copies: 1 })}
                onAccept={() => updateOrderStatus(order.id, 'confirmed')}
                onReject={() => updateOrderStatus(order.id, 'cancelled')}
              />
            ))}
            
            {newOrders.length === 0 && (
              <div className="text-center text-gray-500 py-8">
                <Bell className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>Nenhum pedido novo</p>
              </div>
            )}
          </div>
        </div>

        {/* Order Details */}
        <div className="flex-1 overflow-y-auto">
          {selectedOrder ? (
            <OrderDetails 
              order={selectedOrder} 
              onPrint={() => printOrder(selectedOrder, { copies: 1 })}
              onUpdateStatus={(status) => updateOrderStatus(selectedOrder.id, status)}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <ShoppingCart className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p>Selecione um pedido para ver detalhes</p>
              </div>
            </div>
          )}
        </div>

        {/* In Progress Orders */}
        <div className="w-80 bg-gray-800 border-l border-gray-700 overflow-y-auto">
          <div className="p-4 border-b border-gray-700">
            <h2 className="font-bold text-lg">Em Andamento ({inProgressOrders.length})</h2>
          </div>
          
          <div className="p-4 space-y-2">
            {inProgressOrders.map(order => (
              <div
                key={order.id}
                onClick={() => setSelectedOrder(order)}
                className={`p-3 rounded-lg cursor-pointer transition-colors ${
                  selectedOrder?.id === order.id 
                    ? 'bg-orange-600' 
                    : 'bg-gray-700 hover:bg-gray-600'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-bold">#{orderDisplayNumber(order)}</p>
                    <p className="text-sm text-gray-300">{order.customer_name}</p>
                  </div>
                  <StatusBadge status={order.status} />
                </div>
                <div className="flex justify-between mt-2 text-sm">
                  <span className="text-gray-400">
                    <Clock className="w-3 h-3 inline mr-1" />
                    {new Date(order.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="font-bold">R$ {order.total.toFixed(2)}</span>
                </div>
                {/* Reimprime a comanda direto, sem precisar abrir os detalhes. */}
                <button
                  onClick={(e) => { e.stopPropagation(); printOrder(order, { copies: 1 }); }}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 bg-gray-800 hover:bg-gray-900 text-gray-200 text-xs font-medium py-1.5 rounded-md border border-gray-600 transition-colors"
                  title="Reimprimir comanda"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Reimprimir
                </button>
              </div>
            ))}
            
            {inProgressOrders.length === 0 && (
              <div className="text-center text-gray-500 py-8">
                <Clock className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>Nenhum pedido em andamento</p>
              </div>
            )}
          </div>
        </div>
      </main>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          store={store!}
          onClose={() => setShowSettings(false)}
          onSave={setSettings}
          onLogout={handleLogout}
        />
      )}
    </div>
  );
}

// Painel de status (modo atual do app: só recebe pedidos, imprime e toca o som).
// Sem gerência/visualização de pedidos — isso é feito no site do KyberFood.
function StatusPanel({
  store,
  settings,
  lastOrderInfo,
  onOpenSettings,
  onLogout,
}: {
  store: Store;
  settings: Settings;
  lastOrderInfo: { number: string; at: number; printed: boolean } | null;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const hasPrinter = !!settings.selectedPrinter;
  return (
    <main className="flex flex-col items-center justify-center min-h-[calc(100vh-73px)] p-6">
      <div className="w-full max-w-md bg-gray-800 rounded-2xl border border-gray-700 p-8 text-center">
        <div className="mx-auto w-16 h-16 rounded-full bg-green-600/20 flex items-center justify-center mb-4">
          <CheckCircle2 className="w-9 h-9 text-green-400" />
        </div>
        <h2 className="text-xl font-bold mb-1">Recebendo pedidos</h2>
        <p className="text-gray-400 text-sm mb-1">{store.name}</p>
        <p className="text-gray-500 text-xs mb-6">
          Novos pedidos são impressos automaticamente e tocam o som de notificação.
          Pode minimizar: o app continua ativo na bandeja. A gestão dos pedidos é feita no site.
        </p>

        {/* Impressora selecionada (ou aviso para configurar) */}
        <div
          className={`rounded-lg px-4 py-3 mb-3 flex items-center justify-between text-sm ${
            hasPrinter ? 'bg-gray-700/60' : 'bg-red-900/40 border border-red-500/50'
          }`}
        >
          <span className="flex items-center gap-2">
            <Printer className="w-4 h-4" />
            {hasPrinter ? 'Impressora' : 'Selecione uma impressora'}
          </span>
          <span className={hasPrinter ? 'text-gray-200 font-medium truncate max-w-[180px]' : 'text-red-300'}>
            {hasPrinter ? settings.selectedPrinter : '—'}
          </span>
        </div>

        {/* Resumo: som + auto-impressão */}
        <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
          <div className="rounded-lg bg-gray-700/60 px-3 py-2 flex items-center justify-center gap-2">
            {settings.soundEnabled ? (
              <Volume2 className="w-4 h-4 text-green-400" />
            ) : (
              <VolumeX className="w-4 h-4 text-gray-500" />
            )}
            Som {settings.soundEnabled ? 'ligado' : 'desligado'}
          </div>
          <div className="rounded-lg bg-gray-700/60 px-3 py-2 flex items-center justify-center gap-2">
            <Printer className={`w-4 h-4 ${settings.autoPrint ? 'text-green-400' : 'text-gray-500'}`} />
            Auto {settings.autoPrint ? 'ligado' : 'desligado'}
          </div>
        </div>

        {/* Última atividade (confirma que o app está recebendo/imprimindo) */}
        {lastOrderInfo && (
          <p className="text-xs text-gray-500 mb-6">
            Último pedido: <span className="text-gray-300 font-medium">#{lastOrderInfo.number}</span> às{' '}
            {new Date(lastOrderInfo.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{' '}
            {lastOrderInfo.printed ? '(impresso)' : '(auto-impressão desligada)'}
          </p>
        )}

        <button
          onClick={onOpenSettings}
          className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-2.5 rounded-lg mb-3 flex items-center justify-center gap-2"
        >
          <Settings className="w-4 h-4" />
          Impressão e Som
        </button>
        <button
          onClick={onLogout}
          className="w-full bg-gray-700 hover:bg-gray-600 text-gray-200 py-2 rounded-lg flex items-center justify-center gap-2 text-sm"
        >
          <LogOut className="w-4 h-4" />
          Sair da conta
        </button>
      </div>
    </main>
  );
}

// Login Screen Component
function LoginScreen({ onLogin, error }: { onLogin: (email: string, password: string) => void; error: string | null }) {
  // Abre com o último login já digitado: quem saiu (ou perdeu a sessão) volta clicando
  // UMA vez em Entrar. O inicializador é preguiçoso — ler o localStorage a cada render
  // seria trabalho repetido e, pior, sobrescreveria o que o lojista estivesse digitando.
  const [prefill] = useState(loadLoginPrefill);
  const [email, setEmail] = useState(() => prefill?.email ?? '');
  const [password, setPassword] = useState(() => prefill?.password ?? '');

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="bg-gray-800 p-8 rounded-xl w-96">
        <h1 className="text-2xl font-bold text-center mb-6 text-orange-500">KyberFood Desktop</h1>
        
        {error && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 p-3 rounded-lg mb-4">
            {error}
          </div>
        )}
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-orange-500 focus:outline-none"
            />
          </div>
          
          <div>
            <label className="block text-sm text-gray-400 mb-1">Senha</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-orange-500 focus:outline-none"
            />
          </div>
          
          <button
            onClick={() => onLogin(email, password)}
            className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-2 rounded-lg transition-colors"
          >
            Entrar
          </button>
        </div>
      </div>
    </div>
  );
}

// Order Card Component
function OrderCard({ 
  order, 
  isNew,
  onSelect, 
  onPrint, 
  onAccept, 
  onReject 
}: { 
  order: Order; 
  isNew: boolean;
  onSelect: () => void;
  onPrint: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div 
      className={`bg-gray-700 rounded-lg p-4 cursor-pointer hover:bg-gray-600 transition-colors ${
        isNew ? 'ring-2 ring-red-500' : ''
      }`}
      onClick={onSelect}
    >
      <div className="flex justify-between items-start mb-2">
        <div>
          <p className="font-bold text-lg">#{orderDisplayNumber(order)}</p>
          <p className="text-gray-300">{order.customer_name}</p>
        </div>
        <span className="text-gray-400 text-sm">
          {new Date(order.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-3">
        <Phone className="w-3 h-3" />
        <span>{order.customer_phone}</span>
      </div>
      
      <div className="flex items-start gap-2 text-sm text-gray-400 mb-3">
        <MapPin className="w-3 h-3 mt-1" />
        <span>{order.delivery_address}</span>
      </div>
      
      <div className="border-t border-gray-600 pt-3 mt-3">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-400">Itens:</span>
          <span>{order.items?.length || 0}</span>
        </div>
        <div className="flex justify-between font-bold">
          <span>Total:</span>
          <span className="text-green-400">R$ {order.total.toFixed(2)}</span>
        </div>
      </div>
      
      <div className="flex gap-2 mt-4">
        <button
          onClick={(e) => { e.stopPropagation(); onPrint(); }}
          className="flex-1 bg-gray-600 hover:bg-gray-500 py-2 rounded-lg flex items-center justify-center gap-1"
        >
          <Printer className="w-4 h-4" />
          Imprimir
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onAccept(); }}
          className="flex-1 bg-green-600 hover:bg-green-700 py-2 rounded-lg flex items-center justify-center gap-1"
        >
          <Check className="w-4 h-4" />
          Aceitar
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onReject(); }}
          className="bg-red-600 hover:bg-red-700 py-2 px-3 rounded-lg"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// Order Details Component
function OrderDetails({ 
  order, 
  onPrint,
  onUpdateStatus 
}: { 
  order: Order; 
  onPrint: () => void;
  onUpdateStatus: (status: string) => void;
}) {
  return (
    <div className="p-6">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-2xl font-bold">Pedido #{orderDisplayNumber(order)}</h2>
          <p className="text-gray-400">
            {new Date(order.created_at).toLocaleString('pt-BR')}
          </p>
        </div>
        <StatusBadge status={order.status} large />
      </div>

      {/* TIPO DO PEDIDO em destaque, como na comanda impressa: a equipe olha a tela e o
          papel, e nos dois o tipo precisa ser a primeira coisa que salta aos olhos. */}
      <div
        className={`rounded-lg p-3 mb-4 text-center text-xl font-bold tracking-wide ${
          isPickupOrder(order) ? 'bg-amber-600 text-white' : 'bg-blue-700 text-white'
        }`}
      >
        {isPickupOrder(order) ? 'RETIRADA NO BALCÃO' : 'ENTREGA'}
      </div>
      
      {/* Customer Info */}
      <div className="bg-gray-800 rounded-lg p-4 mb-4">
        <h3 className="font-bold mb-3 flex items-center gap-2">
          <User className="w-4 h-4" />
          Cliente
        </h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-gray-400">Nome</p>
            <p className="font-medium">{order.customer_name}</p>
          </div>
          <div>
            <p className="text-gray-400">Telefone</p>
            <p className="font-medium">{order.customer_phone}</p>
          </div>
        </div>
      </div>
      
      {/* Endereço só na ENTREGA: em pedido de retirada ele é o da PRÓPRIA LOJA. */}
      {!isPickupOrder(order) && (
        <div className="bg-gray-800 rounded-lg p-4 mb-4">
          <h3 className="font-bold mb-3 flex items-center gap-2">
            <MapPin className="w-4 h-4" />
            Endereço de Entrega
          </h3>
          <p>{order.delivery_address}</p>
          <p className="text-gray-400 text-sm">{order.delivery_neighborhood}</p>
        </div>
      )}
      
      {/* Items */}
      <div className="bg-gray-800 rounded-lg p-4 mb-4">
        <h3 className="font-bold mb-3 flex items-center gap-2">
          <ShoppingCart className="w-4 h-4" />
          Itens
        </h3>
        <div className="space-y-3">
          {order.items?.map((item, index) => (
            <div key={index} className="flex justify-between items-start">
              <div>
                <p className="font-medium">{item.quantity}x {item.product_name}{receiptSizeLabel(item.size_name) ? ` (${receiptSizeLabel(item.size_name)})` : ''}</p>
                {/* Complementos pagos (borda, adicionais): a cozinha precisa vê-los.
                    Sabores de pizza ganham a fração correspondente (1/2, 1/3...). */}
                {(() => {
                  const flavorCount = countFlavors(item.complements);
                  return (item.complements || []).map((comp, compIndex) => {
                    const compName = String(comp?.name || '').trim();
                    if (!compName) return null;
                    const compPrice = Number(comp?.price) || 0;
                    return (
                      <p key={compIndex} className="text-sm text-gray-300">
                        {isFlavorComplement(comp) ? '- ' : '+ '}{flavorFractionPrefix(comp, flavorCount)}{compName}{!isFlavorComplement(comp) && compPrice > 0 ? ` (${formatReceiptMoney(compPrice)})` : ''}
                      </p>
                    );
                  });
                })()}
                {/* Observação do item em destaque: é instrução de produção, não detalhe. */}
                {item.notes && (
                  <p className="text-base font-bold text-amber-300">&gt;&gt; OBS: {item.notes}</p>
                )}
              </div>
              <p className="text-green-400">{item.is_gift ? 'BRINDE' : formatReceiptMoney(item.subtotal)}</p>
            </div>
          ))}
        </div>
        
        {/* OBSERVAÇÃO DO PEDIDO logo abaixo dos itens (antes ficava no fim da tela, depois
            do pagamento) e em destaque — mesma ordem da comanda impressa. */}
        {order.notes && (
          <div className="mt-4 rounded-lg border-2 border-amber-500 bg-amber-950/40 p-3">
            <p className="text-sm font-bold text-amber-400 mb-1">OBSERVAÇÃO DO PEDIDO</p>
            <p className="text-lg font-bold text-amber-200">{order.notes}</p>
          </div>
        )}

        <div className="border-t border-gray-700 mt-4 pt-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Subtotal</span>
            <span>{formatReceiptMoney(order.subtotal)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Entrega</span>
            <span>{formatReceiptMoney(order.delivery_fee)}</span>
          </div>
          <div className="flex justify-between font-bold text-lg">
            <span>Total</span>
            <span className="text-green-400">{formatReceiptMoney(order.total)}</span>
          </div>
        </div>
      </div>
      
      {/* Payment */}
      <div className="bg-gray-800 rounded-lg p-4 mb-4">
        <h3 className="font-bold mb-3">Pagamento</h3>
        <div className="flex justify-between items-center">
          <span className="uppercase">{formatOrderPayments(order)}</span>
          <span className={`px-2 py-1 rounded text-sm ${
            order.payment_status === 'paid' 
              ? 'bg-green-900 text-green-300' 
              : 'bg-yellow-900 text-yellow-300'
          }`}>
            {order.payment_status === 'paid' ? 'Pago ✓' : 'Pendente'}
          </span>
        </div>
      </div>
      
      {/* Actions */}
      <div className="flex gap-4">
        <button
          onClick={onPrint}
          className="flex-1 bg-gray-700 hover:bg-gray-600 py-3 rounded-lg flex items-center justify-center gap-2"
        >
          <Printer className="w-5 h-5" />
          Imprimir Comanda
        </button>
        
        {order.status === 'ai_attention' && (
          <>
            <button
              onClick={() => onUpdateStatus('confirmed')}
              className="flex-1 bg-green-600 hover:bg-green-700 py-3 rounded-lg flex items-center justify-center gap-2"
            >
              <Check className="w-5 h-5" />
              Aceitar
            </button>
            <button
              onClick={() => onUpdateStatus('cancelled')}
              className="bg-red-600 hover:bg-red-700 py-3 px-4 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </>
        )}
        
        {order.status === 'confirmed' && (
          <button
            onClick={() => onUpdateStatus('preparing')}
            className="flex-1 bg-blue-600 hover:bg-blue-700 py-3 rounded-lg"
          >
            Iniciar Preparo
          </button>
        )}
        
        {order.status === 'preparing' && (
          <button
            onClick={() => onUpdateStatus('delivering')}
            className="flex-1 bg-purple-600 hover:bg-purple-700 py-3 rounded-lg"
          >
            Saiu para Entrega
          </button>
        )}
        
        {order.status === 'delivering' && (
          <button
            onClick={() => onUpdateStatus('completed')}
            className="flex-1 bg-green-600 hover:bg-green-700 py-3 rounded-lg"
          >
            Entregue
          </button>
        )}
      </div>
    </div>
  );
}

// Status Badge Component
function StatusBadge({ status, large }: { status: string; large?: boolean }) {
  const statusConfig: Record<string, { label: string; color: string }> = {
    ai_attention: { label: 'Novo', color: 'bg-red-600' },
    confirmed: { label: 'Confirmado', color: 'bg-blue-600' },
    preparing: { label: 'Preparando', color: 'bg-yellow-600' },
    delivering: { label: 'Entregando', color: 'bg-purple-600' },
    completed: { label: 'Entregue', color: 'bg-green-600' },
    cancelled: { label: 'Cancelado', color: 'bg-gray-600' },
  };

  const config = statusConfig[status] || { label: status, color: 'bg-gray-600' };

  return (
    <span className={`${config.color} px-2 py-1 rounded text-sm ${large ? 'text-base px-3 py-1' : ''}`}>
      {config.label}
    </span>
  );
}

// Settings Modal Component
function SettingsModal({
  settings,
  store,
  onClose,
  onSave,
  onLogout,
}: {
  settings: Settings;
  store: Store;
  onClose: () => void;
  onSave: (settings: Settings) => void;
  onLogout: () => void;
}) {
  const [localSettings, setLocalSettings] = useState(settings);
  const [systemPrinters, setSystemPrinters] = useState<{name: string, is_default: boolean}[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);

  useEffect(() => {
    const fetchPrinters = async () => {
      setLoadingPrinters(true);
      try {
        const printers = await invoke('get_printers') as any[];
        setSystemPrinters(printers);
        // If no printer selected yet, use default
        if (!localSettings.selectedPrinter && printers.length > 0) {
          const def = printers.find(p => p.is_default) || printers[0];
          setLocalSettings(s => ({ ...s, selectedPrinter: def.name }));
        }
      } catch (err) {
        console.error('Error fetching printers:', err);
      } finally {
        setLoadingPrinters(false);
      }
    };
    fetchPrinters();
  }, []);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl p-6 w-[450px]">
        <h2 className="text-xl font-bold mb-6">Configurações</h2>
        
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {localSettings.soundEnabled ? (
                <Volume2 className="w-5 h-5" />
              ) : (
                <VolumeX className="w-5 h-5 text-gray-500" />
              )}
              <span>Som de Notificação</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => playNotificationSound()}
                className="text-xs px-2 py-1 rounded-md border border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors"
                title="Tocar o alarme de novo pedido para conferir o volume"
              >
                Testar
              </button>
              <button
                onClick={() => setLocalSettings(s => ({ ...s, soundEnabled: !s.soundEnabled }))}
                className={`w-12 h-6 rounded-full transition-colors relative ${
                  localSettings.soundEnabled ? 'bg-orange-600' : 'bg-gray-600'
                }`}
              >
                <div className={`w-5 h-5 bg-white rounded-full transition-transform absolute top-0.5 ${
                  localSettings.soundEnabled ? 'translate-x-6' : 'translate-x-0.5'
                }`} />
              </button>
            </div>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Printer className="w-5 h-5" />
              <span>Auto-Imprimir Pedidos</span>
            </div>
            <button
              onClick={() => setLocalSettings(s => ({ ...s, autoPrint: !s.autoPrint }))}
              className={`w-12 h-6 rounded-full transition-colors relative ${
                localSettings.autoPrint ? 'bg-orange-600' : 'bg-gray-600'
              }`}
            >
              <div className={`w-5 h-5 bg-white rounded-full transition-transform absolute top-0.5 ${
                localSettings.autoPrint ? 'translate-x-6' : 'translate-x-0.5'
              }`} />
            </button>
          </div>

          <div className="border-t border-gray-700 pt-4">
            <label className="block text-sm text-gray-400 mb-2 font-medium">Impressora do Sistema</label>
            <div className="flex gap-2">
              <select
                value={localSettings.selectedPrinter}
                onChange={(e) => setLocalSettings(s => ({ ...s, selectedPrinter: e.target.value }))}
                className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:border-orange-500 focus:outline-none"
                disabled={loadingPrinters}
              >
                <option value="">Selecione uma impressora</option>
                {systemPrinters.map(p => (
                  <option key={p.name} value={p.name}>{p.name}{p.is_default ? ' (Padrão)' : ''}</option>
                ))}
              </select>
              <button 
                onClick={() => invoke('test_printer', { printerName: localSettings.selectedPrinter || null })}
                className="bg-gray-700 hover:bg-gray-600 p-2 rounded-lg border border-gray-600"
                title="Imprimir Teste"
              >
                <RefreshCw className={`w-5 h-5 ${loadingPrinters ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {systemPrinters.length === 0 && !loadingPrinters && (
              <p className="text-xs text-red-400 mt-1">Nenhuma impressora encontrada no Windows.</p>
            )}
          </div>

          <div className="border-t border-gray-700 pt-4">
            <p className="text-xs text-gray-400">
              O <span className="text-gray-300 font-medium">tamanho do papel</span>, a{' '}
              <span className="text-gray-300 font-medium">fonte</span> e{' '}
              <span className="text-gray-300 font-medium">quais informações</span> aparecem na comanda
              são definidos no painel KyberFood, em <span className="text-gray-300 font-medium">Integrações → Configurar impressão</span>.
            </p>
          </div>
        </div>
        
        {/* Conta conectada + logout. O login é persistente: fechar/reabrir o app
            mantém a conta; o usuário só sai clicando aqui. */}
        <div className="border-t border-gray-700 mt-6 pt-4 flex items-center justify-between">
          <div className="text-sm">
            <p className="text-gray-500 text-xs">Conta conectada</p>
            <p className="text-gray-200 font-medium">{store.name}</p>
          </div>
          <button
            onClick={onLogout}
            className="flex items-center gap-2 text-sm text-red-300 hover:text-red-200 border border-red-500/40 hover:border-red-500 px-3 py-2 rounded-lg"
            title="Sair da conta"
          >
            <LogOut className="w-4 h-4" />
            Sair da conta
          </button>
        </div>

        <div className="flex gap-3 mt-6 pt-6 border-t border-gray-700">
          <button
            onClick={onClose}
            className="flex-1 bg-gray-700 hover:bg-gray-600 py-2.5 rounded-lg font-medium"
          >
            Cancelar
          </button>
          <button
            onClick={() => { onSave(localSettings); onClose(); }}
            className="flex-1 bg-orange-600 hover:bg-orange-700 py-2.5 rounded-lg font-bold"
          >
            Salvar Alterações
          </button>
        </div>
      </div>
    </div>
  );
}

// Rótulo do TIPO do pedido, impresso EM DESTAQUE no topo da comanda.
// ESPELHA PICKUP_RECEIPT_LABEL / DELIVERY_RECEIPT_LABEL de src/lib/order-pickup.ts no web.
const PICKUP_RECEIPT_LABEL = '*** RETIRADA ***';
const DELIVERY_RECEIPT_LABEL = '*** ENTREGA ***';

// Marca de DESTAQUE de uma linha (negrito + altura dupla na térmica). Caractere de
// CONTROLE de propósito: `stripControlChars` roda ANTES de ela ser aplicada, então nada
// vindo do pedido (nome, observação do cliente) consegue forjar negrito.
// ESPELHA RECEIPT_EMPHASIS_PREFIX do web e EMPHASIS_PREFIX (0x02) do src-tauri/src/main.rs.
const RECEIPT_EMPHASIS_PREFIX = '\u0002';

// ESPELHAM os rótulos de mesmo nome em src/lib/desktop-print-config.ts.
const ORDER_NOTES_RECEIPT_LABEL = '*** OBSERVACAO DO PEDIDO ***';
const ITEM_NOTE_RECEIPT_PREFIX = '  >> OBS: ';

/** Uma linha da comanda. `emphasis` sai em negrito e altura dupla na impressora. */
interface ReceiptLine {
  text: string;
  emphasis?: boolean;
}

// ESPELHA GIFT_RECEIPT_LABEL de src/lib/order-gifts.ts no app web. Item de cortesia sai com
// este rótulo no lugar do preço: "R$ 0.00" na comanda a cozinha lê como erro de sistema.
const GIFT_RECEIPT_LABEL = '*** BRINDE ***';

// Retirada no balcão. ESPELHA isPickupOrder de src/lib/order-pickup.ts (projetos separados,
// não há import entre eles): flag explícita gravada na criação e, para os pedidos antigos,
// o rótulo no endereço (pedido manual) ou no início das observações (pedido da IA).
function isPickupOrder(order: Pick<Order, 'delivery_address' | 'notes' | 'metadata'>): boolean {
  const flag = String(order.metadata?.order_type || '').trim().toLowerCase();
  if (flag === 'pickup') return true;
  if (flag === 'delivery') return false;
  const pickupText = /^\s*retirada no balc[aã]o/i;
  return pickupText.test(String(order.delivery_address || '')) || pickupText.test(String(order.notes || ''));
}

// Sabores da pizza chegam como complementos do grupo "Sabores". Quando há mais de
// um, cada sabor representa uma fração da pizza (1/2, 1/3...), o que deixa claro na
// comanda e pra cozinha quanto de cada sabor a pizza leva.
function isFlavorComplement(comp?: { groupName?: string | null } | null): boolean {
  return String(comp?.groupName || '').toLowerCase().includes('sabor');
}

// Conta quantos sabores o item tem, para calcular a fração (1/N) de cada um.
function countFlavors(complements?: Array<{ groupName?: string | null }> | null): number {
  return (complements || []).filter(isFlavorComplement).length;
}

// Prefixo de fração de um sabor quando a pizza tem 2+ sabores (ex.: "1/2 ").
function flavorFractionPrefix(comp: { groupName?: string | null }, flavorCount: number): string {
  return flavorCount >= 2 && isFlavorComplement(comp) ? `1/${flavorCount} ` : '';
}

// Troca caracteres de controle por espaço. ESPELHA stripControlChars de
// src/lib/sanitize-text.ts no app web (projetos separados, não há import entre eles).
// Comparação numérica de propósito: escrever esses caracteres numa classe de regex
// deixaria bytes de controle literais no código-fonte.
function stripControlChars(value: unknown): string {
  const text = String(value ?? '');
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += isControl ? ' ' : ch;
  }
  return out;
}

// Quebra um texto livre (observação escrita pelo cliente) em linhas que cabem no papel.
// ESPELHA wrapText de src/lib/desktop-print-config.ts.
function wrapText(text: string, width: number, firstPrefix = '', contPrefix = firstPrefix): string[] {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const out: string[] = [];
  let prefix = firstPrefix;
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && (prefix + candidate).length > width) {
      out.push(prefix + current);
      prefix = contPrefix;
      current = word;
    } else {
      current = candidate;
    }
  }
  out.push(prefix + current);
  return out;
}

// Um BLOCO do documento da comanda. O documento é montado uma vez (buildReceiptLayout) e
// serve aos dois modos: o TEXTO o achata em linhas de largura fixa (layoutToLines) e o
// GRÁFICO o manda ao Rust, que o desenha como imagem (src-tauri/src/receipt_raster.rs).
// ESPELHA ReceiptBlock de src/lib/desktop-print-config.ts e Block do receipt_raster.rs.
type ReceiptBlock =
  // `wrap`: quebra em várias linhas no modo TEXTO. Só observação e endereço da loja; texto
  // do CLIENTE (nome) fica numa linha só — quebrado, um nome forjado criaria uma linha
  // "STATUS: PAGO" solta (trava anti-forja do web, sanitize-text.test.ts).
  | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; strong?: boolean; big?: boolean; indent?: number; wrap?: boolean }
  | { kind: 'row'; left: string; right: string; strong?: boolean; indent?: number }
  | { kind: 'rule'; double?: boolean }
  | { kind: 'space' };

const INDENT_TEXT = '  ';

// Achata o documento em linhas de largura fixa — o formato do modo TEXTO, o mesmo que a
// comanda sempre teve. O `space` NÃO vira linha em branco (cada linha é bobina gasta).
// ESPELHA layoutToLines de src/lib/desktop-print-config.ts.
function layoutToLines(blocks: ReceiptBlock[], width: number): ReceiptLine[] {
  const rule = (char: string) => char.repeat(width);
  const center = (text: string) => {
    const t = text.slice(0, width);
    const spaces = Math.max(0, Math.floor((width - t.length) / 2));
    return ' '.repeat(spaces) + t;
  };
  const rightAlign = (text: string) => ' '.repeat(Math.max(0, width - text.length)) + text;

  const lines: ReceiptLine[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'rule':
        lines.push({ text: rule(block.double ? '=' : '-') });
        break;
      case 'space':
        break;
      case 'text': {
        const emphasis = Boolean(block.strong || block.big);
        const prefix = INDENT_TEXT.repeat(block.indent || 0);
        const wrapped = block.wrap ? wrapText(block.text, width, prefix, prefix + '   ') : [prefix + block.text];
        if (wrapped.length === 0) wrapped.push('');
        for (const raw of wrapped) {
          const text = block.align === 'center' ? center(raw.trim()) : block.align === 'right' ? rightAlign(raw.trim()) : raw;
          lines.push(emphasis ? { text, emphasis: true } : { text });
        }
        break;
      }
      case 'row': {
        const emphasis = Boolean(block.strong);
        const prefix = INDENT_TEXT.repeat(block.indent || 0);
        const left = prefix + block.left;
        const right = block.right;
        const mark = (text: string): ReceiptLine => (emphasis ? { text, emphasis: true } : { text });
        if (left.length + right.length + 1 <= width) {
          lines.push(mark(`${left}${' '.repeat(width - left.length - right.length)}${right}`));
        } else {
          wrapText(block.left, width, prefix, prefix + '   ').forEach((l) => lines.push(mark(l)));
          lines.push(mark(rightAlign(right)));
        }
        break;
      }
    }
  }
  return lines;
}

// Monta o DOCUMENTO da comanda (blocos). ESPELHA buildReceiptLayout de
// src/lib/desktop-print-config.ts do app web, para que a pré-visualização mostrada no
// painel seja fiel à impressão real.
//
// O que sai e o que NÃO sai vem de duas rodadas com lojistas, foto da comanda em mãos:
// Q Sabor (22/08/2026) — TIPO do pedido em cima e OBSERVAÇÃO logo abaixo dos itens;
// Disk Pizzaiolo (04/09/2026) — cai a descrição do tamanho ("35cm, 8 fatias"), cai o
// preço repetido no sabor, produto e sabor em MAIÚSCULAS, dinheiro com vírgula, telefone
// formatado. Pagamento, troco, desconto e entrega ficaram como estavam.
function buildReceiptLayout(order: Order, store: Store, config: PrintConfig): ReceiptBlock[] {
  const blocks: ReceiptBlock[] = [];
  const text = (block: Omit<Extract<ReceiptBlock, { kind: 'text' }>, 'kind'>) => blocks.push({ kind: 'text', ...block });
  const row = (block: Omit<Extract<ReceiptBlock, { kind: 'row' }>, 'kind'>) => blocks.push({ kind: 'row', ...block });
  const rule = (double = false) => blocks.push({ kind: 'rule', double });
  const space = () => blocks.push({ kind: 'space' });

  const pickup = isPickupOrder(order);
  const money = formatReceiptMoney;

  text({ text: store.name.toUpperCase(), align: 'center', strong: true });
  if (config.showStoreAddress && store.address) text({ text: store.address, align: 'center', wrap: true });
  rule(true);
  // TIPO DO PEDIDO, EM CIMA E EM DESTAQUE. Antes a retirada só aparecia no MEIO da ficha,
  // no lugar do endereço, e a entrega não aparecia em lugar nenhum.
  text({ text: pickup ? PICKUP_RECEIPT_LABEL : DELIVERY_RECEIPT_LABEL, align: 'center', strong: true, big: true });
  rule(true);
  const orderLabel = `PEDIDO #${orderDisplayNumber(order)}`;
  if (config.showDateTime) row({ left: orderLabel, right: formatOrderDateTime(order.created_at, store.timezone), strong: true });
  else text({ text: orderLabel, strong: true });
  if (order.scheduled_at) text({ text: `AGENDADO P/: ${formatOrderDateTime(order.scheduled_at, store.timezone)}`, strong: true });
  rule();
  text({ text: `CLIENTE: ${receiptCustomerName(order.customer_name)}` });
  if (config.showCustomerPhone && order.customer_phone) text({ text: `FONE: ${formatReceiptPhone(order.customer_phone)}` });
  // Retirada não imprime endereço: o endereço de um pedido de retirada é o da PRÓPRIA LOJA
  // e a comanda saía como se houvesse entrega a fazer. Quem diz o tipo é o marcador do topo,
  // que ignora showDeliveryAddress de propósito — é o TIPO do pedido, não o endereço.
  if (!pickup) {
    if (config.showDeliveryAddress && order.delivery_address) text({ text: `END: ${order.delivery_address}` });
    if (config.showDeliveryAddress && order.delivery_neighborhood) text({ text: `BAIRRO: ${order.delivery_neighborhood}` });
  }
  rule();
  text({ text: 'ITENS:' });

  (order.items || []).forEach((item, index) => {
    if (index > 0) space();
    const size = receiptSizeLabel(item.size_name);
    const itemLine = `${item.quantity}x ${String(item.product_name || '').toUpperCase()}${size ? ` (${size})` : ''}`;
    // CORTESIA sai com o rótulo, nunca com "R$ 0,00".
    row({ left: itemLine, right: item.is_gift ? GIFT_RECEIPT_LABEL : money(item.subtotal), strong: true });
    // Sabor de pizza sai com a fração (1/2, 1/3...) e SEM preço — o valor já está no item.
    // Adicional pago (borda, extra) mantém o valor.
    const flavorCount = countFlavors(item.complements);
    (item.complements || []).forEach((comp) => {
      const compName = String(comp?.name || '').trim().toUpperCase();
      if (!compName) return;
      const compPrice = Number(comp?.price) || 0;
      if (isFlavorComplement(comp)) {
        text({ text: `- ${flavorFractionPrefix(comp, flavorCount)}${compName}`, indent: 1 });
      } else if (compPrice > 0) {
        row({ left: `+ ${compName}`, right: money(compPrice), indent: 1 });
      } else {
        text({ text: `+ ${compName}`, indent: 1 });
      }
    });
    // Observação do ITEM em destaque, colada no produto a que pertence.
    if (config.showItemNotes && item.notes) text({ text: `${ITEM_NOTE_RECEIPT_PREFIX.trim()} ${item.notes}`, indent: 1, strong: true, wrap: true });
  });

  // OBSERVAÇÃO DO PEDIDO logo abaixo dos ITENS e em destaque: é instrução de PRODUÇÃO.
  if (config.showOrderNotes && order.notes) {
    rule();
    text({ text: ORDER_NOTES_RECEIPT_LABEL, strong: true });
    text({ text: String(order.notes), strong: true, wrap: true });
  }

  rule();
  row({ left: 'Subtotal', right: money(order.subtotal) });
  row({ left: 'Entrega', right: money(order.delivery_fee) });
  if (order.discount_amount && order.discount_amount > 0) {
    const cupom = order.coupon_code ? ` (${order.coupon_code})` : '';
    row({ left: `Desconto${cupom}`, right: money(-order.discount_amount) });
  }
  if (order.increase_amount && order.increase_amount > 0) {
    row({ left: 'Acrescimo', right: `+${money(order.increase_amount)}` });
  }
  text({ text: `TOTAL: ${money(order.total)}`, align: 'right', strong: true, big: true });
  rule(true);

  if (config.showPayment && (order.payment_method || order.metadata?.saipos?.payment_types?.length)) {
    text({ text: `PAGAMENTO: ${formatOrderPayments(order)}`, strong: true, wrap: true });
    text({ text: `STATUS: ${order.payment_status === 'paid' ? 'PAGO' : 'PENDENTE'}` });
  }

  if (config.footerText.trim()) {
    rule(true);
    text({ text: config.footerText.trim(), align: 'center' });
  }

  // TRAVA ANTI-FORJA: nenhum campo do pedido cria LINHA NOVA nem destaque na comanda (a
  // marca do modo texto é um caractere de controle aplicado DEPOIS desta limpeza, em
  // encodeReceiptText).
  return blocks.map((block) => {
    if (block.kind === 'text') return { ...block, text: stripControlChars(block.text) };
    if (block.kind === 'row') return { ...block, left: stripControlChars(block.left), right: stripControlChars(block.right) };
    return block;
  });
}

// Serializa o documento para o Rust desenhar no modo GRÁFICO (print_receipt_graphic).
// ESPELHA encodeReceiptLayout do app web.
function encodeReceiptLayout(blocks: ReceiptBlock[]): string {
  return JSON.stringify({ blocks });
}

// A comanda linha a linha, no formato do modo TEXTO — derivada do documento de blocos.
// ESPELHA buildReceiptDoc do app web.
function buildReceiptDoc(order: Order, store: Store, config: PrintConfig): ReceiptLine[] {
  return layoutToLines(buildReceiptLayout(order, store, config), config.paperWidth);
}

// Serializa a comanda para o comando de impressão: uma linha por linha, com as destacadas
// prefixadas pela marca de controle que o Rust converte em ESC/POS.
// ESPELHA encodeReceiptText do app web.
function encodeReceiptText(doc: ReceiptLine[]): string {
  return doc.map((l) => (l.emphasis ? RECEIPT_EMPHASIS_PREFIX + l.text : l.text)).join('\n');
}

// Escapa strings vindas do pedido (nome do cliente, observações etc.) antes de
// interpolar no HTML — evita injeção de HTML/script na comanda de fallback.
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Generate Receipt HTML — usado quando a impressão nativa falha. Mesmas regras de
// conteúdo da comanda (tamanho limpo, sabor sem preço, dinheiro com vírgula).
function generateReceiptHtml(order: Order, store: Store): string {
  const lines: string[] = [];

  lines.push(`<div style="text-align: center; font-weight: bold; font-size: 14px;">${escapeHtml(store.name)}</div>`);
  lines.push(`<div style="text-align: center; font-size: 10px;">${escapeHtml(store.address || '')}</div>`);
  lines.push('<hr>');
  lines.push(
    `<div style="text-align: center; font-weight: bold; font-size: 16px;">` +
      `${escapeHtml(isPickupOrder(order) ? PICKUP_RECEIPT_LABEL : DELIVERY_RECEIPT_LABEL)}</div>`,
  );
  lines.push('<hr>');
  lines.push(`<div><strong>PEDIDO #${escapeHtml(orderDisplayNumber(order))}</strong></div>`);
  lines.push(`<div>${escapeHtml(formatOrderDateTime(order.created_at, store.timezone))}</div>`);
  lines.push('<hr>');
  lines.push(`<div>CLIENTE: ${escapeHtml(receiptCustomerName(order.customer_name))}</div>`);
  lines.push(`<div>FONE: ${escapeHtml(formatReceiptPhone(order.customer_phone))}</div>`);
  // Retirada não imprime endereço (é o da própria loja) — quem diz o tipo é o marcador
  // em destaque no TOPO, montado logo acima.
  if (!isPickupOrder(order)) {
    lines.push(`<div>END: ${escapeHtml(order.delivery_address)}</div>`);
  }
  lines.push('<hr>');
  lines.push('<div><strong>ITENS:</strong></div>');

  order.items?.forEach(item => {
    const size = receiptSizeLabel(item.size_name);
    const sizeText = size ? ` (${size})` : '';
    const priceText = item.is_gift ? GIFT_RECEIPT_LABEL : formatReceiptMoney(item.subtotal);
    lines.push(`<div><strong>${item.quantity}x ${escapeHtml(`${String(item.product_name || '').toUpperCase()}${sizeText}`)}</strong> - ${escapeHtml(priceText)}</div>`);
    // Sabor de pizza com a fração (1/2, 1/3...) e SEM preço; adicional pago com o valor.
    const flavorCount = countFlavors(item.complements);
    (item.complements || []).forEach((comp) => {
      const compName = String(comp?.name || '').trim().toUpperCase();
      if (!compName) return;
      const compPrice = Number(comp?.price) || 0;
      const label = `${flavorFractionPrefix(comp, flavorCount)}${compName}`;
      const compText = isFlavorComplement(comp)
        ? `- ${label}`
        : compPrice > 0 ? `+ ${label} (${formatReceiptMoney(compPrice)})` : `+ ${label}`;
      lines.push(`<div style="font-size: 10px; margin-left: 10px;">${escapeHtml(compText)}</div>`);
    });
    if (item.notes) {
      lines.push(
        `<div style="font-size: 14px; font-weight: bold; margin-left: 10px;">` +
          `&gt;&gt; OBS: ${escapeHtml(item.notes)}</div>`,
      );
    }
  });

  // OBSERVAÇÃO DO PEDIDO logo abaixo dos itens, em destaque (antes ia para o rodapé).
  if (order.notes) {
    lines.push('<hr>');
    lines.push(`<div style="font-weight: bold;">${escapeHtml(ORDER_NOTES_RECEIPT_LABEL)}</div>`);
    lines.push(`<div style="font-size: 15px; font-weight: bold;">${escapeHtml(order.notes)}</div>`);
  }

  lines.push('<hr>');
  lines.push(`<div style="text-align: right;">Subtotal: ${formatReceiptMoney(order.subtotal)}</div>`);
  lines.push(`<div style="text-align: right;">Entrega: ${formatReceiptMoney(order.delivery_fee)}</div>`);
  lines.push(`<div style="text-align: right; font-weight: bold; font-size: 14px;">TOTAL: ${formatReceiptMoney(order.total)}</div>`);
  lines.push('<hr>');
  lines.push(`<div>PAGAMENTO: ${escapeHtml(formatOrderPayments(order))} ${order.payment_status === 'paid' ? '✓' : ''}</div>`);

  lines.push('<hr>');
  lines.push('<div style="text-align: center;">OBRIGADO!</div>');
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page { size: 58mm auto; margin: 0; }
    body { font-family: monospace; font-size: 11px; padding: 5px; }
    hr { border: none; border-top: 1px dashed #000; margin: 5px 0; }
  </style>
</head>
<body>${lines.join('')}</body>
</html>
`;
}

export default App;
