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
import { getVersion } from '@tauri-apps/api/app';
import { open as openExternal } from '@tauri-apps/api/shell';

// Manifesto publicado pelo GitHub Actions a cada build do app desktop.
// O app o consulta para saber se há uma versão mais nova (atualização opcional).
const UPDATE_MANIFEST_URL = 'https://github.com/BrunoPaulinoF/kyberfood-desktop/releases/latest/download/latest.json';
const FALLBACK_DOWNLOAD_URL = 'https://github.com/BrunoPaulinoF/kyberfood-desktop/releases/latest/download/KyberFood-Setup.exe';

interface UpdateInfo {
  version: string;
  url: string;
  notes?: string;
}

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

interface PrintConfig {
  fontSize: PrintFontSize;
  paperWidth: 32 | 48; // 32 = 58mm, 48 = 80mm
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
  // 80mm (48 colunas) é o padrão do mercado das impressoras térmicas.
  paperWidth: 48,
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

function normalizePrintConfig(value: any): PrintConfig {
  const raw = value && typeof value === 'object' ? value : {};
  const fontSize: PrintFontSize = raw.fontSize === 'small' || raw.fontSize === 'large' ? raw.fontSize : 'normal';
  // Padrão 80mm (48); só cai para 58mm quando a loja escolheu 32 explicitamente.
  const paperWidth: 32 | 48 = Number(raw.paperWidth) === 32 ? 32 : 48;
  const bool = (v: any, fallback: boolean) => (v === undefined ? fallback : Boolean(v));
  return {
    fontSize,
    paperWidth,
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
        const amountText = showAmount ? ` R$ ${(Number(p.amount) || 0).toFixed(2)}` : '';
        const changeFor = Number(p.change_for) || 0;
        const changeText = changeFor > 0 ? ` (troco p/ R$ ${changeFor.toFixed(2)})` : '';
        return `${name}${complementText}${amountText}${changeText}`;
      })
      .join(' + ');
  }
  const orderChangeFor = Number(order.change_for) || 0;
  const orderChangeText = orderChangeFor > 0 ? ` (troco p/ R$ ${orderChangeFor.toFixed(2)})` : '';
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

