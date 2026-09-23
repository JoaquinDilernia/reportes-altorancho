// Modelo de línea de pedido de la feria: de dónde sale (ubicación), cómo se
// entrega y en qué estado está. Todo puro — la E/S (Firestore, Odoo) vive en
// feriaOrders/feriaStock/feriaDelivery.
import { SHIPPING_COST, tablePrice, computeFinalPrice, activeRebajaField } from './feriaPricing.mjs';

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
  // Retirar en Rolón es llevarse lo que ya está en Rolón. Retira en feria y
  // envío sí pueden salir de exhibición (se aparta y se busca otro día, o se
  // manda desde ahí).
  if (line.delivery === 'retira_rolon' && line.location !== 'rolon') {
    errors.push(`${sku}: "Retira en Rolón" solo puede salir de Rolón`);
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
      if (changes.qty !== undefined) {
        if (!Number.isInteger(changes.qty) || changes.qty < 1) throw new Error(`Cantidad inválida para ${line.sku}`);
        next.qty = changes.qty;
      }
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

// Si un intento de confirmar ya creó el sale.order (queda en 'error' con
// odooOrderId), sacar líneas o cancelar solo en la app dejaría a Odoo
// cobrando algo distinto de lo que cobró caja.
const ALREADY_IN_ODOO = 'El pedido ya existe en Odoo: reintentá confirmar o resolvelo en Odoo';

export function assertCancellable(order) {
  if (!['pendiente', 'error'].includes(order.status)) {
    throw new Error('Solo se cancelan pedidos que todavía no se confirmaron (los confirmados se cancelan en Odoo)');
  }
  if (order.odooOrderId) throw new Error(ALREADY_IN_ODOO);
}

// Cargo de envío que corresponde a las líneas actuales del pedido.
export function shippingCostFor(lines) {
  return needsShipping(lines) ? SHIPPING_COST : 0;
}

// Reglas que dependen del pedido completo, no solo de la línea.
export function assertLineActionAllowed(order, line, action, changes = {}) {
  if (order.status === 'cancelado') throw new Error('El pedido está cancelado');
  if (action === 'remove') {
    if (!['pendiente', 'error'].includes(order.status)) {
      throw new Error('Después de confirmar no se pueden eliminar líneas desde la app (hacelo en Odoo)');
    }
    if (order.odooOrderId) throw new Error(ALREADY_IN_ODOO);
    const others = order.lines.filter((l) => l.lineId !== line.lineId && isReserving(l));
    if (others.length === 0) throw new Error('No se puede eliminar la última línea: cancelá el pedido');
  }
  if (action === 'deliver' && (order.status !== 'confirmado' || !line.odooLineId)) {
    throw new Error('Primero hay que confirmar el pedido en caja');
  }
  // La cantidad ya viajó a Odoo al confirmar (o en un intento anterior):
  // cambiarla solo en la app dejaría las dos puntas distintas.
  if (action === 'edit' && changes.qty !== undefined && (order.odooOrderId || !['pendiente', 'error'].includes(order.status))) {
    throw new Error('El pedido ya está en Odoo: la cantidad se cambia en Odoo');
  }
  // Antes de confirmar, pasar a envío sin dirección haría fallar el confirm
  // (no hay a dónde mandarlo). Después de confirmar la app solo avisa.
  if (action === 'edit' && changes.delivery === 'envio' && !order.shipping && !order.odooOrderId) {
    throw new Error('Este pedido no tiene datos de envío: cargá primero la dirección de envío');
  }
}

// Pedido con algo todavía por entregar. Los pedidos viejos (sin delivery ni
// status por línea) no cuentan: nunca pasaron por este flujo.
export function hasPendingDeliveries(order) {
  return (order.lines ?? []).some((l) => l.delivery && isReserving(l));
}

// Número de pedido para hablar en la feria ("el F-0012"). Correlativo, lo
// asigna createOrder con un contador en Firestore.
export function formatOrderNumber(n) {
  return `F-${String(n).padStart(4, '0')}`;
}

// La dirección de envío se puede cargar o corregir en cualquier momento
// (Logística la lee de la app); solo un pedido cancelado queda cerrado.
export function assertShippingEditable(order) {
  if (order.status === 'cancelado') throw new Error('El pedido está cancelado');
}

// Id para una línea nueva: sigue después del mayor existente (las eliminadas
// quedan en el historial, así que su id no se reutiliza).
export function nextLineId(lines) {
  const max = lines.reduce((m, l) => Math.max(m, Number(String(l.lineId ?? '').replace('L', '')) || 0), 0);
  return `L${max + 1}`;
}

// Línea que Caja agrega a un pedido: el precio lo calcula el servidor con la
// rebaja activa de esa condición y el descuento del medio de pago del pedido.
export function buildAddedLine(product, { condition, qty, location, delivery }, paymentMethod, lines) {
  const rebaja = product[activeRebajaField(condition)] ?? 0;
  const listPrice = tablePrice(product, condition, rebaja);
  if (listPrice == null) throw new Error(`${product.sku} no tiene precio para esa condición`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`Cantidad inválida para ${product.sku}`);
  const line = {
    lineId: nextLineId(lines), sku: product.sku, modelo: product.modelo, condition, qty,
    listPrice, unitPrice: computeFinalPrice(product, condition, rebaja, paymentMethod),
    location, delivery, status: 'pendiente',
  };
  const errors = validateLineDelivery(line);
  if (errors.length) throw new Error(errors.join('; '));
  return line;
}
