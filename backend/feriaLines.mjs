// Modelo de línea de pedido de la feria: de dónde sale (ubicación), cómo se
// entrega y en qué estado está. Todo puro — la E/S (Firestore, Odoo) vive en
// feriaOrders/feriaStock/feriaDelivery.

export const LOCATIONS = ['exhibicion', 'rolon'];
export const DELIVERIES = ['ahora', 'retira_feria', 'retira_rolon', 'envio'];
// Mientras una línea está en alguno de estos estados, su stock está
// reservado en la app (todavía no salió físicamente para el cliente).
export const RESERVING_STATUSES = new Set(['pendiente', 'enviado_feria']);

export const LOCATION_LABELS = { exhibicion: 'Exhibición', rolon: 'Rolón' };
const SHIPPING_REQUIRED = { street: 'la calle', number: 'el número', city: 'la localidad', zip: 'el código postal', phone: 'el teléfono' };

export function validateLineDelivery(line) {
  const errors = [];
  const sku = line.sku ?? 'un producto';
  if (!LOCATIONS.includes(line.location)) errors.push(`Ubicación inválida para ${sku}`);
  if (!DELIVERIES.includes(line.delivery)) errors.push(`Forma de entrega inválida para ${sku}`);
  if (line.delivery === 'ahora' && line.location !== 'exhibicion') {
    errors.push(`${sku}: "Se lleva ahora" solo puede salir de Exhibición`);
  }
  return errors;
}

export function validateShipping(shipping) {
  return Object.entries(SHIPPING_REQUIRED)
    .filter(([field]) => typeof shipping?.[field] !== 'string' || !shipping[field].trim())
    .map(([, label]) => `Falta ${label} del envío`);
}

export function needsShipping(lines) {
  return lines.some((l) => l.delivery === 'envio' && l.status !== 'eliminado');
}

export function isReserving(line) {
  return RESERVING_STATUSES.has(line.status);
}

export function reservationKey(sku, location) {
  return `${String(sku).toUpperCase()}__${location}`;
}

export function parseReservationKey(key) {
  const [sku, location] = key.split('__');
  return { sku, location };
}

function addDelta(deltas, line, sign) {
  const key = reservationKey(line.sku, line.location);
  deltas.set(key, (deltas.get(key) ?? 0) + sign * line.qty);
}

// Diferencia de reservas entre dos versiones de las líneas de un pedido:
// lo que reservaba antes se devuelve, lo que reserva ahora se toma. Así un
// mismo cálculo cubre crear, eliminar, entregar, cancelar y mover de
// ubicación.
export function reservationDeltas(beforeLines, afterLines) {
  const deltas = new Map();
  for (const line of beforeLines) if (isReserving(line)) addDelta(deltas, line, -1);
  for (const line of afterLines) if (isReserving(line)) addDelta(deltas, line, +1);
  for (const [key, value] of deltas) if (value === 0) deltas.delete(key);
  return deltas;
}

export function assignLineIds(lines) {
  return lines.map((line, i) => ({ ...line, lineId: `L${i + 1}`, status: 'pendiente' }));
}

function assertReserving(line, verb) {
  if (line.status === 'entregado') throw new Error(`La línea ${line.sku} ya está entregada: no se puede ${verb}`);
  if (line.status === 'eliminado') throw new Error(`La línea ${line.sku} está eliminada: no se puede ${verb}`);
}

export function applyLineAction(line, action, { user, now, changes = {} }) {
  switch (action) {
    case 'remove':
      assertReserving(line, 'eliminar');
      return { ...line, status: 'eliminado', removedAt: now, removedBy: user };
    case 'deliver':
      assertReserving(line, 'marcar como hecha');
      return { ...line, status: 'entregado', deliveredAt: now, deliveredBy: user };
    case 'sendToFeria':
      if (line.delivery !== 'retira_feria' || line.status !== 'pendiente') {
        throw new Error(`Solo se envían a la feria líneas pendientes de "Retira en feria" (${line.sku})`);
      }
      return { ...line, status: 'enviado_feria', sentToFeriaAt: now, sentToFeriaBy: user };
    case 'edit': {
      assertReserving(line, 'editar');
      const next = { ...line };
      if (changes.location !== undefined) next.location = changes.location;
      if (changes.delivery !== undefined) next.delivery = changes.delivery;
      const errors = validateLineDelivery(next);
      if (errors.length) throw new Error(errors.join('; '));
      // "Enviado a feria" solo tiene sentido para retira_feria.
      if (next.status === 'enviado_feria' && next.delivery !== 'retira_feria') next.status = 'pendiente';
      return next;
    }
    default:
      throw new Error(`Acción inválida: ${action}`);
  }
}

// Reglas que dependen del pedido completo, no solo de la línea.
export function assertLineActionAllowed(order, line, action) {
  if (order.status === 'cancelado') throw new Error('El pedido está cancelado');
  if (action === 'remove') {
    if (!['pendiente', 'error'].includes(order.status)) {
      throw new Error('Después de confirmar no se pueden eliminar líneas desde la app (hacelo en Odoo)');
    }
    const others = order.lines.filter((l) => l.lineId !== line.lineId && isReserving(l));
    if (others.length === 0) throw new Error('No se puede eliminar la última línea: cancelá el pedido');
  }
  if (action === 'deliver' && (order.status !== 'confirmado' || !line.odooLineId)) {
    throw new Error('Primero hay que confirmar el pedido en caja');
  }
}

// Pedido con algo todavía por entregar. Los pedidos viejos (sin delivery ni
// status por línea) no cuentan: nunca pasaron por este flujo.
export function hasPendingDeliveries(order) {
  return (order.lines ?? []).some((l) => l.delivery && isReserving(l));
}
