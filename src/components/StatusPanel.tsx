/**
 * Tela principal do app quando a gestão de pedidos está desligada (o normal em produção):
 * mostra que o app está recebendo pedidos, a impressora escolhida e os atalhos de
 * configuração e saída. Separada de `App.tsx` só para o arquivo principal ficar menor.
 */
import { Printer, Settings as SettingsIcon, Volume2, VolumeX, LogOut, CheckCircle2 } from 'lucide-react';
import type { Settings, Store } from '../App';

export function StatusPanel({
  store,
  settings,
  printingOffByPanel,
  lastOrderInfo,
  onOpenSettings,
  onLogout,
}: {
  store: Store;
  settings: Settings;
  /** A impressão automática foi desligada pelo painel (a comanda sai por outro sistema). */
  printingOffByPanel: boolean;
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
          {printingOffByPanel
            ? 'Novos pedidos tocam o som de notificação.'
            : 'Novos pedidos são impressos automaticamente e tocam o som de notificação.'}
          {' '}Pode minimizar: o app continua ativo na bandeja. A gestão dos pedidos é feita no site.
        </p>

        {/* Sem este aviso, quem está no balcão vê pedido entrando e papel nenhum saindo, e
            conclui que o app quebrou — e o "conserto" dele é religar o que foi desligado de
            propósito. Ele diz POR QUÊ e ONDE se religa. */}
        {printingOffByPanel && (
          <div className="rounded-lg px-4 py-3 mb-3 text-left text-sm bg-yellow-900/40 border border-yellow-500/50 text-yellow-100">
            <p className="font-semibold flex items-center gap-2">
              <Printer className="w-4 h-4" /> Impressão desligada pelo painel
            </p>
            <p className="text-xs text-yellow-200/80 mt-1">
              As comandas desta loja saem por outro sistema, então este app não imprime os
              pedidos. Para voltar a imprimir: no site, Integrações → Configurar impressão.
            </p>
          </div>
        )}

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
            <Printer className={`w-4 h-4 ${settings.autoPrint && !printingOffByPanel ? 'text-green-400' : 'text-gray-500'}`} />
            Auto {settings.autoPrint && !printingOffByPanel ? 'ligado' : 'desligado'}
          </div>
        </div>

        {/* Última atividade (confirma que o app está recebendo/imprimindo) */}
        {lastOrderInfo && (
          <p className="text-xs text-gray-500 mb-6">
            Último pedido: <span className="text-gray-300 font-medium">#{lastOrderInfo.number}</span> às{' '}
            {new Date(lastOrderInfo.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{' '}
            {lastOrderInfo.printed
              ? '(impresso)'
              : printingOffByPanel
                ? '(impressão desligada pelo painel)'
                : '(auto-impressão desligada)'}
          </p>
        )}

        <button
          onClick={onOpenSettings}
          className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-2.5 rounded-lg mb-3 flex items-center justify-center gap-2"
        >
          <SettingsIcon className="w-4 h-4" />
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
