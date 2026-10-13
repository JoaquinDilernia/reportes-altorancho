// Modelo de línea del POS: de dónde sale (origen) y cómo se entrega. Todo
// puro; la E/S vive en posOrders / posStock / posOdoo.
import { ORIGINS } from './posConfig.mjs';
export { isConfirming, shouldAutoRetry, CONFIRMING_MESSAGE, CONFIRM_CLAIM_MS } from './feriaLines.mjs';

export const DELIVERIES = ['ahora', 'retira_local', 'envio', 'retira_rolon', 'retira_otro_local'];
export const DELIVERY_LABELS = {
  ahora: 'Se lo lleva ahora', retira_local: 'Retira otro día en el local', envio: 'Envío a domicilio',
  retira_rolon: 'Retira en Rolón', retira_otro_local: 'Retira en otro local',
};
export const ORIGIN_LABELS = { stock: 'Stock del local', exhibicion: 'Exhibición', rolon: 'Rolón' };
// Mientras el pedido está en estos estados la app reserva su stock. Al
// confirmar, la reserva pasa a Odoo (remito reservado) y la de la app se libera.
export const RESERVING_ORDER_STATUSES = new Set(['carrito', 'pendiente', 'error']);

export function validateLine(line, { localId, localeIds }) {
  const errors = [];
  const sku = line.sku ?? 'un producto';
  if (!Number.isInteger(line.qty) || line.qty < 1) errors.push(`${sku}: cantidad inválida`);
  if (!ORIGINS.includes(line.origin)) errors.push(`${sku}: origen inválido`);
  if (!DELIVERIES.includes(line.delivery)) errors.push(`${sku}: forma de entrega inválida`);
  if (errors.length) return errors;
  if (line.delivery === 'ahora' && line.origin === 'rolon') {
    errors.push(`${sku}: "Se lo lleva ahora" solo sale del local (Stock o Exhibición)`);
  }
  if (line.delivery === 'retira_rolon' && line.origin !== 'rolon') errors.push(`${sku}: "Retira en Rolón" sale de Rolón`);
  if (line.delivery === 'retira_otro_local') {
    if (line.origin !== 'rolon') errors.push(`${sku}: "Retira en otro local" sale de Rolón`);
    if (!localeIds.includes(line.pickupLocalId) || line.pickupLocalId === localId) errors.push(`${sku}: elegí en qué otro local retira`);
  }
  return errors;
}

export function nextLineId(lines) {
  const max = lines.reduce((m, l) => Math.max(m, Number(String(l.lineId ?? '').replace('L', '')) || 0), 0);
  return `L${max + 1}`;
}

export const activeLines = (lines) => (lines ?? []).filter((l) => l.status !== 'eliminado');

export function buildLine(product, { qty = 1, origin = 'stock', delivery = 'ahora', pickupLocalId = null }, lines, ctx) {
  const line = {
    lineId: nextLineId(lines), productId: product.productId, sku: product.sku, name: product.name, qty,
    fullPrice: product.fullPrice, promoPrice: product.promoPrice, basePrice: product.basePrice,
    origin, delivery, pickupLocalId: delivery === 'retira_otro_local' ? pickupLocalId : null, status: 'activo',
  };
  const errors = validateLine(line, ctx);
  if (errors.length) throw new Error(errors.join('; '));
  return line;
}

export function editLine(line, changes, ctx) {
  if (line.status === 'entregado') throw new Error(`${line.sku} ya se entregó: no se puede cambiar`);
  if (line.status === 'eliminado') throw new Error(`${line.sku} está eliminada`);
  const next = { ...line };
  for (const field of ['qty', 'origin', 'delivery', 'pickupLocalId']) {
    if (changes[field] !== undefined) next[field] = changes[field];
  }
  if (next.delivery !== 'retira_otro_local') next.pickupLocalId = null;
  const errors = validateLine(next, ctx);
  if (errors.length) throw new Error(errors.join('; '));
  return next;
}

export function needsShipping(lines) {
  return activeLines(lines).some((l) => l.delivery === 'envio');
}

const SHIPPING_REQUIRED = { street: 'la calle', number: 'el número', city: 'la localidad', zip: 'el código postal', phone: 'el teléfono' };

export function validateShipping(shipping) {
  const errors = Object.entries(SHIPPING_REQUIRED)
    .filter(([field]) => typeof shipping?.[field] !== 'string' || !shipping[field].trim())
    .map(([, label]) => `Falta ${label} del envío`);
  const amount = shipping?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) errors.push('Costo de envío inválido');
  return errors;
}

export const reservationKey = (productId, locationId) => `${productId}__${locationId}`;

export function parseReservationKey(key) {
  const [productId, locationId] = key.split('__').map(Number);
  return { productId, locationId };
}

function addDeltas(deltas, state, sign, locate) {
  if (!state || !RESERVING_ORDER_STATUSES.has(state.status)) return;
  for (const line of state.lines ?? []) {
    if (line.status !== 'activo') continue;
    const key = reservationKey(line.productId, locate(line.origin));
    deltas.set(key, (deltas.get(key) ?? 0) + sign * line.qty);
  }
}

export function reservationDeltas(before, after, locate) {
  const deltas = new Map();
  addDeltas(deltas, before, -1, locate);
  addDeltas(deltas, after, +1, locate);
  for (const [key, value] of deltas) if (value === 0) deltas.delete(key);
  return deltas;
}

export const formatOrderNumber = (localId, n) => `${localId}-${String(n).padStart(4, '0')}`;
