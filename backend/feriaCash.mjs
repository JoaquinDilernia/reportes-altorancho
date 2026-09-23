// Caja de la feria: una sola caja abierta a la vez (se abre a la mañana con
// el fondo en efectivo y se cierra a la noche contando el efectivo). Cada
// venta queda asociada a la caja en la que se confirmó (cashSessionId).
import { getDb } from './firestore.mjs';
import { isConfirming } from './feriaLines.mjs';

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

// Lo que cobró cada venta: productos no eliminados más el envío.
function orderTotal(order) {
  const products = (order.lines ?? [])
    .filter((l) => l.status !== 'eliminado')
    .reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  return products + (order.shippingCost || 0);
}

// Resumen de una caja a partir de sus ventas. Solo cuentan las confirmadas:
// una venta anulada se devolvió, así que no está en la caja.
export function computeCashSummary(orders, { openingCash, countedCash = null }) {
  const sold = orders.filter((o) => o.status === 'confirmado');
  const mercadopago = { total: 0, mp_debito: 0, mp_1_cuota: 0, mp_3_cuotas: 0 };
  const byMethod = { efectivo: 0, transferencia: 0, mercadopago };
  for (const order of sold) {
    const total = orderTotal(order);
    if (MP_METHODS.includes(order.paymentMethod)) {
      mercadopago[order.paymentMethod] += total;
      mercadopago.total += total;
    } else if (order.paymentMethod in byMethod) {
      byMethod[order.paymentMethod] += total;
    }
  }
  const total = byMethod.efectivo + byMethod.transferencia + mercadopago.total;
  const expectedCash = round2(openingCash + byMethod.efectivo);
  return {
    sales: sold.length,
    annulled: orders.filter((o) => o.status === 'cancelado' && o.odooOrderId).length,
    byMethod,
    total,
    openingCash,
    expectedCash,
    countedCash,
    difference: countedCash == null ? null : round2(countedCash - expectedCash),
  };
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
  const summary = computeCashSummary(await sessionOrders(id), { openingCash: session.openingCash });
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

export async function closeCashSession({ countedCash, notes = '', user }) {
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
    const summary = computeCashSummary(orders, { openingCash: session.openingCash, countedCash: counted });
    const closed = {
      status: 'cerrada', closedAt: new Date(), closedBy: user, countedCash: counted,
      notes: String(notes ?? '').trim(), summary,
    };
    tx.update(ref, closed);
    tx.set(pointerRef(db), { openSessionId: null, updatedAt: new Date() });
    return { ...session, ...closed };
  });
}

// Cajas ya cerradas, la más nueva primero (orderBy de un solo campo: no
// necesita índice compuesto).
export async function listCashSessions(limit = 60) {
  const snap = await getDb().collection(SESSIONS).orderBy('openedAt', 'desc').limit(limit).get();
  return snap.docs.map(withId).filter((s) => s.status === 'cerrada');
}
