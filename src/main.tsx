import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { restoreDeviceStateIfEmpty } from './device-state'

// Rede de segurança contra tela branca: qualquer erro não tratado durante a
// renderização passa a mostrar uma mensagem legível (com o erro real) em vez de
// deixar a janela do app completamente em branco, sem pista do que aconteceu.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Erro na interface do KyberFood Desktop:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: '#111827',
            color: '#e5e7eb',
            fontFamily: 'Inter, system-ui, sans-serif',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              maxWidth: 460,
              background: '#1f2937',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 12,
              padding: 32,
            }}
          >
            <h1 style={{ color: '#f87171', fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
              Ops, algo deu errado
            </h1>
            <p style={{ color: '#d1d5db', marginBottom: 20 }}>
              O aplicativo encontrou um erro ao iniciar. Tente novamente; se persistir,
              feche e abra o KyberFood.
            </p>
            <pre
              style={{
                background: 'rgba(0,0,0,0.3)',
                color: '#fb923c',
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                textAlign: 'left',
                whiteSpace: 'pre-wrap',
                marginBottom: 20,
              }}
            >
              {String(this.state.error?.message || this.state.error)}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#ea580c',
                color: '#fff',
                fontWeight: 700,
                padding: '8px 24px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function mount() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
}

// A restauração vem ANTES de montar: o App lê o localStorage de forma síncrona ao criar o
// estado (impressora, som) e ao decidir o relogin automático, então restaurar depois já
// seria tarde — a loja apareceria sem impressora e na tela de login por um instante, e a
// configuração recém-lida (vazia) seria regravada por cima da reserva.
//
// O `finally` é a trava: a reserva NUNCA pode impedir o app de abrir. Se a leitura falhar,
// o app sobe exatamente como sobe hoje.
restoreDeviceStateIfEmpty().catch(() => {}).finally(mount)
