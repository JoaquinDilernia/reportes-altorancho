import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFirestore } from './helpers/fakeFirestore.mjs';
import {
  createWebReturn, getWebReturn, listWebReturns, countPending, updateDraft,
  claimTransition, finishTransition, failTransition, saveOdooSteps, BUSY_STALE_MS, appendEvidence, setLabel,
} from '../posWebReturnsStore.mjs';

const draft = (o = {}) => ({ kind: 'cambio', reason: 'falla', customer: { name: 'Ana Perez', phone: '11' }, purchase: { ref: 'S1' }, ...o });
const user = { uid: 'u1', name: 'Juan' };

test('numera CW-000001, CW-000002', async () => {
  const db = createFakeFirestore();
  const a = await createWebReturn(draft(), user, new Date(), db);
  const b = await createWebReturn(draft(), user, new Date(), db);
  assert.equal(a.number, 'CW-000001');
  assert.equal(b.number, 'CW-000002');
  assert.equal(a.status, 'pendiente_aprobacion');
  assert.equal(a.history[0].action, 'created');
  assert.equal((await getWebReturn(b.id, db)).number, 'CW-000002');
});

test('getWebReturn inexistente', async () => {
  await assert.rejects(getWebReturn('x', createFakeFirestore()), /Solicitud no encontrada/);
});

test('updateDraft: edita pendiente y rechaza aprobada', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const u = await updateDraft(r.id, { reasonNote: 'x' }, user, undefined, db);
  assert.equal(u.reasonNote, 'x');
  assert.deepEqual(u.history.at(-1).diff, ['reasonNote']);
  await claimTransition(r.id, 'approve', user, {}, undefined, db);
  await finishTransition(r.id, { status: 'aprobada', patch: {}, user, action: 'approve' }, db);
  await assert.rejects(updateDraft(r.id, { reasonNote: 'y' }, user, undefined, db), /no se puede editar/i);
});

test('claim en paralelo: uno gana', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const res = await Promise.allSettled([
    claimTransition(r.id, 'approve', user, {}, undefined, db),
    claimTransition(r.id, 'approve', user, {}, undefined, db),
  ]);
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
  const rej = res.find((x) => x.status === 'rejected');
  assert.match(rej.reason.message, /Otra persona/);
  assert.equal(res.find((x) => x.status === 'fulfilled').value.previousStatus, 'pendiente_aprobacion');
});

test('finish, fail y saveOdooSteps', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  await claimTransition(r.id, 'approve', user, {}, undefined, db);
  await saveOdooSteps(r.id, [{ k: 1 }], db);
  await failTransition(r.id, new Error('boom'), db);
  const g = await getWebReturn(r.id, db);
  assert.equal(g.busy, null);
  assert.equal(g.odoo.error.message, 'boom');
  assert.deepEqual(g.odoo.steps, [{ k: 1 }]);
  await claimTransition(r.id, 'approve', user, {}, undefined, db);
  const f = await finishTransition(r.id, { status: 'aprobada', patch: { odoo: { saleOrderId: 5 } }, user, action: 'approve' }, db);
  assert.equal(f.status, 'aprobada');
  assert.equal(f.busy, null);
  assert.equal(f.history.at(-1).action, 'approve');
  await assert.rejects(claimTransition(r.id, 'approve', user, {}, undefined, db), /No se puede aprobar/);
});

test('countPending y listWebReturns', async () => {
  const db = createFakeFirestore();
  const a = await createWebReturn(draft(), user, new Date(1000), db);
  const b = await createWebReturn(draft({ customer: { name: 'Zoe', phone: '22' } }), user, new Date(2000), db);
  await createWebReturn(draft(), user, new Date(3000), db);
  await claimTransition(a.id, 'reject', user, {}, undefined, db);
  await finishTransition(a.id, { status: 'rechazada', patch: {}, user, action: 'reject' }, db);
  assert.equal(await countPending(db), 2);
  const all = await listWebReturns({}, db);
  assert.deepEqual(all.map((x) => x.number), ['CW-000003', 'CW-000002', 'CW-000001']);
  assert.equal((await listWebReturns({ status: 'rechazada' }, db)).length, 1);
  assert.equal((await listWebReturns({ status: ['rechazada', 'pendiente_aprobacion'] }, db)).length, 3);
  assert.deepEqual((await listWebReturns({ q: 'zoe' }, db)).map((x) => x.id), [b.id]);
  assert.equal((await listWebReturns({ q: 'CW-000001' }, db)).length, 1);
});

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

test('las fechas salen como ISO string (create y get)', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const g = await getWebReturn(r.id, db);
  for (const x of [r, g]) {
    assert.match(x.createdAt, ISO);
    assert.match(x.history[0].at, ISO);
  }
  await claimTransition(r.id, 'approve', user, {}, undefined, db);
  await failTransition(r.id, new Error('x'), db);
  const h = await getWebReturn(r.id, db);
  assert.match(h.odoo.error.at, ISO);
  await claimTransition(r.id, 'approve', user, {}, undefined, db);
  assert.match((await getWebReturn(r.id, db)).busy.at, ISO);
});

