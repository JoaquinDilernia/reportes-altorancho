// Saldo a favor del cliente (pos_credits): un documento por crédito generado
// en una devolución o cambio. Se usa en cualquier local como medio de pago
// ("saldo"), primero el que vence antes. El documento fiscal (NC) vive en
// Odoo; el saldo y su vencimiento, acá (la app no registra cobros en Odoo).
import { getDb } from './firestore.mjs';
import { round2 } from './posPricing.mjs';

export const CREDITS_COLLECTION = 'pos_credits';
export const SALDO_METHOD = { id: 'saldo', label: 'Saldo a favor', discountPct: 0, odooName: null, details: [], order: 99, active: true };

const DAY = 864e5;
const ms = (v) => (v == null ? null : v.toMillis ? v.toMillis() : new Date(v).getTime());
const pesos = (n) => `$ ${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
const withId = (snap) => ({ id: snap.id, ...snap.data() });

export const creditExpiry = (nowMs, days) => (days ? new Date(nowMs + days * DAY) : null);

export function isUsable(credit, nowMs) {
  const expires = ms(credit.expiresAt);
  return credit.balance > 0 && (expires == null || expires > nowMs);
}

const byExpiry = (a, b) => (ms(a.expiresAt) ?? Infinity) - (ms(b.expiresAt) ?? Infinity) || ms(a.createdAt) - ms(b.createdAt);

export function allocateCredits(credits, amount, nowMs) {
  const usable = credits.filter((c) => isUsable(c, nowMs)).sort(byExpiry);
  const available = round2(usable.reduce((s, c) => s + c.balance, 0));
  const wanted = round2(amount);
  if (wanted > available + 0.001) {
    throw new Error(`El cliente tiene ${pesos(available)} de saldo a favor y se quiere usar ${pesos(wanted)}`);
  }
  const allocation = [];
  let left = wanted;
  for (const c of usable) {
    if (left <= 0) break;
    const take = round2(Math.min(c.balance, left));
    allocation.push({ creditId: c.id, amount: take });
    left = round2(left - take);
  }
  return allocation;
}

export function buildCredit({ order, amount, days, nowMs, user, creditNoteIds = [] }) {
  const at = new Date(nowMs);
  return {
    customerDoc: String(order.customer.docNumber).replace(/\D/g, ''), customerName: order.customer.name,
    partnerId: order.customer.odooPartnerId ?? null, amount: round2(amount), balance: round2(amount), status: 'activo',
    localId: order.localId, orderId: order.id, orderNumber: order.number, creditNoteIds,
    createdAt: at, expiresAt: creditExpiry(nowMs, days),
    movements: [{ type: 'alta', amount: round2(amount), orderId: order.id, orderNumber: order.number, by: user, at }],
  };
}

export function applyAllocation(credit, part, { orderId, orderNumber, user, at, type = 'uso' }) {
  const sign = type === 'devuelto' ? 1 : -1;
  const balance = round2(credit.balance + sign * part);
  return {
    balance, status: balance > 0 ? 'activo' : 'agotado',
    movements: [...(credit.movements ?? []), { type, amount: round2(part), orderId, orderNumber, by: user, at }],
  };
}

// ---- Firestore ----

const creditsQuery = (db, docNumber) => db.collection(CREDITS_COLLECTION).where('customerDoc', '==', String(docNumber).replace(/\D/g, ''));

export async function listCustomerCredits(docNumber) {
  const snap = await creditsQuery(getDb(), docNumber).get();
  return snap.docs.map(withId);
}

export async function customerBalance(docNumber, nowMs = Date.now()) {
  const credits = (await listCustomerCredits(docNumber)).filter((c) => isUsable(c, nowMs)).sort(byExpiry);
  return { balance: round2(credits.reduce((s, c) => s + c.balance, 0)), credits };
}

// Lee DENTRO de la transacción y devuelve la escritura para después de todas
// las lecturas (regla de Firestore). Dos cajas no gastan el mismo saldo.
export async function consumeCreditsInTx(tx, db, { docNumber, amount, orderId, orderNumber, user, nowMs }) {
  const snap = await tx.get(creditsQuery(db, docNumber));
  const credits = snap.docs.map(withId);
  const allocation = allocateCredits(credits, amount, nowMs);
  const commit = () => {
    for (const part of allocation) {
      const c = credits.find((x) => x.id === part.creditId);
      tx.update(db.collection(CREDITS_COLLECTION).doc(c.id), applyAllocation(c, part.amount, { orderId, orderNumber, user, at: new Date(nowMs) }));
    }
  };
  return { allocation, commit };
}

export async function restoreCreditsInTx(tx, db, allocation, { orderId, orderNumber, user }) {
  const refs = allocation.map((p) => db.collection(CREDITS_COLLECTION).doc(p.creditId));
  const snaps = refs.length ? await tx.getAll(...refs) : [];
  return () => snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    tx.update(refs[i], applyAllocation(withId(snap), allocation[i].amount, { orderId, orderNumber, user, at: new Date(), type: 'devuelto' }));
  });
}

// id = id de la operación: un reintento no crea un segundo saldo.
export function createCreditInTx(tx, db, orderId, credit) {
  tx.set(db.collection(CREDITS_COLLECTION).doc(orderId), credit);
}

export async function listCreditsForAdmin({ docNumber = null, expiredOnly = false, nowMs = Date.now() } = {}) {
  const db = getDb();
  const snap = docNumber ? await creditsQuery(db, docNumber).get() : await db.collection(CREDITS_COLLECTION).where('status', '==', 'activo').get();
  let credits = snap.docs.map(withId);
  if (expiredOnly) credits = credits.filter((c) => c.balance > 0 && ms(c.expiresAt) != null && ms(c.expiresAt) <= nowMs);
  return credits.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
}

export async function extendCredit(creditId, { expiresAt, reason }, user, nowMs = Date.now()) {
  const text = String(reason ?? '').trim().slice(0, 200);
  if (!text) throw new Error('Escribí el motivo de la extensión');
  const next = expiresAt == null || expiresAt === '' ? null : new Date(expiresAt);
  if (next && (Number.isNaN(next.getTime()) || next.getTime() <= nowMs)) throw new Error('La nueva fecha de vencimiento tiene que ser futura');
  const db = getDb();
  const ref = db.collection(CREDITS_COLLECTION).doc(creditId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Saldo no encontrado');
    const credit = withId(snap);
    const update = {
      expiresAt: next,
      movements: [...(credit.movements ?? []), { type: 'extension', expiresAt: next, reason: text, by: user, at: new Date(nowMs) }],
    };
    tx.update(ref, update);
    return { ...credit, ...update };
  });
}
