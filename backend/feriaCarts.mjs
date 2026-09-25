// Carrito del vendedor: el pedido existe (con número) desde el primer
// producto y cada producto reserva stock en el momento, mientras el cliente
// recorre la feria. Mandarlo a caja lo pasa a 'pendiente' (el flujo de
// siempre); vaciarlo devuelve todo el stock. Ver isSentOrder en feriaLines.
import { getDb } from './feriaOdoo.mjs';
import { getFeriaProduct } from './feriaProducts.mjs';
import { getSellerCode } from './feriaAuth.mjs';
import { SHIPPING_COST } from './feriaPricing.mjs';
import { fetchOdooStock, readReservations, checkAvailability, writeReservations } from './feriaStock.mjs';
import {
  buildCartLine, assertCartEditable, applyLineAction, reservationDeltas, controlsStock,
  priceCartForSubmit, needsShipping, formatOrderNumber,
} from './feriaLines.mjs';
import {
  COLLECTION, validateOrderInput, sellerCounterRef, nextCounterValue, cleanCustomer, newOrderFields,
} from './feriaOrders.mjs';

function productOrThrow(sku) {
  const product = getFeriaProduct(sku);
  if (!product) throw new Error(`${sku} no está en la lista de precios de la feria`);
  return product;
}

// Stock de Odoo solo para lo que se controla (falla sale de Fallados, sin
// control). Es HTTP lento: se lee afuera de la transacción.
function stockFor(lines) {
  return fetchOdooStock(lines.filter((l) => controlsStock(l.location)).map((l) => l.sku));
}

async function reserve(tx, db, odooStock, beforeLines, afterLines) {
  const deltas = reservationDeltas(beforeLines, afterLines);
  const reserved = await readReservations(db, [...deltas.keys()], tx);
  const errors = checkAvailability(odooStock, reserved, deltas);
  if (errors.length) throw new Error(`Sin stock suficiente — ${errors.join('; ')}`);
  // Las escrituras van después de todas las lecturas de la transacción.
  return () => writeReservations(tx, db, reserved, deltas);
}

export async function createCart(seller, lineInput) {
  const product = productOrThrow(lineInput.sku);
  const line = buildCartLine(product, lineInput, []);
  const sellerCode = await getSellerCode(seller.id);
  const odooStock = await stockFor([line]);
  const db = getDb();
  const ref = db.collection(COLLECTION).doc();
  const counterRef = sellerCounterRef(db, sellerCode);
  const cart = {
    ...newOrderFields({ sellerId: seller.id, sellerName: seller.name, sellerCode, lines: [line] }),
    status: 'carrito',
  };
  await db.runTransaction(async (tx) => {
    const counter = await tx.get(counterRef);
    const commitReservations = await reserve(tx, db, odooStock, [], [line]);
    const next = nextCounterValue(counter);
    cart.number = formatOrderNumber(next, sellerCode);
    commitReservations();
    tx.set(counterRef, { next });
    tx.set(ref, cart);
  });
  return { id: ref.id, ...cart };
}

// Un solo where (sin índice compuesto); el estado se filtra acá.
export async function listSellerCarts(sellerId) {
  const snap = await getDb().collection(COLLECTION).where('sellerId', '==', sellerId).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((o) => o.status === 'carrito')
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
}

// Cambia las líneas del carrito y ajusta las reservas en la misma
// transacción: sumar o subir cantidad reserva, sacar o bajar devuelve.
async function changeCartLines(cartId, sellerId, change, odooStock = new Map()) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(cartId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Carrito no encontrado');
    const cart = { id: snap.id, ...snap.data() };
    assertCartEditable(cart, sellerId);
    const lines = change(cart.lines);
    const commitReservations = await reserve(tx, db, odooStock, cart.lines, lines);
    commitReservations();
    const update = { lines, updatedAt: new Date() };
    tx.update(ref, update);
    return { ...cart, ...update };
  });
}

async function readCart(cartId, sellerId) {
  const snap = await getDb().collection(COLLECTION).doc(cartId).get();
  if (!snap.exists) throw new Error('Carrito no encontrado');
  const cart = { id: snap.id, ...snap.data() };
  assertCartEditable(cart, sellerId);
  return cart;
}

export async function addCartLine(cartId, sellerId, lineInput) {
  const product = productOrThrow(lineInput.sku);
  const probe = buildCartLine(product, lineInput, []);
  const odooStock = await stockFor([probe]);
  return changeCartLines(cartId, sellerId, (lines) => [...lines, buildCartLine(product, lineInput, lines)], odooStock);
}

export async function updateCartLine(cartId, sellerId, lineId, { qty, location, delivery }) {
  const before = await readCart(cartId, sellerId);
  const current = before.lines.find((l) => l.lineId === lineId);
  if (!current) throw new Error('Línea no encontrada');
  const edited = applyLineAction(current, 'edit', { changes: { qty, location, delivery } });
  const odooStock = await stockFor([edited]);
  return changeCartLines(cartId, sellerId, (lines) => {
    if (!lines.some((l) => l.lineId === lineId)) throw new Error('Línea no encontrada');
    return lines.map((l) => (l.lineId === lineId ? applyLineAction(l, 'edit', { changes: { qty, location, delivery } }) : l));
  }, odooStock);
}

// En el carrito la línea se saca del todo (no hay historial que guardar).
export function removeCartLine(cartId, sellerId, lineId) {
  return changeCartLines(cartId, sellerId, (lines) => {
    if (!lines.some((l) => l.lineId === lineId)) throw new Error('Línea no encontrada');
    return lines.filter((l) => l.lineId !== lineId);
  });
}

// "Vaciar carrito": el cliente no compra. Devuelve todo el stock; el número
// ya usado no se reutiliza.
export async function discardCart(cartId, sellerId) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(cartId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Carrito no encontrado');
    const cart = { id: snap.id, ...snap.data() };
    assertCartEditable(cart, sellerId);
    const commitReservations = await reserve(tx, db, new Map(), cart.lines, []);
    commitReservations();
    const update = { status: 'descartado', discardedAt: new Date(), updatedAt: new Date() };
    tx.update(ref, update);
    return { ...cart, ...update };
  });
}

// Mandar a caja: el stock ya está reservado; se completa cliente, pago y
// envío, y los precios se fijan con la rebaja vigente y el medio de pago.
export async function submitCart(cartId, seller, { customer, paymentMethod, shipping }) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(cartId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Carrito no encontrado');
    const cart = { id: snap.id, ...snap.data() };
    assertCartEditable(cart, seller.id);
    const lines = priceCartForSubmit(cart.lines, paymentMethod, getFeriaProduct);
    const { valid, errors } = validateOrderInput({ sellerId: seller.id, customer, paymentMethod, lines, shipping });
    if (!valid) throw new Error(errors.join('; '));
    const withShipping = needsShipping(lines);
    const update = {
      status: 'pendiente',
      lines,
      customer: cleanCustomer(customer),
      paymentMethod,
      shipping: withShipping ? shipping : null,
      shippingCost: withShipping ? SHIPPING_COST : 0,
      sentAt: new Date(),
      updatedAt: new Date(),
    };
    tx.update(ref, update);
    return { ...cart, ...update };
  });
}
