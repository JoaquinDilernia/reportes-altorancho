import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWebReturnPickings, runApprovalSteps, runReceiveSteps } from '../posWebReturnsOdoo.mjs';
import { approve, receive, reject, derive, refundDone, close } from '../posWebReturnsService.mjs';
import * as rOdoo from '../posReturnsOdoo.mjs';
import * as store from '../posWebReturnsStore.mjs';
import { DEFAULT_SETTINGS } from '../posConfig.mjs';
import { buildOdooNoteLines } from '../posWebReturns.mjs';
import { netOfIva, round2 } from '../posPricing.mjs';
import { createFakeFirestore } from './helpers/fakeFirestore.mjs';

const settings = DEFAULT_SETTINGS;
const user = { uid: 'u1', name: 'Mili' };

const rline = (o = {}) => ({
  purchaseLineId: '501', productId: 70417, sku: 'BCC104TR', name: 'Taza', qty: 1, unitValue: 10000,
  destinationId: 'fallas', moveIds: [612602], lots: [], ...o,
});
const request = (o = {}) => ({
  id: 'r1', number: 'CW-000123', status: 'pendiente_aprobacion', kind: 'cambio', reason: 'falla', reasonLabel: 'ROTURA',
  reasonNote: 'Llegó rota', productOrigin: 'importado',
  customer: { name: 'Ana Perez', phone: '1155', address: 'Calle 1' },
  purchase: { source: 'web', purchaseId: '9001', ref: '41234', tnOrderId: 1700000000, date: '2026-11-01T10:00:00.000Z' },
  returnLines: [rline()],
  newLines: [{ productId: 70417, sku: 'BCC104TR', name: 'Taza', qty: 1, price: 10000 }],
  evidence: [{ storagePath: 'web_returns/r1/a.jpg', kind: 'photo', mimetype: 'image/jpeg' }],
  logistics: { mode: 'retiro_domicilio', payer: 'altorancho', cost: 0, shippingCharge: 0 },
  money: {}, odoo: { steps: {}, error: null },
  ...o,
});

const move = (id, pickingId = 192311, qty = 1, productId = 70417) => ({
  id, product_id: [productId, 'x'], quantity_done: qty, product_uom: [1, 'u'], picking_id: [pickingId, 'EC/OUT/1'],
});

// Odoo falso: registra [model, method, args, kwargs]; responde por "model.method".
function fakeOdoo(over = {}) {
  const calls = [];
  let nextId = 1000;
  const handlers = {
    'sale.order.search_read': () => [],
    'sale.order.read': ([ids], kw) => (kw.fields.includes('partner_id')
      ? [{ id: ids[0], partner_id: [77, 'Ana'], partner_shipping_id: [78, 'Ana envío'] }]
      : [{ id: ids[0], name: 'S12000', state: 'draft' }]),
    'sale.order.create': () => nextId++,
    'sale.order.action_confirm': () => true,
    'sale.order.message_post': () => 55,
    'ir.attachment.create': () => [nextId++],
    'stock.move.read': ([ids]) => ids.map((i) => move(i)),
    'stock.move.search_read': () => [],
    'stock.picking.search_read': () => [],
    'stock.return.picking.create': () => [nextId++],
    'stock.return.picking.create_returns': () => ({ res_id: 4321 }),
    'stock.picking.write': () => true,
    'stock.picking.read': ([ids]) => [{ id: ids[0], name: 'EC/RET/00100', state: 'assigned' }],
    ...over,
  };
  const run = async (model, method, args = [], kwargs = {}) => {
    calls.push([model, method, structuredClone(args), structuredClone(kwargs)]);
    const h = handlers[`${model}.${method}`];
    if (!h) throw new Error(`sin handler: ${model}.${method}`);
    return h(args, kwargs);
  };
  return { odoo: { read: run, write: run }, calls };
}

function depsFor(odoo, { db, saved = [], validate } = {}) {
  return {
    odoo,
    readMoves: (ids) => rOdoo.readMoves(ids, odoo),
    returnedQtyByMove: (ids) => rOdoo.returnedQtyByMove(ids, odoo),
    findPickingByOrigin: (origin) => rOdoo.findPickingByOrigin(origin, odoo),
    createReturnPicking: (args) => rOdoo.createReturnPicking(args, odoo),
    validatePicking: validate ?? ((id, lots) => rOdoo.validatePicking(id, lots, odoo)),
    saveOdooSteps: async (id, steps) => {
      saved.push(structuredClone(steps));
      if (db) await store.saveOdooSteps(id, steps, db);
    },
    readEvidence: async (path) => ({ base64: 'QUJD', mimetype: 'image/jpeg', name: path.split('/').pop() }),
    getSettings: async () => settings,
    store: db && {
      getWebReturn: (id) => store.getWebReturn(id, db),
      claimTransition: (id, action, u, extra) => store.claimTransition(id, action, u, extra, undefined, db),
      finishTransition: (id, args) => store.finishTransition(id, args, db),
      failTransition: (id, err) => store.failTransition(id, err, db),
    },
  };
}

