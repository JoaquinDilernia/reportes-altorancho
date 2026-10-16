// Caja del día de cada local: se abre con el fondo, registra gastos,
// retiros e ingresos en dólares, y se cierra contando el efectivo. Cada
// venta queda atada a la caja en la que se confirmó (cashSessionId).
import crypto from 'node:crypto';
import { getDb } from './firestore.mjs';
import { cashPointerRef, COLLECTION as ORDERS } from './posOrders.mjs';
import { isConfirming } from './posLines.mjs';
import { parseAmount, cleanNotes, voidCashMovement } from './feriaCash.mjs';
import { round2, collectOf } from './posPricing.mjs';

const SESSIONS = 'pos_cash_sessions';
export const CASH_METHOD_ID = 'efectivo';
const MOVEMENT_TYPES = { gasto: 'Gasto', retiro: 'Retiro', ingreso_usd: 'Ingreso en dólares' };

export function paymentsOf(order) {
  const payments = order.payments ?? [];
  if (!payments.length) return [];
  if (payments.length === 1 || payments.every((p) => p.amount == null)) {
    return [{ methodId: payments[0].methodId, detailId: payments[0].detailId ?? null, amount: collectOf(order.totals) }];
  }
  return payments.map((p) => ({ methodId: p.methodId, detailId: p.detailId ?? null, amount: p.amount }));
}

export function computeCashSummary(orders, { openingCash, countedCash = null, movements = [] }) {
  const sold = orders.filter((o) => o.status === 'confirmado');
  const byMethod = {};
  const byDetail = {};
  const refundsByMethod = {};
  let creditsUsed = 0;
  let creditsIssued = 0;
  for (const order of sold) {
    for (const { methodId, detailId, amount } of paymentsOf(order)) {
      if (methodId === 'saldo') {
        creditsUsed = round2(creditsUsed + amount);
        continue;
      }
      byMethod[methodId] = round2((byMethod[methodId] ?? 0) + amount);
      if (detailId) byDetail[`${methodId}:${detailId}`] = round2((byDetail[`${methodId}:${detailId}`] ?? 0) + amount);
    }
    for (const { methodId, amount } of order.refund?.cashBack ?? []) refundsByMethod[methodId] = round2((refundsByMethod[methodId] ?? 0) + amount);
    creditsIssued = round2(creditsIssued + (order.refund?.credit ?? 0));
  }
  const active = movements.filter((m) => !m.voidedAt);
  const sumOf = (type, field = 'amount') => round2(active.filter((m) => m.type === type).reduce((s, m) => s + (m[field] ?? 0), 0));
  const expenses = sumOf('gasto');
  const withdrawals = sumOf('retiro');
  const usd = { amount: sumOf('ingreso_usd', 'usdAmount'), pesos: sumOf('ingreso_usd') };
  const total = round2(Object.values(byMethod).reduce((s, v) => s + v, 0));
  const refundsTotal = round2(Object.values(refundsByMethod).reduce((s, v) => s + v, 0));
  const expectedCash = round2(openingCash + (byMethod[CASH_METHOD_ID] ?? 0) - (refundsByMethod[CASH_METHOD_ID] ?? 0) - expenses - withdrawals);
  return {
    sales: sold.filter((o) => (o.kind ?? 'venta') !== 'devolucion').length,
    returns: sold.filter((o) => o.kind === 'devolucion' || o.kind === 'cambio').length,
    annulled: orders.filter((o) => o.status === 'anulado' && o.odooOrderId).length,
    byMethod, byDetail, total, refundsByMethod, refundsTotal, creditsIssued, creditsUsed,
    openingCash, expenses, withdrawals, usd, expectedCash,
    countedCash, difference: countedCash == null ? null : round2(countedCash - expectedCash),
  };
}

export function buildPosCashMovement({ type, concept, amount, usdAmount, rate }, { user, now, id }) {
  if (!MOVEMENT_TYPES[type]) throw new Error(`Tipo de movimiento inválido: ${type}`);
  const text = String(concept ?? '').trim().slice(0, 120);
  if (type === 'gasto' && !text) throw new Error('Escribí el concepto del gasto (ej. librería, ferretería)');
  if (type === 'ingreso_usd') {
    const usd = parseAmount(usdAmount);
    if (usd <= 0) throw new Error('Monto en dólares inválido');
    if (rate == null || rate === '') throw new Error('Falta la cotización del dólar');
    const r = parseAmount(rate);
    if (r <= 0) throw new Error('Cotización inválida');
    return { id, type, concept: text || 'Ingreso en dólares', usdAmount: usd, rate: r, amount: round2(usd * r), at: now, by: user };
  }
  const value = parseAmount(amount);
  if (value <= 0) throw new Error('Monto inválido');
  return { id, type, concept: text || MOVEMENT_TYPES[type], amount: value, at: now, by: user };
}

