// Modelo de línea de pedido de la feria: de dónde sale (ubicación), cómo se
// entrega y en qué estado está. Todo puro — la E/S (Firestore, Odoo) vive en
// feriaOrders/feriaStock/feriaDelivery.
import { PAYMENT_METHODS, unitCostOf, SHIPPING_COST, tablePrice, computeFinalPrice, activeRebajaField } from './feriaPricing.mjs';

// Ubicaciones con stock controlado (reservas y disponible): solo para
// discontinuo. Falla sale siempre de Fallados, un stock ficticio en Odoo
// que puede quedar en negativo: la app no lo reserva ni lo controla.
export const LOCATIONS = ['exhibicion', 'rolon'];
export const FALLADOS = 'fallados';
export const DELIVERIES = ['ahora', 'retira_feria', 'retira_rolon', 'envio'];
// Mientras una línea está en alguno de estos estados, su stock está
// reservado en la app (todavía no salió físicamente para el cliente).
export const RESERVING_STATUSES = new Set(['pendiente', 'enviado_feria']);

export const LOCATION_LABELS = { exhibicion: 'Exhibición', rolon: 'Rolón', fallados: 'Fallados' };

export function controlsStock(location) {
  return LOCATIONS.includes(location);
}
const SHIPPING_REQUIRED = { street: 'la calle', number: 'el número', city: 'la localidad', zip: 'el código postal', phone: 'el teléfono' };