const writes = (calls) => calls.filter(([, m]) => !['read', 'search_read', 'search'].includes(m)).map(([mo, me]) => `${mo}.${me}`);
const callOf = (calls, key) => calls.find(([mo, me]) => `${mo}.${me}` === key);

// ---- planWebReturnPickings ----

test('planWebReturnPickings: 2 líneas del mismo EC/OUT y destino → un grupo con 2 items', () => {
  const req = request({ returnLines: [rline(), rline({ purchaseLineId: '502', productId: 80000, sku: 'X2', moveIds: [612603] })] });
  const movesById = new Map([[612602, move(612602)], [612603, move(612603, 192311, 1, 80000)]]);
  const plan = planWebReturnPickings(req, movesById, new Map(), settings);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].key, 'pick:192311:fallas');
  assert.equal(plan[0].pickingId, 192311);
  assert.equal(plan[0].locationId, 192);
  assert.deepEqual(plan[0].items, [
    { moveId: 612602, productId: 70417, uomId: 1, qty: 1 },
    { moveId: 612603, productId: 80000, uomId: 1, qty: 1 },
  ]);
});

test('planWebReturnPickings: destino desconocido tira', () => {
  const req = request({ returnLines: [rline({ destinationId: 'marte' })] });
  assert.throws(() => planWebReturnPickings(req, new Map([[612602, move(612602)]]), new Map(), settings), /BCC104TR: el destino ya no existe, elegí otro/);
});

test('planWebReturnPickings: destinos distintos → grupos distintos; no reparte dos veces la misma unidad', () => {
  const req = request({ returnLines: [rline(), rline({ purchaseLineId: '501', destinationId: 'ecommerce' })] });
  const movesById = new Map([[612602, move(612602, 192311, 2)]]);
  const plan = planWebReturnPickings(req, movesById, new Map(), settings);
  assert.deepEqual(plan.map((g) => [g.key, g.locationId]), [['pick:192311:fallas', 192], ['pick:192311:ecommerce', 150]]);
  assert.throws(() => planWebReturnPickings(req, new Map([[612602, move(612602)]]), new Map(), settings), /Faltan 1 unidades/);
});

// ---- runApprovalSteps ----

