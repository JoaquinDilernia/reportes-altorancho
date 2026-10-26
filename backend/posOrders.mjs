// Pedidos del POS. El vendedor arma un carrito (ya numerado y reservando
// stock) y lo manda a caja; caja lo completa (pago, descuento, factura) y lo
// confirma. Queries de un solo campo: queueKey (local+estado) y monthKey
// (local+mes), sin índices compuestos.
// Una venta con líneas de varios depósitos de origen se parte en un pedido de
// Odoo por origen (local / Rolón): `odooOrders` lista todos.
import { getDb } from './firestore.mjs';
import {
  getLocale, getLocales, getSettings, getPaymentMethodsById, originLocationId, localeIdsOf, resolveOdooPaymentName,
  returnDestinationsOf,
} from './posConfig.mjs';
import { computeTotals, computeExchangeTotals, collectOf, round2 } from './posPricing.mjs';
import {
  buildReturnLine, editReturnLine, validateReturnLine, returnTotal, orderKind, validateRefund,
} from './posReturns.mjs';
import { consumeCreditsInTx, restoreCreditsInTx, createCreditInTx, buildCredit } from './posCredits.mjs';
import { resolveExtraDiscount, listActivePromotions } from './posPromotions.mjs';
import { getCatalogProducts, fetchFreeStock, stockLocationIds } from './posCatalog.mjs';
import {
  buildLine, editLine, reservationDeltas, needsShipping, validateShipping, formatOrderNumber, isConfirming,
  CONFIRMING_MESSAGE, activeLines,
} from './posLines.mjs';
import { readReservations, checkAvailability, writeReservations } from './posStock.mjs';
import { isValidCuit } from './feriaOdoo.mjs';

export const COLLECTION = 'pos_orders';
const COUNTERS = 'pos_counters';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CASH_CLOSED_MESSAGE = 'La caja del local está cerrada: abrila en "Caja del día" para confirmar ventas';
const ALREADY_IN_ODOO = 'El pedido ya existe en Odoo: reintentá confirmar o resolvelo en Odoo';

