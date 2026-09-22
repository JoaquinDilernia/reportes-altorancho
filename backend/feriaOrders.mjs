import { getDb } from './feriaOdoo.mjs';
import { PAYMENT_METHODS as PAYMENT_METHOD_INFO } from './feriaPricing.mjs';

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
