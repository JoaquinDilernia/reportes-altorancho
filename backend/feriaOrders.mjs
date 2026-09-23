import { getDb } from './feriaOdoo.mjs';
import { PAYMENT_METHODS as PAYMENT_METHOD_INFO, SHIPPING_COST } from './feriaPricing.mjs';
import {
  validateLineDelivery, validateShipping, needsShipping, assignLineIds, reservationDeltas,
  applyLineAction, assertLineActionAllowed, hasPendingDeliveries, assertCancellable, shippingCostFor,
  formatOrderNumber, assertShippingEditable, buildAddedLine,
  isConfirming, assertClosable, CONFIRMING_MESSAGE,
} from './feriaLines.mjs';
import { getFeriaProduct } from './feriaProducts.mjs';
import { fetchOdooStock, readReservations, checkAvailability, writeReservations } from './feriaStock.mjs';

const COLLECTION = 'feria_orders';
const COUNTERS_COLLECTION = 'feria_counters';
// Derivado de feriaPricing para que no haya dos listas de medios de pago que
// se puedan desincronizar (p. ej. el 'tarjeta' viejo, ya eliminado).
const PAYMENT_METHODS = new Set(Object.keys(PAYMENT_METHOD_INFO));
const CONDITIONS = new Set(['falla', 'discontinuo']);

export function validateOrderInput(input) {
  const errors = [];
  if (!input.sellerId) errors.push('Falta identificar al vendedor');
  if (!input.customer?.name?.trim()) errors.push('Falta el nombre del cliente');
  if (!input.customer?.docNumber?.trim()) errors.push('Falta el DNI/CUIT del cliente');
  const phone = input.customer?.phone?.trim() ?? '';
  if (!phone) errors.push('Falta el teléfono del cliente');
  else if (phone.replace(/\D/g, '').length < 8) errors.push('Teléfono inválido: tiene que tener al menos 8 números');
  if (!PAYMENT_METHODS.has(input.paymentMethod)) errors.push('Método de pago inválido');
  if (!input.lines?.length) errors.push('El pedido necesita al menos una línea de producto');
  for (const line of input.lines ?? []) {
    if (!line.sku) errors.push('Falta el SKU de un producto');
    if (!CONDITIONS.has(line.condition)) errors.push(`Condición inválida para ${line.sku ?? 'un producto'} (debe ser falla o discontinuo)`);
    // Los chequeos piden un número finito de verdad, no solo `> 0` / `>= 0`:
    // en JS `null >= 0` es true y `'5000' >= 0` también, así que un
    // unitPrice null (lo que devuelve el módulo de precios cuando esa
    // condición no tiene precio cargado) o una cantidad string pasaban.
    if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) errors.push(`Cantidad inválida (cantidad debe ser mayor a 0) para ${line.sku ?? 'un producto'}`);
    if (typeof line.unitPrice !== 'number' || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) errors.push(`Precio inválido para ${line.sku ?? 'un producto'}`);
    // listPrice (precio de tabla, sin el descuento del medio de pago) es
    // opcional para no romper pedidos de tablets con la versión anterior.
    if (line.listPrice !== undefined && (typeof line.listPrice !== 'number' || !Number.isFinite(line.listPrice) || line.listPrice < 0)) errors.push(`Precio de lista inválido para ${line.sku ?? 'un producto'}`);
    errors.push(...validateLineDelivery(line));
  }
  if (needsShipping(input.lines ?? [])) errors.push(...validateShipping(input.shipping));
  return { valid: errors.length === 0, errors };
}

