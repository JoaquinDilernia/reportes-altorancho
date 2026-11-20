import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFirestore } from './helpers/fakeFirestore.mjs';
import {
  createWebReturn, getWebReturn, listWebReturns, countPending, updateDraft,
  claimTransition, finishTransition, failTransition, saveOdooSteps,
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
  const u = await updateDraft(r.id, { reasonNote: 'x' }, user, db);
  assert.equal(u.reasonNote, 'x');
  assert.deepEqual(u.history.at(-1).diff, ['reasonNote']);
  await claimTransition(r.id, 'approve', user, {}, db);
  await finishTransition(r.id, { status: 'aprobada', patch: {}, user, action: 'approve' }, db);
  await assert.rejects(updateDraft(r.id, { reasonNote: 'y' }, user, db), /no se puede editar/i);
});

test('claim en paralelo: uno gana', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  const res = await Promise.allSettled([
    claimTransition(r.id, 'approve', user, {}, db),
    claimTransition(r.id, 'approve', user, {}, db),
  ]);
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
  const rej = res.find((x) => x.status === 'rejected');
  assert.match(rej.reason.message, /Otra persona/);
  assert.equal(res.find((x) => x.status === 'fulfilled').value.previousStatus, 'pendiente_aprobacion');
});

test('finish, fail y saveOdooSteps', async () => {
  const db = createFakeFirestore();
  const r = await createWebReturn(draft(), user, new Date(), db);
  await claimTransition(r.id, 'approve', user, {}, db);
  await saveOdooSteps(r.id, [{ k: 1 }], db);
  await failTransition(r.id, new Error('boom'), db);
  const g = await getWebReturn(r.id, db);
  assert.equal(g.busy, null);
  assert.equal(g.odoo.error.message, 'boom');
  assert.deepEqual(g.odoo.steps, [{ k: 1 }]);
  await claimTransition(r.id, 'approve', user, {}, db);
  const f = await finishTransition(r.id, { status: 'aprobada', patch: { odoo: { saleOrderId: 5 } }, user, action: 'approve' }, db);
  assert.equal(f.status, 'aprobada');
  assert.equal(f.busy, null);
  assert.equal(f.history.at(-1).action, 'approve');
  await assert.rejects(claimTransition(r.id, 'approve', user, {}, db), /No se puede aprobar/);
});

test('countPending y listWebReturns', async () => {
  const db = createFakeFirestore();
  const a = await createWebReturn(draft(), user, new Date(1000), db);
  const b = await createWebReturn(draft({ customer: { name: 'Zoe', phone: '22' } }), user, new Date(2000), db);
  await createWebReturn(draft(), user, new Date(3000), db);
  await claimTransition(a.id, 'reject', user, {}, db);
  await finishTransition(a.id, { status: 'rechazada', patch: {}, user, action: 'reject' }, db);
  assert.equal(await countPending(db), 2);
  const all = await listWebReturns({}, db);
  assert.deepEqual(all.map((x) => x.number), ['CW-000003', 'CW-000002', 'CW-000001']);
  assert.equal((await listWebReturns({ status: 'rechazada' }, db)).length, 1);
  assert.equal((await listWebReturns({ status: ['rechazada', 'pendiente_aprobacion'] }, db)).length, 3);
  assert.deepEqual((await listWebReturns({ q: 'zoe' }, db)).map((x) => x.id), [b.id]);
  assert.equal((await listWebReturns({ q: 'CW-000001' }, db)).length, 1);
});