const SETTINGS_STORAGE_KEY = 'kyberfood.desktop.settings';
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
  // Linha de base: na 1ª sincronização após o login NÃO alertamos os pedidos que
  // já existiam; só os que chegarem depois disparam som/impressão.
  const baselineDoneRef = useRef(false);
  // Ref sempre apontando para o printOrder mais recente, para o polling (memoizado)
  // imprimir sem capturar um closure antigo.
  const printOrderRef = useRef<(order: Order) => void>(() => {});
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

  // Verifica se há uma versão mais nova do app publicada. A atualização é
  // opcional: só exibimos um botão; o usuário atualiza quando quiser.
  useEffect(() => {
    let cancelled = false;

    const checkForUpdate = async () => {
      try {
        const currentVersion = await getVersion();
        // Reaproveitado no heartbeat: saber qual versão está em cada loja ajuda a
        // diagnosticar uma presença que não aparece.
        if (!cancelled) setAppVersion(currentVersion);
        const res = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const manifest = await res.json();
        const latest = String(manifest?.version ?? '').trim();
        if (!latest) return;

        if (!cancelled && compareVersions(latest, currentVersion) > 0) {
          setUpdateInfo({
            version: latest,
            url: String(manifest?.url_win || FALLBACK_DOWNLOAD_URL),
            notes: manifest?.notes ? String(manifest.notes) : undefined,
          });
        }
      } catch (err) {
        // Sem internet ou release ainda não publicada: ignora silenciosamente.
        console.warn('Falha ao verificar atualização:', err);
      }
    };

    checkForUpdate();
    // Reverifica a cada 6 horas enquanto o app estiver aberto.
    const interval = setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleUpdateClick = async () => {
    if (!updateInfo) return;
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
    } catch {
      /* ignora falha de storage */
    }
  }, [settings]);

  // Heartbeat: avisa o servidor que o app está online e busca a configuração de impressão
  // atual definida pelo lojista.
  //
  // Este heartbeat NÃO é mais só cosmético: é ele que mantém a IA atendendo no WhatsApp
  // (o servidor considera a loja offline após ~5 batidas perdidas). Por isso ele tem
  // retentativa curta em caso de falha e volta a bater assim que a máquina acorda ou a
  // rede retorna — e por isso o resultado vira um selo visível na tela.
  useEffect(() => {
    if (!isAuthenticated || !store) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const sendHeartbeat = async (attempt = 0) => {
      if (cancelled) return;
      try {
        const res = await fetch(
          `${apiUrl}/api/desktop/heartbeat?storeId=${store.id}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
            body: JSON.stringify({ device_id: getDeviceId(), app_version: appVersion || null }),
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (cancelled) return;
        if (data?.print_config) setPrintConfig(normalizePrintConfig(data.print_config));
        setAiServing(data?.ai_gate?.ai_serving !== false);
        setHeartbeatFailing(false);
      } catch (err) {
        console.warn('Falha no heartbeat do desktop:', err);
        if (cancelled) return;
        // Backoff curto (10s, 20s): três chances dentro do minuto da próxima batida, para
        // que um soluço de rede não derrube a IA por engano.
        if (attempt < 2) {
          retryTimer = setTimeout(() => sendHeartbeat(attempt + 1), (attempt + 1) * 10_000);
        } else {
          setHeartbeatFailing(true);
        }
      }
    };

    const beatNow = () => sendHeartbeat();

    beatNow();
    // A cada 60s: mantém o status "conectado" e sincroniza a config de impressão.
    const interval = setInterval(beatNow, 60 * 1000);
    // Voltar de suspensão do PC ou de queda de rede: bate na hora em vez de esperar o
    // próximo tick — é justamente o momento em que a IA está parada esperando o app.
    window.addEventListener('online', beatNow);
    window.addEventListener('focus', beatNow);
    document.addEventListener('visibilitychange', beatNow);

    return () => {
      cancelled = true;
      clearInterval(interval);
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

    const isConfirmedOrBeyond = ['confirmed', 'preparing', 'delivering'].includes(order.status);

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
    let printed = false;
    if (isConfirmedOrBeyond && settingsRef.current.autoPrint && !printedOrderIdsRef.current.has(order.id)) {
      printedOrderIdsRef.current.add(order.id);
      printOrderRef.current(order);
      printed = true;
    }

    if (firstSighting || printed) {
      setLastOrderInfo({ number: orderDisplayNumber(order), at: Date.now(), printed });
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
      const response = await fetch(`${apiUrl}/api/orders?storeId=${storeId}`, {
        headers: await getAuthHeaders(),
      });
      const data = await response.json();
      if (!data?.orders) return;
      const all = data.orders as Order[];
      const queue = all.filter(o => o.status === 'ai_attention');
      const inProgress = all.filter(o => ['confirmed', 'preparing', 'delivering'].includes(o.status));
      const active = [...queue, ...inProgress];

      if (!baselineDoneRef.current) {
        // Linha de base: não re-alertar/reimprimir o que já existia ao abrir o app
        // — EXCETO pedidos PIX online ainda aguardando pagamento (ficam de fora
        // para tocar/imprimir normalmente quando o PIX cair). Pedidos ainda em
        // 'ai_attention' entram só no dedup de ALERTA: quando forem confirmados
        // depois de o app abrir, a comanda ainda deve sair — então NÃO os marcamos
        // como impressos aqui (só os que já estão confirmados/em produção).
        active.forEach(o => {
          if (isAwaitingOnlinePixPayment(o)) return;
          seenOrderIdsRef.current.add(o.id);
          if (['confirmed', 'preparing', 'delivering'].includes(o.status)) {
            printedOrderIdsRef.current.add(o.id);
          }
        });
        baselineDoneRef.current = true;
      } else {
        // Reprocessa todos os ativos na ordem de chegada; o dedup interno (alerta
        // e impressão separados) garante que cada ação ocorra 1x. Sem pré-filtro
        // por "visto": um pedido que já alertou em 'ai_attention' precisa ser
        // reavaliado para imprimir quando chegar em CONFIRMADO.
        active
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          .forEach(o => processIncomingOrder(o));
      }

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
    printedOrderIdsRef.current = new Set();
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

  // Request notification permission
  useEffect(() => {
    if (window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Print order
  const printOrder = async (order: Order) => {
    // Sem impressora configurada não há para onde imprimir: o app vive na
    // bandeja, então o diálogo do window.open(...).print() nunca seria visto.
    // Mostra um aviso e deixa o pedido disponível para reimpressão manual.
    const printerName = settingsRef.current.selectedPrinter;
    if (!printerName) {
      setPrintError('Nenhuma impressora configurada — abra Configurações');
      return;
    }
    try {
      // Generate plain text receipt for thermal printer (respeita a config do lojista)
      const cfg = printConfigRef.current;
      const receiptText = buildReceiptLines(order, store!, cfg).join('\n') + '\n\n\n';

      // Invoke Rust print command
      await invoke('print_receipt', {
        printerName,
        content: receiptText,
        width: cfg.paperWidth,
        fontSize: FONT_SIZE_PT[cfg.fontSize],
      });

      setPrintError(null);
      console.log('Order printed successfully');
    } catch (err) {
      console.error('Error printing order:', err);
      setPrintError(`Falha ao imprimir na impressora "${printerName}" — verifique a impressora e reimprima`);
      // Fallback to browser printing if it fails
      const receiptHtml = generateReceiptHtml(order, store!);
      const printWindow = window.open('', '_blank', 'width=400,height=600');
      if (printWindow) {
        printWindow.document.write(receiptHtml);
        printWindow.document.close();
        printWindow.print();
        setTimeout(() => printWindow.close(), 1000);
      }
    }
  };

  // Mantém o ref de impressão apontando para o printOrder atual, para o polling
  // (memoizado) imprimir sempre com as configurações/loja mais recentes.
  useEffect(() => { printOrderRef.current = printOrder; });

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
      const response = await fetch(`${apiUrl}/api/orders/${orderId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) },
        body: JSON.stringify({ status }),
      });

      if (response.ok) {
        syncFromServer(store!.id);
        return;
      }

      let data: any = null;
      try { data = await response.json(); } catch { /* corpo não-JSON (ex.: 502 de gateway) */ }

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
  const loadStoreForUser = useCallback(async (userId: string): Promise<Store | null> => {
    const { data: storeData } = await supabase
      .from('stores')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return (storeData as Store) ?? null;
  }, []);

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
  }, [loadStoreForUser]);

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
        setStore(storeData);
        setIsAuthenticated(true);
        setError(null);
      } else {
        setError('Nenhuma loja encontrada para este usuário');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Logout EXPLÍCITO (botão dentro do app). O login é persistente por padrão:
  // fechar pela bandeja e reabrir mantém a conta conectada (a sessão fica salva
  // e o token renova sozinho). O usuário só sai da conta clicando aqui.
  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('Falha ao sair da conta:', err);
    }
    // Zera o estado local; o onAuthStateChange também refletirá o SIGNED_OUT.
    seenOrderIdsRef.current = new Set();
    printedOrderIdsRef.current = new Set();
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
                onPrint={() => printOrder(order)}
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
              onPrint={() => printOrder(selectedOrder)}
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
                  onClick={(e) => { e.stopPropagation(); printOrder(order); }}
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

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
      
      {/* Delivery Address */}
      <div className="bg-gray-800 rounded-lg p-4 mb-4">
        <h3 className="font-bold mb-3 flex items-center gap-2">
          <MapPin className="w-4 h-4" />
          Endereço de Entrega
        </h3>
        <p>{order.delivery_address}</p>
        <p className="text-gray-400 text-sm">{order.delivery_neighborhood}</p>
      </div>
      
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
                <p className="font-medium">{item.quantity}x {item.product_name}{item.size_name ? ` (${item.size_name})` : ''}</p>
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
                        + {flavorFractionPrefix(comp, flavorCount)}{compName}{compPrice > 0 ? ` (R$ ${compPrice.toFixed(2)})` : ''}
                      </p>
                    );
                  });
                })()}
                {item.notes && (
                  <p className="text-sm text-gray-400">Obs: {item.notes}</p>
                )}
              </div>
              <p className="text-green-400">R$ {item.subtotal.toFixed(2)}</p>
            </div>
          ))}
        </div>
        
        <div className="border-t border-gray-700 mt-4 pt-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Subtotal</span>
            <span>R$ {order.subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Entrega</span>
            <span>R$ {order.delivery_fee.toFixed(2)}</span>
          </div>
          <div className="flex justify-between font-bold text-lg">
            <span>Total</span>
            <span className="text-green-400">R$ {order.total.toFixed(2)}</span>
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
      
      {/* Notes */}
      {order.notes && (
        <div className="bg-gray-800 rounded-lg p-4 mb-4">
          <h3 className="font-bold mb-2">Observações</h3>
          <p className="text-gray-300">{order.notes}</p>
        </div>
      )}
      
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

// Monta as linhas da comanda respeitando a configuração de impressão do lojista.
// ESPELHA src/lib/desktop-print-config.ts (buildReceiptLines) do app web, para
// que a pré-visualização mostrada no painel seja fiel à impressão real.
function buildReceiptLines(order: Order, store: Store, config: PrintConfig): string[] {
  const width = config.paperWidth;
  const line = (char = '-') => char.repeat(width);
  const center = (text: string) => {
    const t = text.slice(0, width);
    const spaces = Math.max(0, Math.floor((width - t.length) / 2));
    return ' '.repeat(spaces) + t;
  };
  const rightAlign = (text: string) => ' '.repeat(Math.max(0, width - text.length)) + text;

  const lines: string[] = [];
  lines.push(center(store.name.toUpperCase()));
  if (config.showStoreAddress && store.address) lines.push(center(store.address));
  lines.push(line('='));
  lines.push(`PEDIDO: #${orderDisplayNumber(order)}`);
  if (config.showDateTime) lines.push(formatOrderDateTime(order.created_at, store.timezone));
  if (order.scheduled_at) lines.push(`AGENDADO P/: ${formatOrderDateTime(order.scheduled_at, store.timezone)}`);
  lines.push(line());
  lines.push(`CLIENTE: ${order.customer_name}`);
  if (config.showCustomerPhone && order.customer_phone) lines.push(`FONE: ${order.customer_phone}`);
  if (config.showDeliveryAddress && order.delivery_address) lines.push(`END: ${order.delivery_address}`);
  if (config.showDeliveryAddress && order.delivery_neighborhood) lines.push(`BAIRRO: ${order.delivery_neighborhood}`);
  lines.push(line('-'));
  lines.push('ITENS:');

  order.items?.forEach(item => {
    const itemLine = `${item.quantity}x ${item.product_name}${item.size_name ? ` (${item.size_name})` : ''}`;
    const priceLine = `R$ ${item.subtotal.toFixed(2)}`;
    if (itemLine.length + priceLine.length + 1 <= width) {
      lines.push(`${itemLine}${' '.repeat(width - itemLine.length - priceLine.length)}${priceLine}`);
    } else {
      lines.push(itemLine);
      lines.push(rightAlign(priceLine));
    }
    // Complementos pagos (borda, adicionais): a cozinha PRECISA vê-los.
    // Sabores de pizza ganham a fração correspondente (1/2, 1/3...).
    const flavorCount = countFlavors(item.complements);
    (item.complements || []).forEach((comp) => {
      const compName = String(comp?.name || '').trim();
      if (!compName) return;
      const compPrice = Number(comp?.price) || 0;
      const label = `${flavorFractionPrefix(comp, flavorCount)}${compName}`;
      lines.push(compPrice > 0 ? `  + ${label} (R$ ${compPrice.toFixed(2)})` : `  + ${label}`);
    });
    if (config.showItemNotes && item.notes) lines.push(`  Obs: ${item.notes}`);
  });

  lines.push(line());
  lines.push(rightAlign(`Subtotal: R$ ${order.subtotal.toFixed(2)}`));
  lines.push(rightAlign(`Entrega: R$ ${order.delivery_fee.toFixed(2)}`));
  if (order.discount_amount && order.discount_amount > 0) {
    const cupom = order.coupon_code ? ` (${order.coupon_code})` : '';
    lines.push(rightAlign(`Desconto${cupom}: -R$ ${order.discount_amount.toFixed(2)}`));
  }
  if (order.increase_amount && order.increase_amount > 0) {
    lines.push(rightAlign(`Acrescimo: +R$ ${order.increase_amount.toFixed(2)}`));
  }
  lines.push(rightAlign(`TOTAL: R$ ${order.total.toFixed(2)}`));
  lines.push(line('='));

  if (config.showPayment && (order.payment_method || order.metadata?.saipos?.payment_types?.length)) {
    lines.push(`PAGAMENTO: ${formatOrderPayments(order)}`);
    lines.push(`STATUS: ${order.payment_status === 'paid' ? 'PAGO' : 'PENDENTE'}`);
  }

  if (config.showOrderNotes && order.notes) {
    lines.push(line('-'));
    lines.push(`OBS: ${order.notes}`);
  }

  if (config.footerText.trim()) {
    lines.push(line('='));
    lines.push(center(config.footerText));
  }

  return lines;
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

// Generate Receipt HTML
function generateReceiptHtml(order: Order, store: Store): string {
  const lines: string[] = [];

  lines.push(`<div style="text-align: center; font-weight: bold; font-size: 14px;">${escapeHtml(store.name)}</div>`);
  lines.push(`<div style="text-align: center; font-size: 10px;">${escapeHtml(store.address || '')}</div>`);
  lines.push('<hr>');
  lines.push(`<div><strong>PEDIDO: #${escapeHtml(orderDisplayNumber(order))}</strong></div>`);
  lines.push(`<div>${escapeHtml(formatOrderDateTime(order.created_at, store.timezone))}</div>`);
  lines.push('<hr>');
  lines.push(`<div>CLIENTE: ${escapeHtml(order.customer_name)}</div>`);
  lines.push(`<div>FONE: ${escapeHtml(order.customer_phone)}</div>`);
  lines.push(`<div>END: ${escapeHtml(order.delivery_address)}</div>`);
  lines.push('<hr>');
  lines.push('<div><strong>ITENS:</strong></div>');

  order.items?.forEach(item => {
    const sizeText = item.size_name ? ` (${item.size_name})` : '';
    lines.push(`<div>${item.quantity}x ${escapeHtml(`${item.product_name}${sizeText}`)} - R$ ${item.subtotal.toFixed(2)}</div>`);
    // Complementos pagos (borda, adicionais): a cozinha PRECISA vê-los.
    // Sabores de pizza ganham a fração correspondente (1/2, 1/3...).
    const flavorCount = countFlavors(item.complements);
    (item.complements || []).forEach((comp) => {
      const compName = String(comp?.name || '').trim();
      if (!compName) return;
      const compPrice = Number(comp?.price) || 0;
      const label = `${flavorFractionPrefix(comp, flavorCount)}${compName}`;
      const compText = compPrice > 0 ? `+ ${label} (R$ ${compPrice.toFixed(2)})` : `+ ${label}`;
      lines.push(`<div style="font-size: 10px; margin-left: 10px;">${escapeHtml(compText)}</div>`);
    });
    if (item.notes) {
      lines.push(`<div style="font-size: 10px; margin-left: 10px;">Obs: ${escapeHtml(item.notes)}</div>`);
    }
  });

  lines.push('<hr>');
  lines.push(`<div style="text-align: right;">Subtotal: R$ ${order.subtotal.toFixed(2)}</div>`);
  lines.push(`<div style="text-align: right;">Entrega: R$ ${order.delivery_fee.toFixed(2)}</div>`);
  lines.push(`<div style="text-align: right; font-weight: bold; font-size: 14px;">TOTAL: R$ ${order.total.toFixed(2)}</div>`);
  lines.push('<hr>');
  lines.push(`<div>PAGAMENTO: ${escapeHtml(formatOrderPayments(order))} ${order.payment_status === 'paid' ? '✓' : ''}</div>`);

  if (order.notes) {
    lines.push(`<div>OBS: ${escapeHtml(order.notes)}</div>`);
  }
  
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
