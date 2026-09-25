// Caja de la feria: una sola caja abierta a la vez (se abre a la mañana con
// el fondo en efectivo y se cierra a la noche contando el efectivo). Cada
// venta queda asociada a la caja en la que se confirmó (cashSessionId).
import crypto from 'node:crypto';
import { getDb } from './firestore.mjs';
import { isConfirming, paymentsOf } from './feriaLines.mjs';

const SESSIONS = 'feria_cash_sessions';
const ORDERS = 'feria_orders';
// Puntero a la caja abierta: se lee dentro de la transacción de confirmar,
// así ninguna venta se confirma con la caja cerrada.
const pointerRef = (db) => db.collection('feria_counters').doc('cash');

const MP_METHODS = ['mp_debito', 'mp_1_cuota', 'mp_3_cuotas'];
const round2 = (n) => Math.round(n * 100) / 100;

export const CASH_CLOSED_MESSAGE = 'La caja está cerrada: abrila en la pestaña “Caja del día” para confirmar ventas';

export function assertCanConfirmWithCash(pointer) {
  if (!pointer?.openSessionId) throw new Error(CASH_CLOSED_MESSAGE);
  return pointer.openSessionId;
}

export function parseAmount(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error('Monto inválido');
  return round2(n);
}

// Resumen de una caja a partir de sus ventas. Solo cuentan las confirmadas:
// una venta anulada se devolvió, así que no está en la caja. Con el pago
// dividido, cada parte suma a su medio (aunque a Odoo haya ido uno solo).
// Las salidas (gastos y retiros, siempre en efectivo) restan del efectivo
// esperado; las anuladas no cuentan.
export function computeCashSummary(orders, { openingCash, countedCash = null, movements = [] }) {
  const sold = orders.filter((o) => o.status === 'confirmado');
  const active = movements.filter((m) => !m.voidedAt);
  const sumOf = (type) => round2(active.filter((m) => m.type === type).reduce((sum, m) => sum + m.amount, 0));
  const expenses = sumOf('gasto');
  const withdrawals = sumOf('retiro');
  const mercadopago = { total: 0, mp_debito: 0, mp_1_cuota: 0, mp_3_cuotas: 0 };
  const byMethod = { efectivo: 0, transferencia: 0, mercadopago };
  for (const order of sold) {
    for (const { method, amount } of paymentsOf(order)) {
      if (MP_METHODS.includes(method)) {
        mercadopago[method] += amount;
        mercadopago.total += amount;
      } else if (method in byMethod) {
        byMethod[method] += amount;
      }
    }
  }
  const total = byMethod.efectivo + byMethod.transferencia + mercadopago.total;
  const expectedCash = round2(openingCash + byMethod.efectivo - expenses - withdrawals);
  return {
    sales: sold.length,
    annulled: orders.filter((o) => o.status === 'cancelado' && o.odooOrderId).length,
    byMethod,
    total,
    openingCash,
    expenses,
    withdrawals,
    expectedCash,
    countedCash,
    difference: countedCash == null ? null : round2(countedCash - expectedCash),
  };
}

// ---- Salidas de caja (gastos y retiros) y observaciones ----

const MOVEMENT_TYPES = { gasto: 'Gasto', retiro: 'Retiro' };
const NOTES_MAX = 1000;

export function cleanNotes(notes) {
  return String(notes ?? '').trim().slice(0, NOTES_MAX);
}

// Un gasto necesita concepto (comida, librería…); un retiro, no.
export function buildCashMovement({ type, concept, amount }, { user, now, id }) {
  if (!MOVEMENT_TYPES[type]) throw new Error(`Tipo de salida inválido: ${type}`);
  const text = String(concept ?? '').trim().slice(0, 120);
  if (type === 'gasto' && !text) throw new Error('Escribí el concepto del gasto (ej. comida, librería)');
  const value = parseAmount(amount);
  if (value <= 0) throw new Error('Monto inválido');
  return { id, type, concept: text || 'Retiro de dinero', amount: value, at: now, by: user };
}