export async function createOrder(input) {
  const { valid, errors } = validateOrderInput(input);
  if (!valid) throw new Error(errors.join('; '));

  const lines = assignLineIds(input.lines.map((l) => ({
    sku: l.sku.toUpperCase(), modelo: l.modelo, condition: l.condition, qty: l.qty,
    unitPrice: l.unitPrice, listPrice: l.listPrice, location: l.location, delivery: l.delivery,
  })));
  const withShipping = needsShipping(lines);
  const deltas = reservationDeltas([], lines);
  // Stock de Odoo afuera de la transacción (es una llamada HTTP lenta y las
  // transacciones de Firestore se reintentan); las reservas, adentro.
  const odooStock = await fetchOdooStock(lines.map((l) => l.sku));

  const db = getDb();
  const ref = db.collection(COLLECTION).doc();
  const order = {
    sellerId: input.sellerId,
    sellerName: input.sellerName,
    customer: {
      name: input.customer.name.trim(), docNumber: input.customer.docNumber.trim(), phone: input.customer.phone.trim(),
    },
    paymentMethod: input.paymentMethod,
    lines,
    shipping: withShipping ? input.shipping : null,
    shippingCost: withShipping ? SHIPPING_COST : 0,
    invoiceType: null,
    status: 'pendiente',
    errorDetail: null,
    odooOrderId: null,
    invoiceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // El número interno sale de un contador leído y escrito en la misma
  // transacción: dos vendedores enviando a la vez no pueden repetir número.
  const counterRef = db.collection(COUNTERS_COLLECTION).doc('orders');
  await db.runTransaction(async (tx) => {
    const reserved = await readReservations(db, [...deltas.keys()], tx);
    const counter = await tx.get(counterRef);
    const stockErrors = checkAvailability(odooStock, reserved, deltas);
    if (stockErrors.length) throw new Error(`Sin stock suficiente — ${stockErrors.join('; ')}`);
    const next = (counter.exists ? counter.data().next : 0) + 1;
    order.number = formatOrderNumber(next);
    writeReservations(tx, db, reserved, deltas);
    tx.set(counterRef, { next });
    tx.set(ref, order);
  });
  return { id: ref.id, ...order };
}

export async function listOrdersByStatus(status) {
  const db = getDb();
  // Sin orderBy en la query: where + orderBy sobre campos distintos exige un
  // índice compuesto en Firestore. Se ordena acá (más nuevo primero); son
  // pocos pedidos por estado, así que no hay costo real.
  const snap = await db.collection(COLLECTION)
    .where('status', '==', status)
    .get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
}

export async function getOrderById(id) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// Guarda el id del sale.order de Odoo apenas se crea, ANTES de intentar
// facturar — deja el pedido en 'pendiente' (no toca status). Así, si la
// factura falla y el cajero reintenta confirmar, la ruta de confirmación
// puede ver que este pedido YA tiene un odooOrderId y saltar directo a
// facturar en vez de crear un sale.order duplicado en Odoo.
export async function saveOdooOrderId(id, odooOrderId) {
  const db = getDb();
  await db.collection(COLLECTION).doc(id).update({ odooOrderId, updatedAt: new Date() });
}

// Reclama el pedido para confirmarlo (ver isConfirming): desde acá hasta que
// termine, nadie lo cambia desde otro dispositivo. Devuelve el pedido leído
// dentro de la transacción: eso es lo que viaja a Odoo.
export async function claimOrderForConfirm(id) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = { id: snap.id, ...snap.data() };
    if (order.status === 'cancelado') throw new Error('El pedido está cancelado');
    if (!['pendiente', 'error'].includes(order.status)) return { order, alreadyConfirmed: true };
    if (isConfirming(order)) throw new Error(CONFIRMING_MESSAGE);
    const confirmingSince = new Date();
    tx.update(ref, { confirmingSince });
    return { order: { ...order, confirmingSince }, alreadyConfirmed: false };
  });
}

// Transaccionales y sin pisar un pedido cancelado: un cambio que se coló al
// mismo tiempo no puede "resucitar" una venta ya cancelada.
async function finishConfirm(id, update) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status === 'cancelado') return;
    tx.update(ref, { ...update, confirmingSince: null, updatedAt: new Date() });
  });
}

export async function markOrderConfirmed(id, { odooOrderId, odooOrderName = null, invoiceId = null }) {
  await finishConfirm(id, {
    status: invoiceId ? 'facturado' : 'confirmado', odooOrderId, odooOrderName, invoiceId, errorDetail: null,
  });
}

export async function markOrderError(id, errorDetail) {
  await finishConfirm(id, { status: 'error', errorDetail });
}

// Aplica la misma acción a una o más líneas del pedido y ajusta las reservas,
// todo en una transacción (pedido + contadores de reserva juntos).
export async function applyOrderLineActions(orderId, lineIds, action, { user, changes } = {}) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);

  // Mover una línea de ubicación reserva en la nueva: hace falta el stock de
  // Odoo, que se lee afuera de la transacción.
  let odooStock = null;
  if (action === 'edit' && (changes?.location || changes?.qty)) {
    const snap = await ref.get();
    const skus = (snap.data()?.lines ?? []).filter((l) => lineIds.includes(l.lineId)).map((l) => l.sku);
    odooStock = await fetchOdooStock(skus);
  }

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = { id: snap.id, ...snap.data() };
    const missing = lineIds.filter((id) => !order.lines.some((l) => l.lineId === id));
    if (missing.length) throw new Error(`Línea no encontrada: ${missing.join(', ')}`);
    const now = new Date();
    const newLines = order.lines.map((line) => {
      if (!lineIds.includes(line.lineId)) return line;
      assertLineActionAllowed(order, line, action, changes);
      return applyLineAction(line, action, { user, now, changes });
    });

    const deltas = reservationDeltas(order.lines, newLines);
    const reserved = await readReservations(db, [...deltas.keys()], tx);
    if (odooStock) {
      const stockErrors = checkAvailability(odooStock, reserved, deltas);
      if (stockErrors.length) throw new Error(`Sin stock suficiente — ${stockErrors.join('; ')}`);
    }
    writeReservations(tx, db, reserved, deltas);
    const update = { lines: newLines, updatedAt: now };
    // Mientras el pedido no existe en Odoo, el cargo de envío sigue a las
    // líneas (sacar o cambiar la única línea de envío lo saca del total).
    // Una vez en Odoo, el cargo ya viajó y queda como está.
    if (!order.odooOrderId) update.shippingCost = shippingCostFor(newLines);
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

