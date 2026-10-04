/** Cartão de pedido novo na fila (tela de gestão de pedidos do app). */
import { Printer, Check, X, MapPin, Phone } from 'lucide-react';
import type { Order } from '../App';
import { orderDisplayNumber } from '../order-display';

export function OrderCard({ 
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
