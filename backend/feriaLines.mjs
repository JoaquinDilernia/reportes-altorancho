// Modelo de línea de pedido de la feria: de dónde sale (ubicación), cómo se
// entrega y en qué estado está. Todo puro — la E/S (Firestore, Odoo) vive en
// feriaOrders/feriaStock/feriaDelivery.
import { PAYMENT_METHODS, unitCostOf, SHIPPING_COST, tablePrice, computeFinalPrice, activeRebajaField } from './feriaPricing.mjs';

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
  if (isConfirming(order)) throw new Error(CONFIRMING_MESSAGE);
}

// Cargo de envío que corresponde a las líneas actuales del pedido.
export function shippingCostFor(lines) {
  return needsShipping(lines) ? SHIPPING_COST : 0;
}

// Reglas que dependen del pedido completo, no solo de la línea.
export function assertLineActionAllowed(order, line, action, changes = {}) {
  if (order.status === 'cancelado') throw new Error('El pedido está cancelado');
  if (isConfirming(order) && (action === 'remove' || (action === 'edit' && changes.qty !== undefined))) {
    throw new Error(CONFIRMING_MESSAGE);
  }
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
    listPrice, unitPrice: computeFinalPrice(product, condition, rebaja, paymentMethod), unitCost: unitCostOf(product),
    location, delivery, status: 'pendiente',
  };
  const errors = validateLineDelivery(line);
  if (errors.length) throw new Error(errors.join('; '));
  return line;
}

// Anular una venta ya confirmada desde la app. Si algo ya se entregó, esa
// mercadería salió del stock en Odoo y hace falta una devolución: eso se hace
// en Odoo (la sincronización trae la cancelación después).
export function assertAnnullable(order) {
  if (order.status !== 'confirmado' || !order.odooOrderId) {
    throw new Error('Solo se anulan ventas confirmadas (las pendientes se cancelan con "Cancelar pedido")');
  }
  if (order.invoiceName) {
    throw new Error(`La venta ya tiene la factura ${order.invoiceName}: anulala en Odoo con una nota de crédito`);
  }
  if ((order.lines ?? []).some((l) => l.status === 'entregado')) {
    throw new Error('Parte del pedido ya se entregó: anulalo en Odoo con la devolución correspondiente');
  }
}

// Se factura una venta ya confirmada en Odoo, una sola vez.
export function assertInvoiceable(order) {
  if (order.status !== 'confirmado' || !order.odooOrderId) {
    throw new Error('Solo se facturan ventas confirmadas');
  }
  if (order.invoiceName) throw new Error(`La venta ya tiene la factura ${order.invoiceName}`);
}

// Mientras Caja confirma, el pedido queda "reclamado" (confirmingSince) para
// que nadie lo cambie a mitad de camino desde otro dispositivo: lo que se
// manda a Odoo tiene que ser exactamente lo que queda en la app. El reclamo
// vence solo por si el proceso se corta.
export const CONFIRM_CLAIM_MS = 2 * 60 * 1000;
export const CONFIRMING_MESSAGE = 'El pedido se está confirmando en este momento: esperá unos segundos y volvé a intentar';

function toMs(value) {
  if (value == null) return null;
  return typeof value.toMillis === 'function' ? value.toMillis() : new Date(value).getTime();
}

export function isConfirming(order, now = Date.now()) {
  const since = toMs(order.confirmingSince);
  return since != null && now - since < CONFIRM_CLAIM_MS;
}

// Cerrar en la app una venta que se anuló. Desde Caja: solo confirmadas y
// sin nada entregado. Desde Odoo (sincronización): también las que quedaron
// en error con pedido ya creado allá, y aunque algo se haya entregado (Odoo
// ya decidió; solo se libera lo que seguía reservado).
export function assertClosable(order, { fromOdoo }) {
  const closable = order.status === 'confirmado' || (fromOdoo && order.status === 'error');
  if (!closable || !order.odooOrderId) throw new Error('Solo se anulan ventas confirmadas');
  if (!fromOdoo && (order.lines ?? []).some((l) => l.status === 'entregado')) {
    throw new Error('Parte del pedido ya se entregó: anulalo en Odoo con la devolución correspondiente');
  }
}

// Caja cambia el medio de pago de un pedido que todavía no llegó a Odoo (el
// cliente decidió pagar distinto). Después de confirmar la venta ya está en
// Odoo y en la caja: se cambia allá.
export function assertPaymentEditable(order) {
  if (order.status === 'cancelado') throw new Error('El pedido está cancelado');
  if (!['pendiente', 'error'].includes(order.status)) {
    throw new Error('La venta ya se confirmó: el medio de pago se cambia en Odoo');
  }
  if (order.odooOrderId) throw new Error(ALREADY_IN_ODOO);
  if (isConfirming(order)) throw new Error(CONFIRMING_MESSAGE);
}

// Precio final de cada línea con el medio de pago nuevo, desde el precio de
// lista guardado (el de la venta, con la rebaja que estaba activa). Los
// pedidos viejos sin listPrice lo reconstruyen deshaciendo el descuento
// anterior.
export function repriceLines(lines, fromMethod, toMethod) {
  const to = PAYMENT_METHODS[toMethod];
  if (!to) throw new Error(`Medio de pago inválido: ${toMethod}`);
  const fromPct = PAYMENT_METHODS[fromMethod]?.discountPct ?? 0;
  return lines.map((line) => {
    const listPrice = line.listPrice ?? Math.round(line.unitPrice / (1 - fromPct / 100));
    return { ...line, listPrice, unitPrice: Math.round(listPrice * (1 - to.discountPct / 100)) };
  });
}
