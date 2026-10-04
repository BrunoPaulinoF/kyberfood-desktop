/** Etiqueta colorida com o status do pedido. */
export function StatusBadge({ status, large }: { status: string; large?: boolean }) {
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
