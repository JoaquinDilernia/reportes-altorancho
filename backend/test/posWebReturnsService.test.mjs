import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, receive, reject, derive, refundDone, close } from '../posWebReturnsService.mjs';
import * as store from '../posWebReturnsStore.mjs';
import { netOfIva, round2 } from '../posPricing.mjs';
import { createFakeFirestore } from './helpers/fakeFirestore.mjs';
import {
  settings, user, rline, request, move, fakeOdoo, depsFor, writes, callOf,
} from './helpers/webReturnsFakes.mjs';

async function seed(db, over = {}) {
  const { id, number, status, odoo, money, ...draft } = request(over);
  const created = await store.createWebReturn(draft, user, new Date(), db);
  return created;
}

test('approve: recalcula money, corre los pasos y queda aprobada con los pasos guardados', async () => {
  const db = createFakeFirestore();
  const r = await seed(db, { newLines: [{ productId: 90000, sku: 'CARO', name: 'Caro', qty: 1, price: 15000 }], evidence: [] });
  const { odoo, calls } = fakeOdoo();
  const out = await approve(r.id, user, depsFor(odoo, { db }));
  assert.equal(out.status, 'aprobada');
  assert.equal(out.busy, null);
  assert.equal(out.money.net, 5000);
  assert.equal(out.money.differenceToCollect, 5000);
  assert.equal(out.odoo.error, null);
  assert.equal(out.odoo.steps.saleOrder.id, 1000);
  assert.equal(out.odoo.steps.pickings['pick:192311:fallas'].id, 4321);
  const line = callOf(calls, 'sale.order.create')[2][0].order_line[0][2];
  assert.equal(line.price_unit, round2(netOfIva(5000)));
  assert.equal((await store.getWebReturn(r.id, db)).status, 'aprobada');
});

test('approve cuando runApprovalSteps tira: sigue pendiente, sin busy y con odoo.error', async () => {
  const db = createFakeFirestore();
  const r = await seed(db);
  const { odoo } = fakeOdoo({ 'stock.return.picking.create_returns': () => { throw new Error('Odoo caído'); } });
  await assert.rejects(approve(r.id, user, depsFor(odoo, { db })), /Odoo caído/);
  const cur = await store.getWebReturn(r.id, db);
  assert.equal(cur.status, 'pendiente_aprobacion');
  assert.equal(cur.busy, null);
  assert.match(cur.odoo.error.message, /Odoo caído/);
  assert.equal(cur.odoo.steps.saleOrder.id, 1000, 'los pasos hechos quedan guardados');
  // El reintento sigue desde ahí y limpia el error.
  const { odoo: odoo2, calls: calls2 } = fakeOdoo();
  const out = await approve(r.id, user, depsFor(odoo2, { db }));
  assert.equal(out.status, 'aprobada');
  assert.equal(out.odoo.error, null);
  assert.ok(!writes(calls2).includes('sale.order.create'));
});

test('receive: valida y pasa a recibida (o reintegro_pendiente en devolución)', async () => {
  for (const [kind, expected] of [['cambio', 'recibida'], ['devolucion', 'reintegro_pendiente']]) {
    const db = createFakeFirestore();
    const r = await seed(db, { kind, newLines: kind === 'cambio' ? request().newLines : [], evidence: [] });
    const { odoo } = fakeOdoo();
    await approve(r.id, user, depsFor(odoo, { db }));
    const { odoo: o2 } = fakeOdoo({ 'stock.picking.read': () => [{ id: 4321, name: 'EC/RET/1', state: 'assigned' }] });
    const validate = async (id) => ({ id, name: 'EC/RET/1', state: 'done' });
    const out = await receive(r.id, user, depsFor(o2, { db, validate }));
    assert.equal(out.status, expected);
    assert.equal(out.odoo.steps.pickings['pick:192311:fallas'].state, 'done');
    assert.ok(out.odoo.steps.saleOrder || kind === 'devolucion');
  }
});

test('receive con devolución cancelada: sigue aprobada con el error guardado', async () => {
  const db = createFakeFirestore();
  const r = await seed(db, { evidence: [] });
  await approve(r.id, user, depsFor(fakeOdoo().odoo, { db }));
  const { odoo } = fakeOdoo({ 'stock.picking.read': () => [{ id: 4321, name: 'EC/RET/1', state: 'cancel' }] });
  await assert.rejects(receive(r.id, user, depsFor(odoo, { db })), /cancelada en Odoo/);
  const cur = await store.getWebReturn(r.id, db);
  assert.equal(cur.status, 'aprobada');
  assert.match(cur.odoo.error.message, /cancelada/);
});

test('reject / derive: piden motivo / local y solo cambian el estado', async () => {
  const db = createFakeFirestore();
  const deps = depsFor(fakeOdoo().odoo, { db });
  const r = await seed(db);
  await assert.rejects(reject(r.id, user, '   ', deps), /Escribí el motivo del rechazo/);
  const out = await reject(r.id, user, '  fuera de política ', deps);
  assert.equal(out.status, 'rechazada');
  assert.equal(out.rejectReason, 'fuera de política');
  const r2 = await seed(db);
  await assert.rejects(derive(r2.id, user, '', deps), /Elegí el local/);
  const d = await derive(r2.id, user, 'BL', deps);
  assert.equal(d.status, 'derivada_local');
  assert.equal(d.logistics.mode, 'derivado_local');
  assert.equal(d.logistics.derivedLocalId, 'BL');
  assert.equal(d.logistics.payer, 'altorancho');
  await assert.rejects(derive(r.id, user, 'BL', deps), /No se puede derivar/);
});

test('refundDone y close', async () => {
  const db = createFakeFirestore();
  const r = await seed(db, { kind: 'devolucion', newLines: [], evidence: [] });
  await approve(r.id, user, depsFor(fakeOdoo().odoo, { db }));
  const { odoo } = fakeOdoo({ 'stock.picking.read': () => [{ id: 4321, name: 'EC/RET/1', state: 'done' }] });
  await receive(r.id, user, depsFor(odoo, { db }));
  const deps = depsFor(fakeOdoo().odoo, { db });
  const done = await refundDone(r.id, user, undefined, deps);
  assert.equal(done.status, 'reintegrada');
  assert.equal(done.money.refundPending, 10000);
  assert.equal(done.money.refundNote, null);
  assert.deepEqual(done.money.refundDoneBy, user);
  assert.ok(Date.parse(done.money.refundDoneAt));
  const closed = await close(r.id, user, deps);
  assert.equal(closed.status, 'cerrada');
  assert.equal(closed.history.at(-1).action, 'close');
});
