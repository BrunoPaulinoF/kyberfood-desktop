// Número curto do pedido exibido na comanda/telas (4 últimos dígitos do telefone, com
// sufixo -2, -3 em colisão no mesmo dia). Gravado pelo web app em orders.order_number;
// pedidos antigos ficam sem e caem no fallback dos 8 primeiros caracteres do UUID.
// Espelha formatOrderNumber() de src/lib/order-number.ts no web app.
export function orderDisplayNumber(order: { order_number?: string | null; id: string }): string {
  const stored = order.order_number;
  if (stored && String(stored).trim()) return String(stored).trim();
  return String(order.id ?? '').slice(0, 8).toUpperCase();
}