export function validateLineDelivery(line) {
  const errors = [];
  const sku = line.sku ?? 'un producto';
  if (![...LOCATIONS, FALLADOS].includes(line.location)) errors.push(`Ubicación inválida para ${sku}`);
  else if (line.condition === 'falla' && line.location !== FALLADOS) errors.push(`${sku}: Falla sale de Fallados`);
  else if (line.condition !== 'falla' && line.location === FALLADOS) errors.push(`${sku}: Discontinuo sale de Exhibición o Rolón`);
  if (!DELIVERIES.includes(line.delivery)) errors.push(`Forma de entrega inválida para ${sku}`);
  // Fallados también está en la feria: falla se puede llevar en el momento.
  if (line.delivery === 'ahora' && !['exhibicion', FALLADOS].includes(line.location)) {
    errors.push(`${sku}: "Me llevo ahora" solo puede salir de Exhibición o Fallados`);
  }
  // Retirar en Rolón es llevarse lo que ya está en Rolón. Retira en feria sí
  // puede salir de exhibición (se aparta y se busca, hasta el sábado 18 hs).
  if (line.delivery === 'retira_rolon' && line.location !== 'rolon') {
    errors.push(`${sku}: "Retira en Rolón" solo puede salir de Rolón`);
  }
  // Envío a domicilio (CABA/GBA) solo para el stock de Rolón: lo que está
  // físicamente en la feria (exhibición, fallados) se lleva o se retira ahí.
  if (line.delivery === 'envio' && line.location !== 'rolon') {
    errors.push(`${sku}: Envío a domicilio solo para lo que sale de Rolón`);
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
  for (const line of beforeLines) if (isReserving(line) && controlsStock(line.location)) addDelta(deltas, line, -1);
  for (const line of afterLines) if (isReserving(line) && controlsStock(line.location)) addDelta(deltas, line, +1);
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
        throw new Error(`Solo se envían a la feria líneas pendientes de "Retira en depósito feria" (${line.sku})`);
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

// Número de pedido para hablar en la feria y para la etiqueta de "vendido"
// ("el F2-0012"): prefijo con el número del vendedor y un contador propio
// de cada vendedor en Firestore.
export function formatOrderNumber(n, sellerCode) {
  return `F${sellerCode}-${String(n).padStart(4, '0')}`;
}

// El vendedor arma el pedido como carrito ('carrito'): ya tiene número y
// reserva stock mientras recorre la feria con el cliente. Al mandarlo a caja
// pasa a 'pendiente'; si lo vacía, a 'descartado'. Caja no ve carritos.
export function isSentOrder(order) {
  return order.status !== 'carrito' && order.status !== 'descartado';
}

export function assertCartEditable(order, sellerId) {
  if (order.sellerId !== sellerId) throw new Error('Este carrito es de otro vendedor');
  if (order.status === 'descartado') throw new Error('Este carrito se vació');
  if (order.status !== 'carrito') throw new Error(`El pedido ${order.number} ya se mandó a caja`);
}

// Al mandar a caja se toma la rebaja vigente en ese momento (pudo cambiar
// mientras el cliente recorría) y se aplica el descuento del medio de pago.
export function priceCartForSubmit(lines, paymentMethod, getProduct) {
  const method = PAYMENT_METHODS[paymentMethod];
  if (!method) throw new Error(`Medio de pago inválido: ${paymentMethod}`);
  return lines.map((line) => {
    const product = getProduct(line.sku);
    if (!product) throw new Error(`${line.sku} ya no está en la lista de precios de la feria`);
    const listPrice = tablePrice(product, line.condition, product[activeRebajaField(line.condition)] ?? 0);
    if (listPrice == null) throw new Error(`${line.sku} ya no tiene precio para esa condición`);
    return { ...line, listPrice, unitPrice: Math.round(listPrice * (1 - method.discountPct / 100)) };
  });
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

// Línea que el vendedor suma al carrito: precio de lista con la rebaja
// activa, calculado por el servidor. Todavía no hay medio de pago, así que
// el precio final es el de lista hasta que se manda a caja.
export function buildCartLine(product, { condition, qty, location, delivery }, lines) {
  const rebaja = product[activeRebajaField(condition)] ?? 0;
  const listPrice = tablePrice(product, condition, rebaja);
  if (listPrice == null) throw new Error(`${product.sku} no tiene precio para esa condición`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`Cantidad inválida para ${product.sku}`);
  const line = {
    lineId: nextLineId(lines), sku: product.sku, modelo: product.modelo, condition, qty,
    listPrice, unitPrice: listPrice, unitCost: unitCostOf(product),
    location, delivery, status: 'pendiente',
  };
  const errors = validateLineDelivery(line);
  if (errors.length) throw new Error(errors.join('; '));
  return line;
}

// Línea que Caja agrega a un pedido: como la del carrito, pero ya con el
// descuento del medio de pago del pedido.
export function buildAddedLine(product, input, paymentMethod, lines) {
  const line = buildCartLine(product, input, lines);
  const rebaja = product[activeRebajaField(input.condition)] ?? 0;
  return { ...line, unitPrice: computeFinalPrice(product, input.condition, rebaja, paymentMethod) };
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

// Reintento automático de los pedidos que fallaron al confirmar (Odoo caído,
// se cortó la conexión): espera creciente y un tope, para no insistir para
// siempre con un error que no es pasajero (ese lo resuelve Caja).
export const AUTO_RETRY_MAX = 6;
const AUTO_RETRY_BASE_MS = 3 * 60 * 1000;
const AUTO_RETRY_CAP_MS = 30 * 60 * 1000;

export function autoRetryDelayMs(count) {
  return Math.min(AUTO_RETRY_BASE_MS * 2 ** count, AUTO_RETRY_CAP_MS);
}

export function shouldAutoRetry(order, now = Date.now()) {
  if (order.status !== 'error' || isConfirming(order, now)) return false;
  const count = order.autoRetryCount ?? 0;
  if (count >= AUTO_RETRY_MAX) return false;
  const last = toMs(order.lastAutoRetryAt ?? order.updatedAt) ?? 0;
  return now - last >= autoRetryDelayMs(count);
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

// ---- Pago (uno o dividido en varios medios) ----

const round2 = (n) => Math.round(n * 100) / 100;
const pesos = (n) => `$ ${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;

// Lo que cobra la venta: productos no eliminados más el envío.
export function orderTotal(order) {
  const products = (order.lines ?? [])
    .filter((l) => l.status !== 'eliminado')
    .reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  return products + (order.shippingCost || 0);
}

// Cómo entró la plata de una venta. Sin pago dividido, todo el total en su
// único medio. `payments` solo existe cuando Caja dividió el pago.
export function paymentsOf(order) {
  if (order.payments?.length) return order.payments;
  return [{ method: order.paymentMethod, amount: orderTotal(order) }];
}

// Con un solo medio el monto no importa (es todo el total), así que no se pide.
export function validatePayments(payments) {
  if (!Array.isArray(payments) || !payments.length) throw new Error('Cargá al menos un medio de pago');
  const seen = new Set();
  return payments.map(({ method, amount }) => {
    if (!PAYMENT_METHODS[method]) throw new Error(`Medio de pago inválido: ${method}`);
    if (seen.has(method)) throw new Error(`${PAYMENT_METHODS[method].label} está repetido: sumá los montos en uno solo`);
    seen.add(method);
    if (payments.length === 1) return { method };
    const n = typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : amount;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`Monto inválido para ${PAYMENT_METHODS[method].label}`);
    return { method, amount: round2(n) };
  });
}

// El pago dividido tiene que cubrir exacto el total. Si Caja cambió los
// productos después de dividir el pago, esto frena la confirmación.
export function assertPaymentsMatchTotal(order) {
  if (!order.payments?.length) return;
  const total = orderTotal(order);
  const paid = round2(order.payments.reduce((sum, p) => sum + p.amount, 0));
  if (Math.abs(paid - total) >= 0.01) {
    throw new Error(`Los pagos suman ${pesos(paid)} y el total es ${pesos(total)}: corregí los montos del pago dividido`);
  }
}

// ---- Cancelados: lo que hay que devolver físicamente a stock ----
// Productos eliminados de un pedido, o de un pedido cancelado/anulado que no
// se habían entregado. La reserva de la app ya se liberó; esto es para que
// quien lo tenga (depósito feria, Rolón…) lo vuelva a su lugar y lo marque.
// Los carritos no cuentan: lo que no pasó por caja no se movió.
export function restockLines(order) {
  if (!isSentOrder(order)) return [];
  return (order.lines ?? []).filter((l) => l.status === 'eliminado' || (order.status === 'cancelado' && isReserving(l)));
}

// Marca del pedido para listarlo en Cancelados con un solo where.
export function hasCancelledItems(order) {
  return restockLines(order).length > 0;
}

export function applyRestock(order, lineId, { user, now }) {
  const line = (order.lines ?? []).find((l) => l.lineId === lineId);
  if (!line) throw new Error('Línea no encontrada');
  if (!restockLines(order).includes(line)) throw new Error(`${line.sku} no está cancelado: no hay nada que devolver`);
  if (line.restockedAt) throw new Error(`${line.sku} ya se devolvió a stock`);
  return order.lines.map((l) => (l.lineId === lineId ? { ...l, restockedAt: now, restockedBy: user } : l));
}