const withId = (snap) => ({ id: snap.id, ...snap.data() });

async function sessionOrders(sessionId, tx = null) {
  const query = getDb().collection(ORDERS).where('cashSessionId', '==', sessionId);
  const snap = tx ? await tx.get(query) : await query.get();
  return snap.docs.map(withId);
}

export async function listCashSessions(localId = null, limit = 60) {
  const col = getDb().collection(SESSIONS);
  const snap = localId ? await col.where('localId', '==', localId).get() : await col.get();
  return snap.docs.map(withId)
    .sort((a, b) => b.openedAt.toMillis() - a.openedAt.toMillis())
    .slice(0, limit);
}

export async function getCurrentCash(localId) {
  const db = getDb();
  const id = (await cashPointerRef(db, localId).get()).data()?.openSessionId;
  const lastClosed = (await listCashSessions(localId, 5)).find((s) => s.status === 'cerrada') ?? null;
  if (!id) return { session: null, summary: null, lastClosed };
  const session = withId(await db.collection(SESSIONS).doc(id).get());
  const summary = computeCashSummary(await sessionOrders(id), { openingCash: session.openingCash, movements: session.movements });
  return { session, summary, lastClosed };
}

export async function openCashSession({ localId, openingCash, user }) {
  const amount = parseAmount(openingCash);
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const pointer = await tx.get(cashPointerRef(db, localId));
    if (pointer.data()?.openSessionId) throw new Error('Ya hay una caja abierta en este local: cerrala antes de abrir otra');
    const ref = db.collection(SESSIONS).doc();
    const session = { localId, status: 'abierta', openingCash: amount, openedAt: new Date(), openedBy: user, movements: [], notes: '' };
    tx.set(ref, session);
    tx.set(cashPointerRef(db, localId), { openSessionId: ref.id, updatedAt: new Date() });
    return { id: ref.id, ...session };
  });
}

export async function closeCashSession({ localId, countedCash, notes, user }) {
  const counted = parseAmount(countedCash);
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const id = (await tx.get(cashPointerRef(db, localId))).data()?.openSessionId;
    if (!id) throw new Error('No hay ninguna caja abierta en este local');
    const ref = db.collection(SESSIONS).doc(id);
    const session = withId(await tx.get(ref));
    const orders = await sessionOrders(id, tx);
    if (orders.some((o) => isConfirming(o))) throw new Error('Hay una venta confirmándose: esperá unos segundos y volvé a cerrar');
    const summary = computeCashSummary(orders, { openingCash: session.openingCash, countedCash: counted, movements: session.movements });
    const closed = { status: 'cerrada', closedAt: new Date(), closedBy: user, countedCash: counted, notes: cleanNotes(notes ?? session.notes), summary };
    tx.update(ref, closed);
    tx.set(cashPointerRef(db, localId), { openSessionId: null, updatedAt: new Date() });
    return { ...session, ...closed };
  });
}

async function updateOpenSession(localId, change) {
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const id = (await tx.get(cashPointerRef(db, localId))).data()?.openSessionId;
    if (!id) throw new Error('No hay ninguna caja abierta en este local');
    const ref = db.collection(SESSIONS).doc(id);
    const session = withId(await tx.get(ref));
    const update = { ...change(session), updatedAt: new Date() };
    tx.update(ref, update);
    return { ...session, ...update };
  });
}

export function addCashMovement(localId, input, user) {
  const movement = buildPosCashMovement(input, { user, now: new Date(), id: crypto.randomUUID() });
  return updateOpenSession(localId, (s) => ({ movements: [...(s.movements ?? []), movement] }));
}

export function voidOpenCashMovement(localId, movementId, user) {
  return updateOpenSession(localId, (s) => ({ movements: voidCashMovement(s.movements ?? [], movementId, { user, now: new Date() }) }));
}

export function updateCashNotes(localId, notes) {
  return updateOpenSession(localId, () => ({ notes: cleanNotes(notes) }));
}
