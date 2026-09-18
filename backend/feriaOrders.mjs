import { getDb } from './feriaOdoo.mjs';

const COLLECTION = 'feria_orders';
const PAYMENT_METHODS = new Set(['efectivo', 'tarjeta']);

export function validateOrderInput(input) {
  const errors = [];
  if (!input.sellerId) errors.push('Falta identificar al vendedor');
  if (!input.customer?.name?.trim()) errors.push('Falta el nombre del cliente');
  if (!PAYMENT_METHODS.has(input.paymentMethod)) errors.push('Método de pago inválido');
  if (!input.pricelistId) errors.push('Falta elegir una lista de precio');
  if (!input.lines?.length) errors.push('El pedido necesita al menos una línea de producto');
  for (const line of input.lines ?? []) {
    if (!(line.qty > 0)) errors.push(`Cantidad inválida (cantidad debe ser mayor a 0) para ${line.name ?? line.sku ?? 'un producto'}`);
    if (!(line.unitPrice >= 0)) errors.push(`Precio inválido para ${line.name ?? line.sku ?? 'un producto'}`);
  }
  return { valid: errors.length === 0, errors };
}

export async function createOrder(input) {
  const { valid, errors } = validateOrderInput(input);
  if (!valid) throw new Error(errors.join('; '));

  const db = getDb();
  const order = {
    sellerId: input.sellerId,
    sellerName: input.sellerName,
    customer: input.customer,
    paymentMethod: input.paymentMethod,
    pricelistId: input.pricelistId,
    pricelistName: input.pricelistName,
    lines: input.lines,
    invoiceType: null,
    status: 'pendiente',
    errorDetail: null,
    odooOrderId: null,
    invoiceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const ref = await db.collection(COLLECTION).add(order);
  return { id: ref.id, ...order };
}

export async function listOrdersByStatus(status) {
  const db = getDb();
  const snap = await db.collection(COLLECTION)
    .where('status', '==', status)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getOrderById(id) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function updateOrderPayment(id, { paymentMethod, invoiceType }) {
  const db = getDb();
  const update = { updatedAt: new Date() };
  if (paymentMethod) update.paymentMethod = paymentMethod;
  if (invoiceType !== undefined) update.invoiceType = invoiceType;
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