test('aprobar un cambio: sale.order confirmado, evidencia y devolución sin validar, en orden', async () => {
  const { odoo, calls } = fakeOdoo();
  const saved = [];
  const steps = await runApprovalSteps(request(), settings, depsFor(odoo, { saved }));
  assert.deepEqual(writes(calls), [
    'sale.order.create', 'sale.order.action_confirm', 'ir.attachment.create', 'sale.order.message_post',
    'stock.return.picking.create', 'stock.return.picking.create_returns', 'stock.picking.write',
  ]);
  assert.ok(!calls.some(([, m]) => m === 'button_validate'));
  const [, , [vals]] = callOf(calls, 'sale.order.create');
  assert.equal(vals.warehouse_id, 24);
  assert.equal(vals.team_id, 1);
  assert.deepEqual(vals.tag_ids, [[6, 0, [18]]]);
  assert.equal(vals.client_order_ref, 'CW-000123');
  assert.equal(vals.partner_id, 77);
  assert.equal(vals.partner_shipping_id, 78);
  const lines = vals.order_line.map(([a, b, l]) => (assert.deepEqual([a, b], [0, 0]), l));
  const notes = lines.filter((l) => l.display_type === 'line_note');
  assert.equal(notes.length, 4);
  assert.deepEqual(notes.map((l) => l.name), buildOdooNoteLines(request()));
  assert.deepEqual(notes[0], { display_type: 'line_note', name: 'IMPORTADO', product_id: false, product_uom_qty: 0, price_unit: 0 });
  assert.deepEqual(lines[0], { product_id: 70417, product_uom_qty: 1, price_unit: 0 });
  assert.equal(lines.length, 5); // producto + 4 notas, sin envío
  // Original leído para el cliente.
  assert.deepEqual(calls.find(([mo, me, , kw]) => mo === 'sale.order' && me === 'read' && kw.fields.includes('partner_id'))[2], [[9001]]);
  // Búsqueda por referencia.
  assert.deepEqual(callOf(calls, 'sale.order.search_read')[2], [[['client_order_ref', '=', 'CW-000123']]]);
  // Adjuntos sobre el pedido nuevo.
  const [, , [att]] = callOf(calls, 'ir.attachment.create');
  assert.deepEqual(att, { name: 'a.jpg', datas: 'QUJD', mimetype: 'image/jpeg', res_model: 'sale.order', res_id: 1000 });
  const post = callOf(calls, 'sale.order.message_post');
  assert.deepEqual(post[2], [[1000]]);
  assert.deepEqual(post[3], { body: 'Evidencia del cambio CW-000123', attachment_ids: [1001] });
  // Devolución sobre el EC/OUT original con origin.
  const [, , [[wizard]]] = callOf(calls, 'stock.return.picking.create');
  assert.equal(wizard.picking_id, 192311);
  assert.equal(wizard.location_id, 192);
  assert.deepEqual(callOf(calls, 'stock.picking.search_read')[2][0][0], ['origin', '=', 'CW-000123 · pick:192311:fallas']);
  assert.deepEqual(callOf(calls, 'stock.picking.write')[2], [[4321], { origin: 'CW-000123 · pick:192311:fallas' }]);
  // Pasos.
  assert.deepEqual(steps.saleOrder, { id: 1000, name: 'S12000', confirmed: true });
  assert.deepEqual(steps.evidence, { attachmentIds: [1001], posted: true });
  assert.deepEqual(steps.pickings['pick:192311:fallas'], { id: 4321, name: 'EC/RET/00100', state: 'assigned', lots: {} });
  assert.equal(steps.plan.length, 1);
  // Plan guardado antes de cualquier escritura; se guarda después de cada paso.
  assert.ok(saved[0].plan && !saved[0].saleOrder);
  assert.deepEqual(saved.at(-1), steps);
});

test('reintento después de que falle create_returns: no recrea el sale.order ni la evidencia', async () => {
  let fail = true;
  const { odoo, calls } = fakeOdoo({
    'stock.return.picking.create_returns': () => {
      if (fail) throw new Error('Odoo caído');
      return { res_id: 4321 };
    },
  });
  const saved = [];
  const deps = depsFor(odoo, { saved });
  await assert.rejects(runApprovalSteps(request(), settings, deps), /Odoo caído/);
  const last = saved.at(-1);
  assert.deepEqual(last.saleOrder, { id: 1000, name: 'S12000', confirmed: true });
  fail = false;
  calls.length = 0;
  const steps = await runApprovalSteps(request({ odoo: { steps: last, error: null } }), settings, deps);
  assert.deepEqual(writes(calls), ['stock.return.picking.create', 'stock.return.picking.create_returns', 'stock.picking.write']);
  assert.ok(!calls.some(([mo, me]) => mo === 'stock.move'), 'reusa el plan guardado');
  assert.equal(steps.pickings['pick:192311:fallas'].id, 4321);
});

test('reintento con la devolución ya existente por origin: la adopta y no la recrea', async () => {
  const { odoo, calls } = fakeOdoo({
    'stock.picking.search_read': () => [{ id: 4400, name: 'EC/RET/00099', state: 'assigned' }],
  });
  const steps = await runApprovalSteps(request(), settings, depsFor(odoo));
  assert.ok(!writes(calls).some((w) => w.startsWith('stock.return.picking')));
  assert.deepEqual(steps.pickings['pick:192311:fallas'], { id: 4400, name: 'EC/RET/00099', state: 'assigned', lots: {} });
});

test('sale.order existente por client_order_ref: lo adopta, y si ya está confirmado no lo confirma', async () => {
  const { odoo, calls } = fakeOdoo({ 'sale.order.search_read': () => [{ id: 3000, name: 'S12001', state: 'sale' }] });
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
  assert.ok(!writes(calls).includes('sale.order.create'));
  assert.ok(!writes(calls).includes('sale.order.action_confirm'));
  assert.deepEqual(steps.saleOrder, { id: 3000, name: 'S12001', confirmed: true });
  assert.equal(steps.evidence, undefined);
});

test('sale.order adoptado cancelado: tira sin escribir', async () => {
  const { odoo, calls } = fakeOdoo({ 'sale.order.search_read': () => [{ id: 3000, name: 'S12001', state: 'cancel' }] });
  await assert.rejects(runApprovalSteps(request(), settings, depsFor(odoo)), /S12001 está cancelado en Odoo/);
  assert.deepEqual(writes(calls), []);
});

