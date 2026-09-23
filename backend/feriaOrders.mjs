import { getDb } from './feriaOdoo.mjs';
import { PAYMENT_METHODS as PAYMENT_METHOD_INFO, SHIPPING_COST } from './feriaPricing.mjs';
import {
  validateLineDelivery, validateShipping, needsShipping, assignLineIds, reservationDeltas,
  applyLineAction, assertLineActionAllowed, hasPendingDeliveries, assertCancellable, shippingCostFor,
} from './feriaLines.mjs';
import { fetchOdooStock, readReservations, checkAvailability, writeReservations } from './feriaStock.mjs';

const COLLECTION = 'feria_orders';
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

  await db.runTransaction(async (tx) => {
    const reserved = await readReservations(db, [...deltas.keys()], tx);
    const stockErrors = checkAvailability(odooStock, reserved, deltas);
    if (stockErrors.length) throw new Error(`Sin stock suficiente — ${stockErrors.join('; ')}`);
    writeReservations(tx, db, reserved, deltas);
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

// Cambia el medio de pago y/o el tipo de factura de un pedido ya creado.
// El medio de pago se valida contra la tabla de precios (nada de valores
// viejos como 'tarjeta' ni basura), y si cambia hay que RE-PRECIAR las
// líneas: el descuento del medio de pago ya está aplicado en el unitPrice
// guardado, así que dejarlo como está cobraría el descuento anterior.
// El descuento es puramente multiplicativo, así que alcanza con deshacer el
// porcentaje viejo y aplicar el nuevo — no hace falta volver a buscar el
// precio de tabla original.
export async function updateOrderPayment(id, { paymentMethod, invoiceType }) {
  if (paymentMethod && !Object.hasOwn(PAYMENT_METHOD_INFO, paymentMethod)) {
    throw new Error(`Método de pago inválido: ${paymentMethod}`);
  }

  const currentOrder = await getOrderById(id);
  if (!currentOrder) throw new Error('Pedido no encontrado');

  // Un pedido ya confirmado/facturado ya viajó a Odoo con sus precios. Volver
  // a preciarlo acá solo cambiaría Firestore y dejaría las dos puntas
  // divergentes — justo lo que el corte temprano de /confirm evita del otro
  // lado.
  if (currentOrder.status === 'confirmado' || currentOrder.status === 'facturado') {
    throw new Error('No se puede cambiar el medio de pago de un pedido ya confirmado');
  }

  const db = getDb();
  const update = { updatedAt: new Date() };
  if (paymentMethod) update.paymentMethod = paymentMethod;
  if (invoiceType !== undefined) update.invoiceType = invoiceType;

  if (paymentMethod && paymentMethod !== currentOrder.paymentMethod) {
    if (!Object.hasOwn(PAYMENT_METHOD_INFO, currentOrder.paymentMethod)) {
      throw new Error(`El pedido tiene un medio de pago desconocido (${currentOrder.paymentMethod}): no se pueden recalcular los precios`);
    }
    const oldPct = PAYMENT_METHOD_INFO[currentOrder.paymentMethod].discountPct;
    const newPct = PAYMENT_METHOD_INFO[paymentMethod].discountPct;
    update.lines = (currentOrder.lines ?? []).map((l) => {
      if (typeof l.unitPrice !== 'number' || !Number.isFinite(l.unitPrice)) {
        throw new Error(`Precio inválido en la línea ${l.sku ?? 'sin SKU'}: no se puede recalcular`);
      }
      return { ...l, unitPrice: Math.round((l.unitPrice / (1 - oldPct / 100)) * (1 - newPct / 100)) };
    });
  }

  await db.collection(COLLECTION).doc(id).update(update);
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

export async function markOrderConfirmed(id, { odooOrderId, invoiceId = null }) {
  const db = getDb();
  await db.collection(COLLECTION).doc(id).update({
    status: invoiceId ? 'facturado' : 'confirmado',
    odooOrderId, invoiceId, errorDetail: null, updatedAt: new Date(),
  });
}

export async function markOrderError(id, errorDetail) {
  const db = getDb();
  await db.collection(COLLECTION).doc(id).update({
    status: 'error', errorDetail, updatedAt: new Date(),
  });
}

// Aplica la misma acción a una o más líneas del pedido y ajusta las reservas,
// todo en una transacción (pedido + contadores de reserva juntos).
export async function applyOrderLineActions(orderId, lineIds, action, { user, changes } = {}) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);

  // Mover una línea de ubicación reserva en la nueva: hace falta el stock de
  // Odoo, que se lee afuera de la transacción.
  let odooStock = null;
  if (action === 'edit' && changes?.location) {
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
