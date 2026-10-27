/**
 * RELÓGIO DO COMPUTADOR ERRADO: o sistema avisa o motivo, em vez de só "não funcionar".
 *
 * ESTE ARQUIVO TEM UMA CÓPIA IDÊNTICA em `kyberfood-desktop/src/clock-skew.ts` (o app
 * desktop é outro projeto, sem import daqui). `clock-skew.test.ts` exige as duas iguais
 * byte a byte — mudou um, copie para o outro. Por isso ele não importa NADA.
 *
 * O incidente (Q Sabor, 11/10/2026, 22:15–22:31 UTC): o computador da loja estava com a
 * data/hora errada. O login do Supabase confere o vencimento do token com o relógio LOCAL,
 * então com o relógio adiantado todo token parece vencido assim que chega: o painel e o app
 * desktop entraram num laço de renovar o token (434 renovações e 28 recusas por excesso de
 * tentativas em 16 minutos) e o lojista via só o sistema deslogando e carregando — sem
 * nenhuma palavra sobre a causa. Atrasado é o mesmo problema pelo outro lado: o computador
 * acha o token válido e o servidor recusa.
 *
 * A medida é a diferença entre o relógio do computador e o do NOSSO servidor
 * (`GET /api/time`), descontada metade do tempo de ida e volta.
 */

/** A partir daqui o relógio já atrapalha o login, e a diferença não é mais um descuido de segundos. */
export const CLOCK_SKEW_WARNING_MS = 5 * 60_000;

/** Ida e volta mais longa que isto não serve de régua: a incerteza passaria do próprio limiar. */
export const CLOCK_CHECK_MAX_ROUND_TRIP_MS = 15_000;

/** De quanto em quanto tempo a conferência é refeita com a tela aberta. */
export const CLOCK_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * Quanto o relógio do computador está à frente (positivo) ou atrás (negativo) do servidor.
 * `null` quando a medida não é confiável (resposta inválida, ida e volta longa demais, ou o
 * relógio local mudou no meio da requisição) — e aí NADA é afirmado.
 */
export function measureClockSkew(input: {
  sentAtMs: number;
  receivedAtMs: number;
  serverNowMs: unknown;
}): number | null {
  const server = input.serverNowMs;
  if (typeof server !== 'number' || !Number.isFinite(server) || server <= 0) return null;
  if (!Number.isFinite(input.sentAtMs) || !Number.isFinite(input.receivedAtMs)) return null;
  const roundTrip = input.receivedAtMs - input.sentAtMs;
  if (roundTrip < 0 || roundTrip > CLOCK_CHECK_MAX_ROUND_TRIP_MS) return null;
  return Math.round(input.sentAtMs + roundTrip / 2 - server);
}

/** "1 hora e 12 minutos", "3 dias", "8 minutos" — o tamanho do erro, em palavras. */
export function describeClockSkewAmount(skewMs: number): string {
  const totalMinutes = Math.max(1, Math.round(Math.abs(skewMs) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  if (days > 0) {
    return hours > 0 ? `${part(days, 'dia', 'dias')} e ${part(hours, 'hora', 'horas')}` : part(days, 'dia', 'dias');
  }
  if (hours > 0) {
    return minutes > 0 ? `${part(hours, 'hora', 'horas')} e ${part(minutes, 'minuto', 'minutos')}` : part(hours, 'hora', 'horas');
  }
  return part(minutes, 'minuto', 'minutos');
}

export interface ClockSkewNotice {
  /** `true` = o computador está à frente (adiantado). */
  ahead: boolean;
  title: string;
  /** O que está errado e o que isso causa. */
  detail: string;
  /** Como corrigir, em passos que a pessoa no balcão consegue seguir. */
  howToFix: string;
}

/** Data e hora certas, no horário de Brasília (é lá que as lojas estão). */
function formatBrasilia(ms: number): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms)).replace(',', ' às');
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * O aviso, ou `null` quando não há o que avisar (medida ausente ou erro abaixo do limiar).
 * `where` muda só a última frase: no painel é atualizar a página, no app é fechar e abrir.
 */
export function describeClockSkew(
  skewMs: number | null,
  localNowMs: number,
  where: 'panel' | 'app',
): ClockSkewNotice | null {
  if (skewMs === null || !Number.isFinite(skewMs) || Math.abs(skewMs) < CLOCK_SKEW_WARNING_MS) return null;

  const ahead = skewMs > 0;
  const amount = describeClockSkewAmount(skewMs);
  const realNow = formatBrasilia(localNowMs - skewMs);
  const restart = where === 'panel' ? 'Depois, atualize esta página.' : 'Depois, feche e abra o app de novo.';

  return {
    ahead,
    title: 'A data ou a hora deste computador está errada',
    detail:
      `O relógio do computador está ${amount} ${ahead ? 'adiantado' : 'atrasado'}. ` +
      `Agora são ${realNow} (horário de Brasília). ` +
      'Com o relógio errado, o sistema não consegue manter você conectado: ele pode sair sozinho da conta, ficar carregando ou não mostrar os pedidos.',
    howToFix:
      'Para corrigir no Windows: clique com o botão direito no relógio (canto de baixo da tela), ' +
      'escolha "Ajustar data e hora" e ligue "Definir horário automaticamente" e "Definir fuso horário automaticamente". ' +
      restart,
  };
}