test('saleOrder guardado sin confirmar: relee el estado y no confirma si ya está en sale', async () => {
  const { odoo, calls } = fakeOdoo({ 'sale.order.read': ([ids]) => [{ id: ids[0], name: 'S12000', state: 'sale' }] });
  const prev = { plan: null, saleOrder: { id: 1000, name: null, confirmed: false } };
  const steps = await runApprovalSteps(request({ evidence: [], odoo: { steps: prev } }), settings, depsFor(odoo));
  assert.ok(!writes(calls).includes('sale.order.create'));
  assert.ok(!writes(calls).includes('sale.order.action_confirm'));
  assert.deepEqual(steps.saleOrder, { id: 1000, name: 'S12000', confirmed: true });
});

test('devolución: sin sale.order nuevo; evidencia sobre el pedido TN original', async () => {
  const { odoo, calls } = fakeOdoo();
  const steps = await runApprovalSteps(request({ kind: 'devolucion', newLines: [] }), settings, depsFor(odoo));
  assert.ok(!writes(calls).includes('sale.order.create'));
  assert.ok(!calls.some(([mo, me]) => mo === 'sale.order' && ['search_read', 'read'].includes(me)));
  assert.equal(callOf(calls, 'ir.attachment.create')[2][0].res_id, 9001);
  assert.deepEqual(callOf(calls, 'sale.order.message_post')[2], [[9001]]);
  assert.equal(steps.saleOrder, undefined);
  assert.equal(steps.pickings['pick:192311:fallas'].id, 4321);
});

test('cambio a un producto más caro: la primera línea nueva lleva netOfIva(net)/qty', async () => {
  const { odoo, calls } = fakeOdoo();
  const req = request({
    newLines: [{ productId: 90000, sku: 'CARO', name: 'Caro', qty: 2, price: 7500 }, { productId: 90001, sku: 'Y', name: 'Y', qty: 1, price: 0 }],
    evidence: [],
  });
  await runApprovalSteps({ ...req, money: { net: 5000, differenceToCollect: 5000 } }, settings, depsFor(odoo));
  const lines = callOf(calls, 'sale.order.create')[2][0].order_line.map((c) => c[2]);
  assert.deepEqual(lines[0], { product_id: 90000, product_uom_qty: 2, price_unit: round2(netOfIva(5000) / 2) });
  assert.deepEqual(lines[1], { product_id: 90001, product_uom_qty: 1, price_unit: 0 });
});

test('net negativo o cero: todas las líneas de producto en $0', async () => {
  const { odoo, calls } = fakeOdoo();
  await runApprovalSteps({ ...request({ evidence: [] }), money: { net: -2000, differenceToCollect: 0 } }, settings, depsFor(odoo));
  const lines = callOf(calls, 'sale.order.create')[2][0].order_line.map((c) => c[2]);
  assert.equal(lines[0].price_unit, 0);
});

test('shippingCharge: agrega la línea de envío con el producto 30306 y precio sin IVA, antes de las notas', async () => {
  const { odoo, calls } = fakeOdoo();
  const req = request({ evidence: [], logistics: { mode: 'logistica_paga_cliente', payer: 'cliente', cost: 0, shippingCharge: 6000 } });
  await runApprovalSteps(req, settings, depsFor(odoo));
  const lines = callOf(calls, 'sale.order.create')[2][0].order_line.map((c) => c[2]);
  assert.deepEqual(lines[1], { product_id: 30306, product_uom_qty: 1, price_unit: round2(netOfIva(6000)) });
  assert.equal(lines[2].display_type, 'line_note');
});

test('lotes de las líneas que vuelven quedan guardados en el paso de la devolución', async () => {
  const { odoo } = fakeOdoo();
  const req = request({ returnLines: [rline({ lots: [{ lotId: 9, qty: 1 }] })] });
  const steps = await runApprovalSteps(req, settings, depsFor(odoo));
  assert.deepEqual(steps.pickings['pick:192311:fallas'].lots, { 70417: [{ lotId: 9, qty: 1 }] });
});

test('create devuelve un id suelto o un array: los dos sirven', async () => {
  const { odoo } = fakeOdoo({ 'sale.order.create': () => [1500], 'ir.attachment.create': () => 1600 });
  const steps = await runApprovalSteps(request(), settings, depsFor(odoo));
  assert.equal(steps.saleOrder.id, 1500);
  assert.deepEqual(steps.evidence.attachmentIds, [1600]);
});