// Un movimiento cargado por error no se borra: queda anulado y deja de sumar.
export function voidCashMovement(movements, movementId, { user, now }) {
  const target = movements.find((m) => m.id === movementId);
  if (!target) throw new Error('Movimiento no encontrado');
  if (target.voidedAt) throw new Error('Ese movimiento ya está anulado');
  return movements.map((m) => (m.id === movementId ? { ...m, voidedAt: now, voidedBy: user } : m));
}

const withId = (snap) => ({ id: snap.id, ...snap.data() });

async function sessionOrders(sessionId, tx = null) {
  const query = getDb().collection(ORDERS).where('cashSessionId', '==', sessionId);
  const snap = tx ? await tx.get(query) : await query.get();
  return snap.docs.map(withId);
}

export async function getCurrentCash() {
  const db = getDb();
  const pointer = await pointerRef(db).get();
  const id = pointer.data()?.openSessionId;
  if (!id) return { session: null, summary: null };
  const session = withId(await db.collection(SESSIONS).doc(id).get());
  const summary = computeCashSummary(await sessionOrders(id), { openingCash: session.openingCash, movements: session.movements });
  return { session, summary };
}

export async function openCashSession({ openingCash, user }) {
  const amount = parseAmount(openingCash);
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const pointer = await tx.get(pointerRef(db));
    if (pointer.data()?.openSessionId) throw new Error('Ya hay una caja abierta: cerrala antes de abrir otra');
    const ref = db.collection(SESSIONS).doc();
    const session = { status: 'abierta', openingCash: amount, openedAt: new Date(), openedBy: user };
    tx.set(ref, session);
    tx.set(pointerRef(db), { openSessionId: ref.id, updatedAt: new Date() });
    return { id: ref.id, ...session };
  });
}

// `notes` pisa la observación de la caja; sin `notes` queda la que ya tenía.
export async function closeCashSession({ countedCash, notes, user }) {
  const counted = parseAmount(countedCash);
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const pointer = await tx.get(pointerRef(db));
    const id = pointer.data()?.openSessionId;
    if (!id) throw new Error('No hay ninguna caja abierta');
    const ref = db.collection(SESSIONS).doc(id);
    const session = withId(await tx.get(ref));
    const orders = await sessionOrders(id, tx);
    // Una venta a mitad de confirmar todavía no figura como confirmada: se
    // espera a que termine para que el cierre la cuente.
    if (orders.some((o) => isConfirming(o))) {
      throw new Error('Hay una venta confirmándose en este momento: esperá unos segundos y volvé a cerrar');
    }
    const summary = computeCashSummary(orders, { openingCash: session.openingCash, countedCash: counted, movements: session.movements });
    const closed = {
      status: 'cerrada', closedAt: new Date(), closedBy: user, countedCash: counted,
      notes: cleanNotes(notes ?? session.notes), summary,
    };
    tx.update(ref, closed);
    tx.set(pointerRef(db), { openSessionId: null, updatedAt: new Date() });
    return { ...session, ...closed };
  });
}

// Cambia la caja abierta dentro de una transacción (la salida o la nota
// siempre van a la caja que está abierta en ese momento).
async function updateOpenSession(change) {
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const id = (await tx.get(pointerRef(db))).data()?.openSessionId;
    if (!id) throw new Error('No hay ninguna caja abierta');
    const ref = db.collection(SESSIONS).doc(id);
    const session = withId(await tx.get(ref));
    const update = { ...change(session), updatedAt: new Date() };
    tx.update(ref, update);
    return { ...session, ...update };
  });
}

export function addCashMovement(input, user) {
  const movement = buildCashMovement(input, { user, now: new Date(), id: crypto.randomUUID() });
  return updateOpenSession((session) => ({ movements: [...(session.movements ?? []), movement] }));
}

export function voidOpenCashMovement(movementId, user) {
  return updateOpenSession((session) => ({
    movements: voidCashMovement(session.movements ?? [], movementId, { user, now: new Date() }),
  }));
}

export function updateCashNotes(notes) {
  return updateOpenSession(() => ({ notes: cleanNotes(notes) }));
}

// Cajas ya cerradas, la más nueva primero (orderBy de un solo campo: no
// necesita índice compuesto).
export async function listCashSessions(limit = 60) {
  const snap = await getDb().collection(SESSIONS).orderBy('openedAt', 'desc').limit(limit).get();
  return snap.docs.map(withId).filter((s) => s.status === 'cerrada');
}