test('busy vencido se libera; busy vigente sigue bloqueando', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const t0 = Date.now();
  await claimTransition(r.id, 'approve', user, {}, t0, db);
  await assert.rejects(claimTransition(r.id, 'approve', user, {}, t0 + BUSY_STALE_MS - 1000, db), /Otra persona/);
  await assert.rejects(updateDraft(r.id, { reasonNote: 'a' }, user, t0 + 1000, db), /Otra persona/);
  const c = await claimTransition(r.id, 'approve', { uid: 'u2' }, {}, t0 + BUSY_STALE_MS + 1000, db);
  assert.equal(c.request.busy.by.uid, 'u2');
  const h = (await getWebReturn(r.id, db)).history.at(-1);
  assert.equal(h.action, 'stale-busy-cleared');
  assert.deepEqual(h.diff, { action: 'approve', by: user });
});

test('updateDraft con busy vencido edita y libera', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const t0 = Date.now();
  await claimTransition(r.id, 'approve', user, {}, t0, db);
  const u = await updateDraft(r.id, { reasonNote: 'a' }, user, t0 + BUSY_STALE_MS + 1, db);
  assert.equal(u.busy, null);
  assert.equal(u.reasonNote, 'a');
});

test('q busca más allá del limit y luego recorta', async () => {
  const db = createFakeFirestore();
  await createWebReturn(draft({ customer: { name: 'Vieja', phone: '1' } }), user, new Date(1000), db);
  await createWebReturn(draft(), user, new Date(2000), db);
  await createWebReturn(draft(), user, new Date(3000), db);
  const rows = await listWebReturns({ q: 'vieja', limit: 2 }, db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customer.name, 'Vieja');
  assert.equal((await listWebReturns({ limit: 2 }, db)).length, 2);
});

test('updateDraft ignora claves protegidas y el diff solo marca cambios reales', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const u = await updateDraft(r.id, { status: 'cerrada', number: 'X', busy: {}, history: [], odoo: {}, id: 'z', reason: 'falla', reasonNote: 'n' }, user, undefined, db);
  assert.equal(u.status, 'pendiente_aprobacion');
  assert.equal(u.number, r.number);
  assert.equal(u.id, r.id);
  assert.deepEqual(u.history.at(-1).diff, ['reasonNote']);
});

test('busy no puede ser pisado por extra', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const c = await claimTransition(r.id, 'approve', user, { action: 'hack', by: 'x' }, undefined, db);
  assert.equal(c.request.busy.action, 'approve');
  assert.deepEqual(c.request.busy.by, user);
});

test('appendEvidence: suma en paralelo sin pisar y solo mientras es editable', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  await Promise.all([
    appendEvidence(r.id, { storagePath: 'a', kind: 'image', mimetype: 'image/png' }, 'Juan', undefined, db),
    appendEvidence(r.id, { storagePath: 'b', kind: 'pdf', mimetype: 'application/pdf' }, 'Juan', undefined, db),
  ]);
  const g = await getWebReturn(r.id, db);
  assert.deepEqual(g.evidence.map((e) => e.storagePath).sort(), ['a', 'b']);
  assert.equal(g.history.at(-1).action, 'evidence');
  await claimTransition(r.id, 'reject', user, {}, undefined, db);
  await finishTransition(r.id, { status: 'rechazada', patch: {}, user, action: 'reject' }, db);
  await assert.rejects(appendEvidence(r.id, { storagePath: 'c' }, 'Juan', undefined, db), /no se puede editar/i);
});

test('appendEvidence: tope de archivos', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft({ evidence: Array.from({ length: 20 }, (_, i) => ({ storagePath: `p${i}` })) }), user, new Date(), db);
  await assert.rejects(appendEvidence(r.id, { storagePath: 'x' }, 'Juan', undefined, db), /hasta 20 archivos/);
});

test('setLabel: solo en aprobada, con historial label', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft({ logistics: { mode: 'retiro_domicilio' } }), user, new Date(), db);
  await assert.rejects(setLabel(r.id, 'pos-web-returns/x/l.pdf', 'Juan', undefined, db), /aprobada/);
  await claimTransition(r.id, 'approve', user, {}, undefined, db);
  await finishTransition(r.id, { status: 'aprobada', patch: {}, user, action: 'approve' }, db);
  const s = await setLabel(r.id, 'pos-web-returns/x/l.pdf', 'Juan', undefined, db);
  assert.equal(s.logistics.labelPath, 'pos-web-returns/x/l.pdf');
  assert.equal(s.logistics.mode, 'retiro_domicilio');
  assert.equal(s.history.at(-1).action, 'label');
  assert.equal((await getWebReturn(r.id, db)).logistics.labelPath, 'pos-web-returns/x/l.pdf');
});
