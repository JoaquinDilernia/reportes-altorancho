// Módulo Ventas: listado de pedidos web con su origen y el recorrido de cada uno.
// Los pedidos y su atribución vienen de gineza; el tipo de cliente de Tienda Nube
// (si ya está calculado para el período) y el costo de Odoo, de Reportes.
import { fetchOrders, fetchOrder, fetchCustomerHistory, fetchSummary } from './gineza.mjs';
import { peekCustomerTypes, getCustomerTypes } from './customerType.mjs';
import { getCostBySku } from './odooCosts.mjs';
import { buildJourney } from './ventasJourney.mjs';
import { argDay } from './events.mjs';
import { getPeriodRanges } from './periods.mjs';

const PAYMENT = { paid: 'pagada', pending: 'pendiente', authorized: 'autorizada', abandoned: 'abandonada', refunded: 'devuelta', voided: 'anulada' };
export const statusOf = (payment, cancelled) => (cancelled ? 'cancelada' : PAYMENT[payment] || payment);

export function ventasRange({ period = 'week', date, start, end }) {
  return (period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period)).current;
}

export async function listVentas({ range, channel, q, cursor }, today = argDay(new Date().toISOString())) {
  const [page, summary] = await Promise.all([
    fetchOrders({ from: range.start, to: range.end, channel, q, cursor }),
    cursor ? null : fetchSummary(range.start, range.end).catch(() => null),
  ]);
  const types = peekCustomerTypes(range);
  // Si todavía no está, se calcula en segundo plano para la próxima página / recarga.
  if (!types) getCustomerTypes(range, today).catch(() => {});
  return {
    range,
    items: page.items.map((it) => ({
      id: it.id, number: it.number, createdAt: it.created_at, total: it.total, items: it.items_count,
      customerName: it.customer_name, status: statusOf(it.payment_status, it.cancelled),
      channel: it.channel, firstChannel: it.first_channel || null,
      campaign: it.campaign_name || null, ad: it.ad_name || null,
      customerType: types ? types.get(String(it.id)) || null : null,
    })),
    nextCursor: page.nextCursor,
    customerTypesReady: Boolean(types),
    summary: summary && {
      orders: summary.orders, revenue: summary.revenue, avgTicket: summary.avgTicket,
      channels: summary.channels,
    },
  };
}

export async function getVenta(id, today = argDay(new Date().toISOString())) {
  const order = await fetchOrder(id);
  const [history, costBySku] = await Promise.all([
    fetchCustomerHistory(order.customer_email, today).catch((err) => {
      console.error('[ventas] historial del cliente:', err.message);
      return null;
    }),
    getCostBySku().catch(() => new Map()),
  ]);
  // gineza busca el mail como texto (ILIKE): "ana@x.com" también trae a "juana@x.com". El nombre lo desempata.
  const sameName = (h) => !order.customer_name || !h.customer_name || h.customer_name.trim().toLowerCase() === order.customer_name.trim().toLowerCase();
  return buildJourney({ order, history: history ? history.filter(sameName) : null, costBySku });
}
