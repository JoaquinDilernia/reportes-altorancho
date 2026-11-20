// Persistencia de cambios/devoluciones web en Firestore.
import { getDb } from './firestore.mjs';
import { assertTransition, canEdit, historyEntry } from './posWebReturns.mjs';

const COL = 'pos_web_returns';
const COUNTERS = 'pos_counters';
const COUNTER_DOC = 'web_returns';
const BUSY_MSG = 'Otra persona está procesando esta solicitud';

const withId = (snap) => ({ ...snap.data(), id: snap.id });

async function readOrThrow(tx, ref) {
  const snap = await tx.get(ref);
  if (!snap.exists) throw new Error('Solicitud no encontrada');
  return withId(snap);
}

export async function createWebReturn(draft, user, now = new Date(), db = getDb()) {
  const counterRef = db.collection(COUNTERS).doc(COUNTER_DOC);
  const ref = db.collection(COL).doc();
  return db.runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const next = c.exists ? Number(c.data().next) || 1 : 1;
    const doc = {
      ...draft,
      number: `CW-${String(next).padStart(6, '0')}`,
      status: 'pendiente_aprobacion',
      history: [historyEntry('created', user, null, now)],
      createdAt: now, updatedAt: now, busy: null,
    };
    tx.set(counterRef, { next: next + 1 }, { merge: true });
    tx.set(ref, doc);
    return { ...doc, id: ref.id };
  });
}

export async function getWebReturn(id, db = getDb()) {
  const snap = await db.collection(COL).doc(id).get();
  if (!snap.exists) throw new Error('Solicitud no encontrada');
  return withId(snap);
}

export async function listWebReturns({ status, q, limit = 100 } = {}, db = getDb()) {
  let query = db.collection(COL);
  if (Array.isArray(status)) query = query.where('status', 'in', status);
  else if (status) query = query.where('status', '==', status);
  const snap = await query.orderBy('createdAt', 'desc').limit(limit).get();
  let rows = snap.docs.map(withId);
  const needle = String(q ?? '').trim().toLowerCase();
  if (needle) {
    rows = rows.filter((r) => [r.number, r.purchase?.ref, r.customer?.name, r.customer?.phone]
      .some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }
  return rows;
}

export async function countPending(db = getDb()) {
  const snap = await db.collection(COL).where('status', '==', 'pendiente_aprobacion').get();
  return snap.size;
}

export async function updateDraft(id, patch, user, db = getDb()) {
  const ref = db.collection(COL).doc(id);
  return db.runTransaction(async (tx) => {
    const cur = await readOrThrow(tx, ref);
    if (!canEdit(cur)) throw new Error('Esta solicitud ya no se puede editar');
    if (cur.busy) throw new Error(BUSY_MSG);
    const now = new Date();
    const changed = Object.keys(patch || {});
    const history = [...(cur.history || []), historyEntry('edited', user, changed, now)];
    const upd = { ...patch, history, updatedAt: now };
    tx.update(ref, upd);
    return { ...cur, ...upd };
  });
}

export async function claimTransition(id, action, user, extra = {}, db = getDb()) {
  const ref = db.collection(COL).doc(id);
  return db.runTransaction(async (tx) => {
    const cur = await readOrThrow(tx, ref);
    assertTransition(cur, action);
    if (cur.busy) throw new Error(BUSY_MSG);
    const busy = { action, by: user, at: new Date(), ...extra };
    tx.update(ref, { busy });
    return { request: { ...cur, busy }, previousStatus: cur.status };
  });
}

export async function finishTransition(id, { status, patch = {}, user, action }, db = getDb()) {
  const ref = db.collection(COL).doc(id);
  return db.runTransaction(async (tx) => {
    const cur = await readOrThrow(tx, ref);
    const now = new Date();
    const upd = {
      ...patch, status, busy: null, updatedAt: now,
      history: [...(cur.history || []), historyEntry(action, user, null, now)],
    };
    tx.update(ref, upd);
    return { ...cur, ...upd };
  });
}

export async function failTransition(id, error, db = getDb()) {
  const ref = db.collection(COL).doc(id);
  await db.runTransaction(async (tx) => {
    const cur = await readOrThrow(tx, ref);
    const odoo = { ...(cur.odoo || {}), error: { message: String(error?.message ?? error), at: new Date() } };
    tx.update(ref, { busy: null, odoo, updatedAt: new Date() });
  });
}

export async function saveOdooSteps(id, steps, db = getDb()) {
  const ref = db.collection(COL).doc(id);
  await db.runTransaction(async (tx) => {
    const cur = await readOrThrow(tx, ref);
    tx.update(ref, { odoo: { ...(cur.odoo || {}), steps }, updatedAt: new Date() });
  });
}
