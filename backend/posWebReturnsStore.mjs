// Persistencia de cambios/devoluciones web en Firestore.
import { getDb } from './firestore.mjs';
import { assertTransition, canEdit, historyEntry } from './posWebReturns.mjs';

const COL = 'pos_web_returns';
const COUNTERS = 'pos_counters';
const COUNTER_DOC = 'web_returns';
const BUSY_MSG = 'Otra persona está procesando esta solicitud';
export const BUSY_STALE_MS = 5 * 60 * 1000;
const PROTECTED_KEYS = ['status', 'number', 'busy', 'createdAt', 'updatedAt', 'history', 'odoo', 'id'];
const SEARCH_CAP = 1000;

// Date y Timestamp de Firestore (en cualquier profundidad) -> string ISO.
function normalize(v) {
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

const withId = (snap) => normalize({ ...snap.data(), id: snap.id });

async function readOrThrow(tx, ref) {
  const snap = await tx.get(ref);
  if (!snap.exists) throw new Error('Solicitud no encontrada');
  return withId(snap);
}

const isStale = (busy, now) => {
  const at = Date.parse(busy?.at);
  return !Number.isFinite(at) || now - at > BUSY_STALE_MS;
};

// Devuelve las entradas de historial extra si hay un busy vencido; tira si está vigente.
function checkBusy(cur, user, now) {
  if (!cur.busy) return [];
  if (!isStale(cur.busy, now)) throw new Error(BUSY_MSG);
  return [historyEntry('stale-busy-cleared', user, { action: cur.busy.action ?? null, by: cur.busy.by ?? null }, new Date(now))];
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
    return normalize({ ...doc, id: ref.id });
  });
}

export async function getWebReturn(id, db = getDb()) {
  const snap = await db.collection(COL).doc(id).get();
  if (!snap.exists) throw new Error('Solicitud no encontrada');
  return withId(snap);
}

export async function listWebReturns({ status, q, limit = 100 } = {}, db = getDb()) {
  let query = db.collection(COL);
  if (Array.isArray(status)) { if (status.length) query = query.where('status', 'in', status); }
  else if (status) query = query.where('status', '==', status);
  const needle = String(q ?? '').trim().toLowerCase();
  const snap = await query.orderBy('createdAt', 'desc').limit(needle ? SEARCH_CAP : limit).get();
  let rows = snap.docs.map(withId);
  if (needle) {
    rows = rows.filter((r) => [r.number, r.purchase?.ref, r.customer?.name, r.customer?.phone]
      .some((v) => String(v ?? '').toLowerCase().includes(needle))).slice(0, limit);
  }
  return rows;
}

export async function countPending(db = getDb()) {
  const snap = await db.collection(COL).where('status', '==', 'pendiente_aprobacion').get();
  return snap.size;
}

export async function updateDraft(id, patch, user, now = Date.now(), db = getDb()) {
  const ref = db.collection(COL).doc(id);
  return db.runTransaction(async (tx) => {
    const cur = await readOrThrow(tx, ref);
    if (!canEdit(cur)) throw new Error('Esta solicitud ya no se puede editar');
    const extra = checkBusy(cur, user, now);
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k, v]) => !PROTECTED_KEYS.includes(k) && v !== undefined));
    const changed = Object.keys(clean).filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(cur[k]));
    const history = [...(cur.history || []), ...extra, historyEntry('edited', user, changed, new Date(now))];
    const upd = { ...clean, history, updatedAt: new Date(now) };
    if (extra.length) upd.busy = null;
    tx.update(ref, upd);
    return normalize({ ...cur, ...upd });
  });
}

export async function claimTransition(id, action, user, extra = {}, now = Date.now(), db = getDb()) {
  const ref = db.collection(COL).doc(id);
  return db.runTransaction(async (tx) => {
    const cur = await readOrThrow(tx, ref);
    assertTransition(cur, action);
    const cleared = checkBusy(cur, user, now);
    const busy = { ...extra, action, by: user, at: new Date(now) };
    const upd = { busy };
    if (cleared.length) upd.history = [...(cur.history || []), ...cleared];
    tx.update(ref, upd);
    return { request: normalize({ ...cur, ...upd }), previousStatus: cur.status };
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
    return normalize({ ...cur, ...upd });
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