test('dry: id negativo del sale.order no se lee; nombre = número de la solicitud', async () => {
  const { odoo, calls } = fakeOdoo({ 'sale.order.create': () => -3 });
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
  assert.ok(!calls.some(([mo, me, , kw]) => mo === 'sale.order' && me === 'read' && kw.fields.includes('state')));
  assert.deepEqual(steps.saleOrder, { id: -3, name: 'CW-000123', confirmed: true });
});

// ---- runReceiveSteps ----

const approvedSteps = (state = 'assigned', id = 4321) => ({
  plan: [{ key: 'pick:192311:fallas', pickingId: 192311, locationId: 192, items: [] }],
  pickings: { 'pick:192311:fallas': { id, name: null, state, lots: { 70417: [{ lotId: 9, qty: 1 }] } } },
});

test('runReceiveSteps: valida la devolución con sus lotes', async () => {
  const { odoo } = fakeOdoo({ 'stock.picking.read': () => [{ id: 4321, name: 'EC/RET/1', state: 'assigned' }] });
  const validated = [];
  const validate = async (id, lots) => { validated.push([id, [...lots]]); return { id, name: 'EC/RET/1', state: 'done' }; };
  const saved = [];
  const steps = await runReceiveSteps(request({ status: 'aprobada', odoo: { steps: approvedSteps() } }), depsFor(odoo, { validate, saved }));
  assert.deepEqual(validated, [[4321, [[70417, [{ lotId: 9, qty: 1 }]]]]]);
  assert.equal(steps.pickings['pick:192311:fallas'].state, 'done');
  assert.deepEqual(steps.pickings['pick:192311:fallas'].lots, { 70417: [{ lotId: 9, qty: 1 }] });
  assert.equal(saved.length, 1);
});

test('runReceiveSteps: devolución ya done no llama a validatePicking', async () => {
  const { odoo } = fakeOdoo({ 'stock.picking.read': () => [{ id: 4321, name: 'EC/RET/1', state: 'done' }] });
  let called = false;
  const steps = await runReceiveSteps(request({ odoo: { steps: approvedSteps() } }), depsFor(odoo, { validate: async () => { called = true; } }));
  assert.equal(called, false);
  assert.equal(steps.pickings['pick:192311:fallas'].state, 'done');
  assert.equal(steps.pickings['pick:192311:fallas'].name, 'EC/RET/1');
});

test('runReceiveSteps: devolución cancelada tira', async () => {
  const { odoo } = fakeOdoo({ 'stock.picking.read': () => [{ id: 4321, name: 'EC/RET/1', state: 'cancel' }] });
  await assert.rejects(
    runReceiveSteps(request({ odoo: { steps: approvedSteps() } }), depsFor(odoo, { validate: async () => assert.fail('no valida') })),
    /La devolución EC\/RET\/1 está cancelada en Odoo: recreala desde el detalle/,
  );
});

test('runReceiveSteps: si después de validar no quedó done, tira', async () => {
  const { odoo } = fakeOdoo({ 'stock.picking.read': () => [{ id: 4321, name: 'EC/RET/1', state: 'assigned' }] });
  const validate = async (id) => ({ id, name: 'EC/RET/1', state: 'assigned' });
  await assert.rejects(runReceiveSteps(request({ odoo: { steps: approvedSteps() } }), depsFor(odoo, { validate })), /EC\/RET\/1 no quedó validada/);
});

test('runReceiveSteps: falta la devolución de un grupo del plan → tira', async () => {
  const { odoo } = fakeOdoo();
  const steps = { ...approvedSteps(), pickings: {} };
  await assert.rejects(runReceiveSteps(request({ odoo: { steps } }), depsFor(odoo)), /Falta la devolución pick:192311:fallas/);
});

test('runReceiveSteps con ODOO_WRITES=dry e id negativo: no toca Odoo y la marca done', async () => {
  const prev = process.env.ODOO_WRITES;
  process.env.ODOO_WRITES = 'dry';
  try {
    const { odoo, calls } = fakeOdoo();
    let called = false;
    const steps = await runReceiveSteps(request({ odoo: { steps: approvedSteps('assigned', -7) } }), depsFor(odoo, { validate: async () => { called = true; } }));
    assert.deepEqual(calls, []);
    assert.equal(called, false);
    assert.equal(steps.pickings['pick:192311:fallas'].state, 'done');
  } finally {
    if (prev === undefined) delete process.env.ODOO_WRITES; else process.env.ODOO_WRITES = prev;
  }
});

// ---- Servicio ----

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