// Cancela un pedido todavía no confirmado y libera todo lo que reservaba. Las
// líneas quedan como estaban (historial); el pedido pasa a 'cancelado'.
export async function cancelOrder(orderId, user) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = { id: snap.id, ...snap.data() };
    assertCancellable(order);
    const deltas = reservationDeltas(order.lines, []);
    const reserved = await readReservations(db, [...deltas.keys()], tx);
    writeReservations(tx, db, reserved, deltas);
    const now = new Date();
    const update = { status: 'cancelado', cancelledAt: now, cancelledBy: user, updatedAt: now };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

// Pedidos confirmados con algo por entregar. Un solo where (sin índice
// compuesto); el resto se filtra y ordena acá.
export async function listLogisticsOrders() {
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('status', '==', 'confirmado').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter(hasPendingDeliveries)
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
}

export async function setOrderErrorDetail(id, errorDetail) {
  const db = getDb();
  await db.collection(COLLECTION).doc(id).update({ errorDetail, updatedAt: new Date() });
}

// Guarda el id de sale.order.line de cada línea de la app: lo necesita
// "Hecho" para validar justo esa línea del remito.
export async function saveOdooLineIds(orderId, odooLineIdByLineId) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const lines = snap.data().lines.map((l) => (
      odooLineIdByLineId[l.lineId] ? { ...l, odooLineId: odooLineIdByLineId[l.lineId] } : l
    ));
    tx.update(ref, { lines, updatedAt: new Date() });
  });
}

// Carga o corrige la dirección de envío. Antes de confirmar es la que viaja
// a Odoo; después, Odoo ya tiene la suya y la app solo actualiza la que usa
// Logística (la pantalla avisa que en Odoo hay que ajustarla a mano).
export async function updateOrderShipping(orderId, shipping) {
  const errors = validateShipping(shipping);
  if (errors.length) throw new Error(errors.join('; '));
  const clean = {
    street: shipping.street.trim(), number: shipping.number.trim(), floor: (shipping.floor ?? '').trim(),
    city: shipping.city.trim(), zip: shipping.zip.trim(), phone: shipping.phone.trim(), notes: (shipping.notes ?? '').trim(),
  };
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = { id: snap.id, ...snap.data() };
    assertShippingEditable(order);
    const update = { shipping: clean, updatedAt: new Date() };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

// Caja agrega un producto a un pedido que todavía no llegó a Odoo. Precio
// calculado acá (rebaja activa + medio de pago del pedido) y stock reservado
// en la misma transacción que la línea, igual que al crear el pedido.
export async function addOrderLine(orderId, input) {
  const product = getFeriaProduct(input.sku);
  if (!product) throw new Error(`${input.sku} no está en la lista de precios de la feria`);
  const odooStock = await fetchOdooStock([product.sku]);
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = { id: snap.id, ...snap.data() };
    if (!['pendiente', 'error'].includes(order.status) || order.odooOrderId) {
      throw new Error('Solo se agregan productos a pedidos que todavía no se confirmaron');
    }
    if (isConfirming(order)) throw new Error(CONFIRMING_MESSAGE);
    const line = buildAddedLine(product, input, order.paymentMethod, order.lines);
    if (line.delivery === 'envio' && !order.shipping) {
      throw new Error('Este pedido no tiene datos de envío: cargá primero la dirección de envío');
    }
    const deltas = reservationDeltas([], [line]);
    const reserved = await readReservations(db, [...deltas.keys()], tx);
    const stockErrors = checkAvailability(odooStock, reserved, deltas);
    if (stockErrors.length) throw new Error(`Sin stock suficiente — ${stockErrors.join('; ')}`);
    writeReservations(tx, db, reserved, deltas);
    const lines = [...order.lines, line];
    const update = { lines, shippingCost: shippingCostFor(lines), updatedAt: new Date() };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

// Todos los pedidos, del más nuevo al más viejo. orderBy sobre un solo campo
// (sin where) usa el índice automático de Firestore: no hace falta índice
// compuesto.
export async function listOrderHistory(limit = 300) {
  const db = getDb();
  const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Cierra en la app una venta confirmada que se anuló (desde Caja o en Odoo):
// pasa a cancelado y libera el stock que seguía reservado en lo que faltaba
// entregar. Si ya estaba cancelada no hace nada (la sincronización puede
// encontrar la misma anulación más de una vez).
export async function closeConfirmedOrder(orderId, user, reason, { fromOdoo = false } = {}) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = { id: snap.id, ...snap.data() };
    if (order.status === 'cancelado') return order;
    assertClosable(order, { fromOdoo });
    const deltas = reservationDeltas(order.lines, []);
    const reserved = await readReservations(db, [...deltas.keys()], tx);
    writeReservations(tx, db, reserved, deltas);
    const now = new Date();
    const update = { status: 'cancelado', cancelledAt: now, cancelledBy: user, cancelReason: reason, updatedAt: now };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}