const pesos = (n) => `$ ${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
const toDate = (v) => (v?.toDate ? v.toDate() : new Date(v));

// Mes en hora de Argentina (UTC-3, sin horario de verano).
function argMonth(date) {
  const d = new Date(toDate(date).getTime() - 3 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function orderKeys({ localId, status, createdAt }) {
  return { queueKey: `${localId}_${status}`, monthKey: `${localId}_${argMonth(createdAt)}` };
}

// Líneas activas separadas por depósito de origen: un pedido de Odoo por grupo.
export function orderGroups(lines) {
  const active = activeLines(lines);
  return { local: active.filter((l) => l.origin !== 'rolon'), rolon: active.filter((l) => l.origin === 'rolon') };
}

export const joinOdooNames = (odooOrders) => (odooOrders ?? []).map((o) => o.odooOrderName).filter(Boolean).join(' + ');

export function validateCustomer(c, { wantsInvoice }) {
  const errors = [];
  if (!c?.name?.trim()) errors.push('Falta el nombre del cliente');
  const digits = String(c?.docNumber ?? '').replace(/\D/g, '');
  if (!digits) errors.push('Falta el DNI/CUIT del cliente');
  const phone = String(c?.phone ?? '').replace(/\D/g, '');
  if (!phone) errors.push('Falta el teléfono del cliente');
  else if (phone.length < 8) errors.push('Teléfono inválido: tiene que tener al menos 8 números');
  const email = c?.email?.trim() ?? '';
  if (!email) errors.push('Falta el email del cliente');
  else if (!EMAIL_PATTERN.test(email)) errors.push('Email inválido');
  if (wantsInvoice && digits.length === 11) {
    if (!isValidCuit(digits)) errors.push('El CUIT no es válido');
    else if (!c.afipResponsibility) errors.push('Para facturar a un CUIT falta la condición de IVA (buscalo en ARCA)');
  }
  return errors;
}

export function validatePayments(payments, methodsById) {
  if (!Array.isArray(payments) || !payments.length) throw new Error('Cargá al menos un medio de pago');
  const seen = new Set();
  return payments.map(({ methodId, detailId = null, amount = null }) => {
    const method = methodsById.get(methodId);
    if (!method || method.active === false) throw new Error(`Medio de pago inválido: ${methodId}`);
    resolveOdooPaymentName(method, detailId); // tira si falta el detalle (cuotas)
    const key = `${methodId}:${detailId ?? ''}`;
    if (seen.has(key)) throw new Error(`${method.label} está repetido: sumá los montos en uno solo`);
    seen.add(key);
    if (payments.length === 1) return { methodId, detailId, amount: null };
    const n = typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : amount;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`Monto inválido para ${method.label}`);
    return { methodId, detailId, amount: round2(n) };
  });
}

export function assertPaymentsMatchTotal(payments, total) {
  if (payments.length < 2) return;
  const paid = round2(payments.reduce((sum, p) => sum + p.amount, 0));
  if (Math.abs(paid - total) >= 0.01) {
    throw new Error(`Los pagos suman ${pesos(paid)} y el total es ${pesos(total)}: corregí los montos del pago dividido`);
  }
}

export function priceOrder(order, { methodsById, promotions, now }) {
  const ctx = {
    paymentMethodIds: (order.payments ?? []).map((p) => p.methodId),
    customerTagIds: order.customer?.tagIds ?? [],
    now,
  };
  const extraDiscount = resolveExtraDiscount(promotions, order.discountChoice ?? {}, ctx);
  const args = {
    lines: order.lines, payments: order.payments ?? [], methodsById, extraDiscount,
    shippingAmount: needsShipping(order.lines) ? (order.shipping?.amount ?? 0) : 0,
    homeServiceAmount: needsShipping(order.lines) ? (order.shipping?.homeServiceAmount ?? 0) : 0,
  };
  const totals = order.returnLines?.length
    ? computeExchangeTotals({ ...args, returnValue: returnTotal(order.returnLines) })
    : computeTotals(args);
  return { extraDiscount, totals };
}

// Pedido que ya existe en Odoo: los precios quedaron fijos, no se recalculan.
export function claimPricing(order, { methodsById, promotions, now }) {
  if (order.odooOrderId && order.totals) {
    return { payments: order.payments, extraDiscount: order.extraDiscount ?? null, totals: order.totals };
  }
  const exchange = Boolean(order.returnLines?.length);
  // Cambio/devolución sin nada para cobrar: no lleva medio de pago.
  if (exchange) {
    const draft = priceOrder({ ...order, payments: [] }, { methodsById, promotions, now });
    if (collectOf(draft.totals) === 0) return { payments: [], extraDiscount: draft.extraDiscount, totals: draft.totals };
  }
  const payments = validatePayments(order.payments, methodsById);
  const { extraDiscount, totals } = priceOrder({ ...order, payments }, { methodsById, promotions, now });
  assertPaymentsMatchTotal(payments, collectOf(totals));
  return { payments, extraDiscount, totals };
}

export function returnCtx(locale, settings) {
  return { destinationIds: returnDestinationsOf(locale, settings).map((d) => d.id), reasons: settings.returnReasons };
}

// La NC y el saldo son del cliente de la compra original (spec §5.3).
export function assertHolder(order) {
  const doc = String(order.customer?.docNumber ?? '').replace(/\D/g, '');
  const others = (order.returnLines ?? []).filter((l) => l.partnerVat && l.partnerVat !== doc);
  if (others.length && !String(order.holderChangeReason ?? '').trim()) {
    throw new Error('La compra es de otro cliente: escribí el motivo del cambio de titular');
  }
}

// Con saldo ya descontado (reclamo previo que falló) el pago no se toca: la
// asignación guardada se desviaría de lo que se cobra.
export function assertPaymentsEditable(order, patch) {
  if (patch.payments !== undefined && order.creditAllocation?.length) {
    throw new Error('El saldo a favor de este pedido ya se descontó: para cambiar el pago anulá el pedido y armalo de nuevo');
  }
}

// Con el plan de devolución guardado (la confirmación ya empezó) lo que vuelve
// no se toca: los remitos seguirían el plan viejo y la NC las líneas nuevas.
export function assertReturnLinesEditable(order) {
  if (order.returnSteps?.plan) {
    throw new Error('Esta devolución ya empezó a cargarse en Odoo: para cambiar lo que vuelve anulá el pedido y armalo de nuevo');
  }
}

// ¿Hay algún documento de la devolución creado en Odoo? (el plan solo no cuenta)
export function hasReturnDocsInOdoo(returnSteps) {
  return ['pickings', 'transfers', 'creditNotes'].some((k) => Object.keys(returnSteps?.[k] ?? {}).length > 0);
}

export function saldoAmount(payments, totals) {
  const saldo = (payments ?? []).find((p) => p.methodId === 'saldo');
  if (!saldo) return 0;
  return payments.length === 1 || saldo.amount == null ? collectOf(totals) : saldo.amount;
}

// Con saldo ya descontado (reclamo previo que falló) lo que se paga con saldo
// tiene que seguir igual a lo descontado: si el total cambió (precios, promos),
// la asignación guardada ya no corresponde.
export function assertCreditAllocationMatches(creditAllocation, saldo) {
  if (!creditAllocation?.length) return;
  const allocated = round2(creditAllocation.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  if (Math.abs(allocated - round2(saldo)) > 0.01 + 1e-9) {
    throw new Error('El total cambió después de descontar el saldo a favor: anulá el pedido y armalo de nuevo');
  }
}

// Saldo a devolver al anular: lo descontado, esté o no confirmado el pedido
// (confirmado solo se anula una venta común; los cambios se rechazan antes).
export const creditsToRestore = (order) => (order.creditAllocation?.length ? order.creditAllocation : null);

export function assertCustomerShape(c) {
  const ok = c && typeof c === 'object' && !Array.isArray(c)
    && ['docNumber', 'name', 'phone', 'email'].every((k) => typeof c[k] === 'string')
    && ['street', 'city', 'zip'].every((k) => c[k] == null || typeof c[k] === 'string');
  if (!ok) throw new Error('Datos del cliente inválidos');
}

export function assertCartEditable(order, user) {
  if (order.sellerId !== user.id) throw new Error('Este carrito es de otro vendedor');
  if (order.status === 'descartado') throw new Error('Este carrito se vació');
  if (order.status !== 'carrito') throw new Error(`El pedido ${order.number} ya se mandó a caja`);
}

export function assertDraftEditable(order) {
  if (!['pendiente', 'error'].includes(order.status)) throw new Error('La venta ya se confirmó: no se puede cambiar desde acá');
  if (order.odooOrderId) throw new Error(ALREADY_IN_ODOO);
  if (isConfirming(order)) throw new Error(CONFIRMING_MESSAGE);
}

// ---- Firestore ----

const withId = (snap) => ({ id: snap.id, ...snap.data() });
const counterRef = (db, localId) => db.collection(COUNTERS).doc(`orders_${localId}`);
export const cashPointerRef = (db, localId) => db.collection(COUNTERS).doc(`cash_${localId}`);
const forbidden = () => Object.assign(new Error('No tenés acceso a ese local'), { status: 403 });

async function lineCtx(localId) {
  const [locale, locales, settings] = await Promise.all([getLocale(localId), getLocales(), getSettings()]);
  return {
    locale, settings, locales,
    validation: { localId, localeIds: localeIdsOf(locales) },
    locate: (origin) => originLocationId(locale, settings, origin),
  };
}

// Stock libre de Odoo de los productos tocados (HTTP lento: afuera de la
// transacción; las reservas se leen adentro).
async function stockFor(lines, ctx) {
  return fetchFreeStock(lines.map((l) => l.productId), stockLocationIds(ctx.locales, ctx.settings));
}

// Lee las reservas de las claves del delta DENTRO de la transacción, valida
// disponibilidad y devuelve la función que las escribe (después de todas las lecturas).
async function reserveInTx(tx, db, ctx, freeStock, before, after) {
  const deltas = reservationDeltas(before, after, ctx.locate);
  const reserved = await readReservations(db, [...deltas.keys()], tx);
  const skuById = new Map([...(before?.lines ?? []), ...(after?.lines ?? [])].map((l) => [l.productId, l.sku]));
  const errors = checkAvailability(freeStock, reserved, deltas, skuById);
  if (errors.length) throw new Error(`Sin stock suficiente — ${errors.join('; ')}`);
  return () => writeReservations(tx, db, reserved, deltas);
}

async function productFor(productId, ctx) {
  const product = (await getCatalogProducts([productId], ctx.settings)).get(productId);
  if (!product) throw new Error('Producto no encontrado en Odoo');
  return product;
}

export async function createCart(user, lineInput) {
  const ctx = await lineCtx(user.localId);
  const line = buildLine(await productFor(lineInput.productId, ctx), lineInput, [], ctx.validation);
  const freeStock = await stockFor([line], ctx);
  const db = getDb();
  const ref = db.collection(COLLECTION).doc();
  const now = new Date();
  const order = {
    localId: user.localId, sellerId: user.id, sellerName: user.name, status: 'carrito', lines: [line],
    kind: 'venta', returnLines: [], refund: null, creditAllocation: null, holderChangeReason: '', returnSteps: {},
    customer: null, shipping: null, payments: [], discountChoice: null, extraDiscount: null, totals: null,
    wantsInvoice: false, notes: '', odooOrders: [], odooOrderId: null, createdAt: now, updatedAt: now,
  };
  Object.assign(order, orderKeys(order));
  await db.runTransaction(async (tx) => {
    const counter = await tx.get(counterRef(db, user.localId));
    const commit = await reserveInTx(tx, db, ctx, freeStock, null, order);
    const next = (counter.exists ? counter.data().next : 0) + 1;
    order.number = formatOrderNumber(user.localId, next);
    commit();
    tx.set(counterRef(db, user.localId), { next });
    tx.set(ref, order);
  });
  return { id: ref.id, ...order };
}

// Cambia líneas de un carrito (vendedor/caja dueño) o de un pedido en caja
// (pendiente/error) y ajusta las reservas en la misma transacción.
async function changeLines(orderId, user, change, touched = []) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  const firstSnap = await ref.get();
  if (!firstSnap.exists) throw new Error('Pedido no encontrado');
  const first = withId(firstSnap);
  const ctx = await lineCtx(first.localId);
  const freeStock = touched.length ? await stockFor(touched, ctx) : new Map();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = withId(snap);
    if (order.status === 'carrito') assertCartEditable(order, user);
    else {
      if (order.localId !== user.localId) throw forbidden();
      assertDraftEditable(order);
    }
    let lines = change(order.lines, ctx, order);
    // En carrito la línea sacada desaparece; en caja queda 'eliminado'.
    if (order.status === 'carrito') lines = lines.filter((l) => l.status !== 'eliminado');
    const commit = await reserveInTx(tx, db, ctx, freeStock, order, { ...order, lines });
    commit();
    const update = { lines, updatedAt: new Date() };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

export async function addCartLine(orderId, user, lineInput) {
  const order = await getOrder(orderId);
  const ctx = await lineCtx(order.localId);
  const product = await productFor(lineInput.productId, ctx);
  const probe = buildLine(product, lineInput, [], ctx.validation);
  return changeLines(orderId, user, (lines, c) => [...lines, buildLine(product, lineInput, lines, c.validation)], [probe]);
}

export async function updateLine(orderId, user, lineId, changes) {
  const order = await getOrder(orderId);
  const current = order.lines.find((l) => l.lineId === lineId);
  if (!current) throw new Error('Línea no encontrada');
  return changeLines(orderId, user, (lines, c) => lines.map((l) => (l.lineId === lineId ? editLine(l, changes, c.validation) : l)), [current]);
}

// Marca la línea como eliminada (changeLines la saca del todo si es carrito).
export function removeLine(orderId, user, lineId) {
  return changeLines(orderId, user, (lines, _ctx, order) => {
    const target = lines.find((l) => l.lineId === lineId && l.status === 'activo');
    if (!target) throw new Error('Línea no encontrada');
    const others = lines.some((l) => l.lineId !== lineId && l.status === 'activo');
    if (!others && !(order.returnLines ?? []).length) {
      throw new Error('No se puede sacar la última línea: vaciá el carrito o anulá el pedido');
    }
    return lines.map((l) => (l.lineId === lineId ? { ...l, status: 'eliminado' } : l));
  });
}

export async function discardCart(orderId, user) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  const ctx = await lineCtx((await getOrder(orderId)).localId);
  return db.runTransaction(async (tx) => {
    const order = withId(await tx.get(ref));
    assertCartEditable(order, user);
    const after = { ...order, status: 'descartado' };
    const commit = await reserveInTx(tx, db, ctx, new Map(), order, after);
    commit();
    const update = { status: 'descartado', ...orderKeys(after), discardedAt: new Date(), updatedAt: new Date() };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

// ---- Lo que vuelve (cambio / devolución) ----
// No reserva stock: entra a Odoo recién al confirmar. `purchaseLine` siempre
// viene de posReturnsService (leída en el servidor).

async function returnLineCtx(localId) {
  const [locale, settings] = await Promise.all([getLocale(localId), getSettings()]);
  return returnCtx(locale, settings);
}

export async function createReturnCart(user, purchaseLine, input) {
  const ctx = await returnLineCtx(user.localId);
  const returnLine = buildReturnLine(purchaseLine, input, [], ctx);
  const db = getDb();
  const ref = db.collection(COLLECTION).doc();
  const now = new Date();
  const order = {
    localId: user.localId, sellerId: user.id, sellerName: user.name, status: 'carrito', lines: [], returnLines: [returnLine],
    kind: 'devolucion', refund: null, creditAllocation: null, holderChangeReason: '', returnSteps: {},
    customer: null, shipping: null, payments: [], discountChoice: null, extraDiscount: null, totals: null,
    wantsInvoice: false, notes: '', odooOrders: [], odooOrderId: null, createdAt: now, updatedAt: now,
  };
  Object.assign(order, orderKeys(order));
  await db.runTransaction(async (tx) => {
    const counter = await tx.get(counterRef(db, user.localId));
    const next = (counter.exists ? counter.data().next : 0) + 1;
    order.number = formatOrderNumber(user.localId, next);
    tx.set(counterRef(db, user.localId), { next });
    tx.set(ref, order);
  });
  return { id: ref.id, ...order };
}

async function changeReturnLines(orderId, user, change) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  const first = await getOrder(orderId);
  const ctx = await returnLineCtx(first.localId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = withId(snap);
    if (order.status === 'carrito') assertCartEditable(order, user);
    else {
      if (order.localId !== user.localId) throw forbidden();
      assertDraftEditable(order);
    }
    assertReturnLinesEditable(order);
    const returnLines = change(order.returnLines ?? [], ctx, order);
    const update = { returnLines, kind: orderKind({ lines: order.lines, returnLines }), updatedAt: new Date() };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

export const addReturnLine = (orderId, user, purchaseLine, input) =>
  changeReturnLines(orderId, user, (current, ctx) => [...current, buildReturnLine(purchaseLine, input, current, ctx)]);

export const updateReturnLine = (orderId, user, rlId, changes) =>
  changeReturnLines(orderId, user, (current, ctx) => {
    if (!current.some((l) => l.rlId === rlId)) throw new Error('Línea no encontrada');
    return current.map((l) => (l.rlId === rlId ? editReturnLine(l, changes, ctx) : l));
  });

export const removeReturnLine = (orderId, user, rlId) =>
  changeReturnLines(orderId, user, (current, _ctx, order) => {
    if (!current.some((l) => l.rlId === rlId)) throw new Error('Línea no encontrada');
    const next = current.filter((l) => l.rlId !== rlId);
    if (!next.length && !activeLines(order.lines).length) throw new Error('No se puede sacar la última línea: vaciá el carrito o anulá el pedido');
    return next;
  });

export async function searchAppPurchases({ doc = null, number = null }) {
  if (!doc && !number) return [];
  const col = getDb().collection(COLLECTION);
  const snap = number ? await col.where('number', '==', number).get() : await col.where('customer.docNumber', '==', doc).get();
  return snap.docs.map(withId)
    .filter((o) => o.status === 'confirmado' && activeLines(o.lines).length && o.odooOrders?.length)
    .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt)).slice(0, 30);
}

export async function listMyCarts(user) {
  const snap = await getDb().collection(COLLECTION).where('queueKey', '==', `${user.localId}_carrito`).get();
  return snap.docs.map(withId).filter((o) => o.status === 'carrito' && o.sellerId === user.id)
    .sort((a, b) => toDate(a.createdAt) - toDate(b.createdAt));
}

const cleanCustomer = (c) => ({
  docNumber: String(c.docNumber).replace(/\D/g, ''), name: c.name.trim(), phone: c.phone.trim(), email: c.email.trim(),
  street: c.street?.trim() || '', city: c.city?.trim() || '', zip: c.zip?.trim() || '',
  afipResponsibility: c.afipResponsibility ?? null, fromArca: Boolean(c.fromArca),
  odooPartnerId: c.odooPartnerId ?? null, tagIds: Array.isArray(c.tagIds) ? c.tagIds.map(Number) : [],
});

// Motivo del cambio de titular que manda el vendedor: solo con algo que vuelve.
export function cleanHolderReason(reason, returnLines) {
  if (!(returnLines ?? []).length || reason == null) return '';
  return String(reason).trim().slice(0, 200);
}

export async function submitCart(orderId, user, { customer, shipping, holderChangeReason }) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const order = withId(await tx.get(ref));
    assertCartEditable(order, user);
    const errors = validateCustomer(customer, { wantsInvoice: false });
    const withShipping = needsShipping(order.lines);
    if (withShipping) errors.push(...validateShipping(shipping));
    if (!activeLines(order.lines).length && !(order.returnLines ?? []).length) errors.push('El pedido no tiene productos');
    if (errors.length) throw new Error(errors.join('; '));
    const next = {
      kind: orderKind({ lines: order.lines, returnLines: order.returnLines }),
      status: 'pendiente', customer: cleanCustomer(customer), shipping: withShipping ? shipping : null,
      sentAt: new Date(), updatedAt: new Date(),
    };
    const reason = cleanHolderReason(holderChangeReason, order.returnLines);
    if (reason) next.holderChangeReason = reason;
    Object.assign(next, orderKeys({ ...order, ...next }));
    tx.update(ref, next);
    return { ...order, ...next };
  });
}

export async function getOrder(id) {
  const snap = await getDb().collection(COLLECTION).doc(id).get();
  if (!snap.exists) throw new Error('Pedido no encontrado');
  return withId(snap);
}

export async function listQueue(localId) {
  const snap = await getDb().collection(COLLECTION)
    .where('queueKey', 'in', [`${localId}_pendiente`, `${localId}_error`]).get();
  return snap.docs.map(withId).sort((a, b) => toDate(a.sentAt ?? a.createdAt) - toDate(b.sentAt ?? b.createdAt));
}

// Caja completa el pedido antes de confirmar. `patch` puede traer:
// customer, shipping, payments, discountChoice, wantsInvoice, notes.
export async function updateDraft(orderId, user, patch) {
  const methodsById = await getPaymentMethodsById();
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = withId(snap);
    if (order.localId !== user.localId) throw forbidden();
    if (patch.notes !== undefined && Object.keys(patch).length === 1 && order.status === 'confirmado') {
      const update = { notes: String(patch.notes).slice(0, 1000), updatedAt: new Date() };
      tx.update(ref, update);
      return { ...order, ...update };
    }
    assertDraftEditable(order);
    assertPaymentsEditable(order, patch);
    const update = { updatedAt: new Date() };
    if (patch.customer !== undefined) {
      assertCustomerShape(patch.customer);
      update.customer = cleanCustomer(patch.customer);
    }
    if (patch.shipping !== undefined) update.shipping = patch.shipping;
    if (patch.payments !== undefined) update.payments = validatePayments(patch.payments, methodsById);
    if (patch.discountChoice !== undefined) update.discountChoice = patch.discountChoice;
    if (patch.wantsInvoice !== undefined) update.wantsInvoice = Boolean(patch.wantsInvoice);
    if (patch.notes !== undefined) update.notes = String(patch.notes).slice(0, 1000);
    if (patch.refund !== undefined) update.refund = patch.refund === null ? null : {
      cashBack: Array.isArray(patch.refund.cashBack) ? patch.refund.cashBack.map(({ methodId, amount }) => ({ methodId: String(methodId), amount: Number(amount) })) : [],
      credit: Number(patch.refund.credit ?? 0),
    };
    if (patch.holderChangeReason !== undefined) update.holderChangeReason = String(patch.holderChangeReason).trim().slice(0, 200);
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

// Reclama el pedido para confirmarlo: valida todo, fija precios y totales, y
// lo ata a la caja abierta del local. Si ya está confirmado, lo devuelve.
export async function claimOrderForConfirm(orderId, user) {
  const [methodsById, promotions, locale, settings] = await Promise.all([
    getPaymentMethodsById(), listActivePromotions(), getLocale(user.localId), getSettings(),
  ]);
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = withId(snap);
    if (order.localId !== user.localId) throw forbidden();
    if (order.status === 'confirmado') return { order, alreadyConfirmed: true };
    if (!['pendiente', 'error'].includes(order.status)) throw new Error('Este pedido no se puede confirmar');
    if (isConfirming(order)) throw new Error(CONFIRMING_MESSAGE);
    const pointer = await tx.get(cashPointerRef(db, order.localId));
    const cashSessionId = pointer.data()?.openSessionId;
    if (!cashSessionId) throw new Error(CASH_CLOSED_MESSAGE);
    const errors = validateCustomer(order.customer, { wantsInvoice: order.wantsInvoice });
    if (needsShipping(order.lines)) errors.push(...validateShipping(order.shipping));
    const exchange = Boolean(order.returnLines?.length);
    if (!activeLines(order.lines).length && !exchange) errors.push('El pedido no tiene productos');
    if (exchange) {
      const ctx = returnCtx(locale, settings);
      for (const l of order.returnLines) errors.push(...validateReturnLine(l, ctx));
    }
    if (errors.length) throw new Error(errors.join('; '));
    const { payments, extraDiscount, totals } = claimPricing(order, { methodsById, promotions, now: Date.now() });
    let refund = null;
    let creditCommit = null;
    let creditAllocation = order.creditAllocation ?? null;
    if (exchange) {
      assertHolder(order);
      refund = validateRefund(order.refund, totals.net, methodsById);
    }
    const saldo = saldoAmount(payments, totals);
    assertCreditAllocationMatches(creditAllocation, saldo);
    if (saldo > 0 && !creditAllocation?.length) {
      const consumed = await consumeCreditsInTx(tx, db, {
        docNumber: order.customer.docNumber, amount: saldo, orderId: order.id, orderNumber: order.number, user: user.name, nowMs: Date.now(),
      });
      creditAllocation = consumed.allocation;
      creditCommit = consumed.commit;
    }
    if (creditCommit) creditCommit();
    const update = {
      confirmingSince: new Date(), cashSessionId, payments, extraDiscount, totals, refund, creditAllocation,
      kind: orderKind(order), updatedAt: new Date(),
    };
    tx.update(ref, update);
    return { order: { ...order, ...update }, alreadyConfirmed: false };
  });
}

async function patchOrder(id, update) {
  await getDb().collection(COLLECTION).doc(id).update({ ...update, updatedAt: new Date() });
}

// `odooOrderId` siempre refleja el primer pedido de Odoo (lo usa assertDraftEditable).
export const saveOdooOrders = (id, odooOrders) => patchOrder(id, { odooOrders, odooOrderId: odooOrders[0]?.odooOrderId ?? null });
export const saveOdooLineIds = (id, lines) => patchOrder(id, { lines });
export const setOrderWarning = (id, warning) => patchOrder(id, { warning });
export const markOrderInvoiced = (id, { invoiceId, invoiceName }) => patchOrder(id, { invoiceId, invoiceName, invoiceError: null });
export const setInvoiceError = (id, invoiceError) => patchOrder(id, { invoiceError });
export const saveReturnSteps = (id, returnSteps) => patchOrder(id, { returnSteps });
export const saveAppliedCreditNotes = (id, appliedCreditNoteIds) => patchOrder(id, { appliedCreditNoteIds });
// Pasos después de confirmar (Exhibición, entrega en el acto, factura) terminados.
export const clearPostConfirmPending = (id) => patchOrder(id, { postConfirmPending: false });

// Solo marca error si el pedido sigue en caja; si ya se confirmó no hace nada.
export async function markOrderError(id, errorDetail) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = withId(snap);
    if (!['pendiente', 'error'].includes(order.status)) return false;
    tx.update(ref, { status: 'error', errorDetail, confirmingSince: null, ...orderKeys({ ...order, status: 'error' }), updatedAt: new Date() });
    return true;
  });
}

// Confirmado en Odoo: la reserva pasa a Odoo y la de la app se libera.
export async function markOrderConfirmed(id, { odooOrders, user }) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(id);
  const ctx = await lineCtx((await getOrder(id)).localId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = withId(snap);
    if (order.status === 'confirmado') return order;
    if (!['pendiente', 'error'].includes(order.status)) throw new Error('Este pedido no se puede confirmar');
    const after = { ...order, status: 'confirmado' };
    const commit = await reserveInTx(tx, db, ctx, new Map(), order, after);
    commit();
    const update = {
      status: 'confirmado', odooOrders, odooOrderId: odooOrders[0]?.odooOrderId ?? null, odooOrderName: joinOdooNames(odooOrders),
      confirmingSince: null, errorDetail: null, confirmedAt: new Date(), confirmedBy: user, postConfirmPending: true,
      ...orderKeys(after), updatedAt: new Date(),
    };
    if (order.refund?.credit > 0) {
      const creditNoteIds = Object.values(order.returnSteps?.creditNotes ?? {}).map((n) => n.id).filter(Boolean);
      createCreditInTx(tx, db, order.id, buildCredit({
        order, amount: order.refund.credit, days: ctx.settings.creditValidityDays, nowMs: Date.now(), user, creditNoteIds,
      }));
    }
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

export async function markLinesDelivered(id, lineIds, user) {
  const order = await getOrder(id);
  const now = new Date();
  const lines = order.lines.map((l) => (lineIds.includes(l.lineId) ? { ...l, status: 'entregado', deliveredAt: now, deliveredBy: user } : l));
  await patchOrder(id, { lines });
}

// Anulación en la app (Odoo ya se canceló): libera reservas si quedaban.
export async function markOrderAnnulled(id, user, reason) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(id);
  const ctx = await lineCtx((await getOrder(id)).localId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Pedido no encontrado');
    const order = withId(snap);
    if (!['pendiente', 'error', 'confirmado'].includes(order.status)) throw new Error('Este pedido no se puede anular');
    if (hasReturnDocsInOdoo(order.returnSteps)) throw new Error('Parte de la devolución ya está en Odoo: resolvelo en Odoo');
    const after = { ...order, status: 'anulado' };
    const toRestore = creditsToRestore(order);
    const restore = toRestore
      ? await restoreCreditsInTx(tx, db, toRestore, { orderId: order.id, orderNumber: order.number, user })
      : null;
    const commit = await reserveInTx(tx, db, ctx, new Map(), order, after);
    commit();
    if (restore) restore();
    const update = { creditAllocation: null, status: 'anulado', annulledAt: new Date(), annulledBy: user, annulReason: reason ?? '', ...orderKeys(after), updatedAt: new Date() };
    tx.update(ref, update);
    return { ...order, ...update };
  });
}

export async function recordAutoRetry(id) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(id);
  return db.runTransaction(async (tx) => {
    const order = withId(await tx.get(ref));
    if (order.status !== 'error') return false;
    tx.update(ref, { autoRetryCount: (order.autoRetryCount ?? 0) + 1, lastAutoRetryAt: new Date() });
    return true;
  });
}

// Historial: `months` = ['2026-10', ...]; Firestore admite hasta 30 valores en 'in'.
export async function listOrdersByMonth(localIds, months) {
  const keys = localIds.flatMap((l) => months.map((m) => `${l}_${m}`));
  const result = [];
  for (let i = 0; i < keys.length; i += 30) {
    const snap = await getDb().collection(COLLECTION).where('monthKey', 'in', keys.slice(i, i + 30)).get();
    result.push(...snap.docs.map(withId));
  }
  return result.filter((o) => o.status !== 'carrito' && o.status !== 'descartado')
    .sort((a, b) => toDate(b.createdAt) - toDate(a.createdAt));
}
