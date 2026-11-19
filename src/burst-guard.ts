/**
 * Travas contra RAJADA dos laços do app (puro, sem Tauri nem Supabase: testado no monorepo,
 * em `src/lib/desktop-burst-guard.test.ts`).
 *
 * A folga mínima entre duas rodadas (5 s no heartbeat, 3 s na varredura) não basta: ela só
 * conta quando a rodada COMEÇA. Se a rodada fica presa esperando o token (sem internet, a
 * renovação da sessão segura todas as chamadas atrás da mesma trava do supabase-js), cada
 * tique começa uma rodada nova que também fica presa — e, quando a internet volta, todas
 * saem de uma vez. Por isso cada laço roda UM DE CADA VEZ (`createLoopGate`) e a espera pelo
 * token tem PRAZO (`withDeadline`): passado o prazo, a rodada desiste sem enviar nada.
 */

/** Uma rodada por vez: `tryEnter` falso = a anterior ainda não acabou, pule este tique. */
export function createLoopGate(): { tryEnter(): boolean; leave(): void; busy(): boolean } {
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

export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: passou do prazo de ${ms} ms`);
    this.name = 'DeadlineError';
  }
}

/**
 * A promessa, ou erro depois de `ms`. A promessa original continua viva: quem a usa precisa
 * garantir que o resultado atrasado não vire requisição (ver `getAuthHeaders` no App.tsx).
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Chamadas simultâneas dividem a MESMA promessa em andamento, em vez de cada uma abrir a sua.
 * Acabou (bem ou mal), a próxima chamada começa outra.
 */
export function shareInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = fn().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
