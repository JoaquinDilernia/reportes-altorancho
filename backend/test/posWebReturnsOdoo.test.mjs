import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWebReturnPickings, runApprovalSteps, runReceiveSteps, adoptableOrigin } from '../posWebReturnsOdoo.mjs';
import { buildOdooNoteLines } from '../posWebReturns.mjs';
import { netOfIva, round2 } from '../posPricing.mjs';
import {
  settings, user, rline, request, move, fakeOdoo, depsFor, writes, callOf,
} from './helpers/webReturnsFakes.mjs';

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
  assert.deepEqual(post[3], { body: 'Evidencia del cambio CW-000123', attachment_ids: [1001], subtype_xmlid: 'mail.mt_note' });
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
  assert.ok(!calls.some(([mo, me]) => mo === 'stock.move' && me === 'read'), 'reusa el plan guardado');
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

const withDry = async (fn) => {
  const prev = process.env.ODOO_WRITES;
  process.env.ODOO_WRITES = 'dry';
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.ODOO_WRITES; else process.env.ODOO_WRITES = prev;
  }
};
const isOpenSearch = ([mo, me, [d]]) => mo === 'stock.move' && me === 'search_read' && d?.[1]?.[1] === 'not in';
const ORIG = 'EC/OUT/47954';
const OURS = 'CW-000123 · pick:192311:fallas';
const openReturn = (pickingId, qty = 1, extra = []) => ({
  'stock.move.search_read': ([domain]) => (domain[1]?.[1] === 'not in'
    ? [{ picking_id: [pickingId, 'EC/RET/7'], product_id: [70417, 'x'], product_uom_qty: qty }, ...extra] : []),
});
// stock.picking.read por id: el EC/OUT original y la devolución con el origin dado.
const pickings = (returnId, origin, name = 'EC/RET/7') => ({
  'stock.picking.read': ([ids]) => [ids[0] === 192311
    ? { id: 192311, name: ORIG, state: 'done', origin: 'TN1700000000' }
    : ids[0] === returnId ? { id: returnId, name, state: 'assigned', origin }
      : { id: ids[0], name: 'EC/RET/00100', state: 'assigned', origin: false }],
});
const originWrites = (calls) => calls.filter(([mo, me]) => mo === 'stock.picking' && me === 'write').map((c) => c[2]);

test('adoptableOrigin: vacío, el nuestro o el del asistente del mismo remito', () => {
  for (const o of [false, '', '  ', OURS, `Retorno de ${ORIG}`, ` Return of ${ORIG} `, `Devolución de ${ORIG}`]) {
    assert.equal(adoptableOrigin(o, OURS, ORIG), true, String(o));
  }
  for (const o of ['CW-000999 · pick:192311:fallas', `Retorno de EC/OUT/47955`, `Retorno de ${ORIG} bis`, 'Lorena', `Retorno de ECXOUTX47954`]) {
    assert.equal(adoptableOrigin(o, OURS, ORIG), false, o);
  }
  assert.equal(adoptableOrigin(`Retorno de ${ORIG}`, OURS, null), false);
});

test('reintento con una devolución abierta "Retorno de <mismo EC/OUT>": la adopta, le escribe el origin y no crea otra', async () => {
  const { odoo, calls } = fakeOdoo({ ...openReturn(4500), ...pickings(4500, `Retorno de ${ORIG}`) });
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
  assert.deepEqual(calls.find(isOpenSearch)[2][0], [['origin_returned_move_id', 'in', [612602]], ['state', 'not in', ['done', 'cancel']]]);
  assert.ok(!writes(calls).some((w) => w.startsWith('stock.return.picking')));
  assert.deepEqual(originWrites(calls), [[[4500], { origin: OURS }]]);
  assert.deepEqual(steps.pickings['pick:192311:fallas'], { id: 4500, name: 'EC/RET/7', state: 'assigned', lots: {} });
});

test('devolución abierta sin origin: se adopta y se le escribe el nuestro', async () => {
  const { odoo, calls } = fakeOdoo({ ...openReturn(4500), ...pickings(4500, false) });
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
  assert.ok(!writes(calls).some((w) => w.startsWith('stock.return.picking')));
  assert.deepEqual(originWrites(calls), [[[4500], { origin: OURS }]]);
  assert.equal(steps.pickings['pick:192311:fallas'].id, 4500);
});

test('devolución abierta con nuestro origin exacto: se adopta sin reescribirlo', async () => {
  const { odoo, calls } = fakeOdoo({ ...openReturn(4500), ...pickings(4500, OURS) });
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
  assert.ok(!writes(calls).some((w) => w.startsWith('stock.return.picking') || w === 'stock.picking.write'));
  assert.equal(steps.pickings['pick:192311:fallas'].id, 4500);
});

test('devolución abierta de otra solicitud (CW-000999 · …) u otro origin: no se adopta, se crea', async () => {
  for (const origin of ['CW-000999 · pick:192311:fallas', 'Retorno de EC/OUT/11111', 'Lorena']) {
    const { odoo, calls } = fakeOdoo({ ...openReturn(4500), ...pickings(4500, origin) });
    await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
    assert.ok(writes(calls).includes('stock.return.picking.create_returns'), origin);
    assert.ok(!originWrites(calls).some(([[id]]) => id === 4500), origin);
  }
});

test('devolución abierta con más cantidad, menos cantidad u otro producto: no se adopta', async () => {
  const cases = [
    ['más cantidad', openReturn(4500, 2), 1],
    ['menos cantidad', openReturn(4500, 1), 2],
    ['producto de más', openReturn(4500, 1, [{ picking_id: [4500, 'EC/RET/7'], product_id: [80000, 'y'], product_uom_qty: 1 }]), 1],
  ];
  for (const [why, over, qty] of cases) {
    const { odoo, calls } = fakeOdoo({ ...over, ...pickings(4500, `Retorno de ${ORIG}`) });
    const deps = depsFor(odoo);
    deps.readMoves = async (ids) => ids.map((i) => move(i, 192311, 2));
    await runApprovalSteps(request({ evidence: [], returnLines: [rline({ qty })] }), settings, deps);
    assert.ok(writes(calls).includes('stock.return.picking.create_returns'), why);
    assert.ok(!originWrites(calls).some(([[id]]) => id === 4500), why);
  }
});

test('createReturnPicking tira "Se creó la devolución 77": guarda el id; el reintento reescribe el "Retorno de …" y no la recrea', async () => {
  const { odoo, calls } = fakeOdoo(pickings(77, `Retorno de ${ORIG}`, 'EC/RET/77'));
  const saved = [];
  const deps = depsFor(odoo, { saved });
  deps.createReturnPicking = async () => { throw new Error('Se creó la devolución 77 en Odoo pero no se pudo marcar: timeout'); };
  await assert.rejects(runApprovalSteps(request({ evidence: [] }), settings, deps), /Se creó la devolución 77/);
  assert.deepEqual(saved.at(-1).pickings['pick:192311:fallas'], { id: 77, name: null, state: null, lots: {} });
  calls.length = 0;
  deps.createReturnPicking = async () => assert.fail('no la recrea');
  const steps = await runApprovalSteps(request({ evidence: [], odoo: { steps: saved.at(-1) } }), settings, deps);
  assert.deepEqual(originWrites(calls), [[[77], { origin: OURS }]]);
  assert.deepEqual(steps.pickings['pick:192311:fallas'], { id: 77, name: 'EC/RET/77', state: 'assigned', lots: {} });
});

test('dry: no adopta nada de producción (ni sale.order por ref, ni devolución por origin o abierta)', async () => {
  await withDry(async () => {
    const { odoo, calls } = fakeOdoo({
      'sale.order.search_read': () => [{ id: 3000, name: 'S12001', state: 'sale' }],
      'stock.picking.search_read': () => [{ id: 4400, name: 'EC/RET/00099', state: 'assigned' }],
      ...openReturn(4500),
      'sale.order.create': () => -1,
      'stock.return.picking.create_returns': () => ({ res_id: -2 }),
    });
    const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
    assert.ok(!calls.some(([mo, me]) => mo === 'sale.order' && me === 'search_read'));
    assert.ok(!calls.some(([mo, me]) => mo === 'stock.picking' && me === 'search_read'));
    assert.ok(!calls.some(isOpenSearch));
    assert.equal(steps.saleOrder.id, -1);
    assert.deepEqual(steps.pickings['pick:192311:fallas'], { id: -2, name: null, state: 'draft', lots: {} });
  });
});

test('net > 0 sin producto nuevo con cantidad: tira, no pierde la diferencia', async () => {
  const { odoo, calls } = fakeOdoo();
  const req = request({ evidence: [], newLines: [{ productId: 90000, sku: 'X', name: 'X', qty: 0, price: 0 }] });
  await assert.rejects(runApprovalSteps({ ...req, money: { net: 3000 } }, settings, depsFor(odoo)), /No hay producto nuevo para cargar la diferencia/);
  assert.ok(!writes(calls).includes('sale.order.create'));
});

test('net > 0: si la primera línea nueva no tiene cantidad, la diferencia va en la siguiente', async () => {
  const { odoo, calls } = fakeOdoo();
  const req = request({ evidence: [], newLines: [{ productId: 1, qty: 0, price: 0 }, { productId: 2, qty: 1, price: 0 }] });
  await runApprovalSteps({ ...req, money: { net: 3000 } }, settings, depsFor(odoo));
  const lines = callOf(calls, 'sale.order.create')[2][0].order_line.map((c) => c[2]);
  assert.deepEqual(lines.slice(0, 2).map((l) => l.price_unit), [0, round2(netOfIva(3000))]);
});

test('adjunto sin id válido: tira con el nombre del archivo', async () => {
  const { odoo, calls } = fakeOdoo({ 'ir.attachment.create': () => [] });
  await assert.rejects(runApprovalSteps(request(), settings, depsFor(odoo)), /Odoo no creó el adjunto de a\.jpg/);
  assert.ok(!writes(calls).includes('sale.order.message_post'));
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
  await withDry(async () => {
    const { odoo, calls } = fakeOdoo();
    let called = false;
    const steps = await runReceiveSteps(request({ odoo: { steps: approvedSteps('assigned', -7) } }), depsFor(odoo, { validate: async () => { called = true; } }));
    assert.deepEqual(calls, []);
    assert.equal(called, false);
    assert.equal(steps.pickings['pick:192311:fallas'].state, 'done');
  });
});

// ---- No devolver dos veces la misma unidad entre solicitudes o flujos ----
// stock.move.search_read: las devoluciones (no canceladas) del move, con su remito.
const returnMovesOf = (rows) => ({
  'stock.move.search_read': ([domain]) => (domain[1]?.[1] === '!=' ? rows : []),
});
const retRow = (pickingId, qty = 1, state = 'assigned') => ({
  id: 8000 + pickingId, origin_returned_move_id: [612602, 'x'], product_uom_qty: qty, quantity_done: state === 'done' ? qty : 0, state, picking_id: [pickingId, 'EC/RET/9'],
});
const originsById = (byId) => ({
  'stock.picking.read': ([ids], kw) => ids.map((id) => ({ id, name: `EC/RET/${id}`, state: 'assigned', origin: byId[id] ?? false })),
});

test('aprobar con una devolución abierta del local sobre la unidad: Faltan 1 unidades, sin escribir nada', async () => {
  const { odoo, calls } = fakeOdoo({ ...returnMovesOf([retRow(4600)]), ...originsById({ 4600: 'Devolución POS-000045' }) });
  const saved = [];
  await assert.rejects(runApprovalSteps(request(), settings, depsFor(odoo, { saved })), /Faltan 1 unidades/);
  assert.deepEqual(writes(calls), []);
  assert.deepEqual(saved, []);
});

test('aprobar con la devolución abierta de otra solicitud (CW-000999): no crea una segunda', async () => {
  const { odoo, calls } = fakeOdoo({ ...returnMovesOf([retRow(4601)]), ...originsById({ 4601: 'CW-000999 · pick:192311:fallas' }) });
  await assert.rejects(runApprovalSteps(request({ kind: 'devolucion', evidence: [] }), settings, depsFor(odoo)), /Faltan 1 unidades/);
  assert.ok(!writes(calls).some((w) => w.startsWith('stock.return.picking')));
});

test('la devolución abierta cuenta como usada: con 2 entregadas y 1 abierta se reparte la otra', async () => {
  const { odoo } = fakeOdoo({ ...returnMovesOf([retRow(4602)]), ...originsById({ 4602: 'Devolución POS-000046' }) });
  const deps = depsFor(odoo);
  deps.readMoves = async (ids) => ids.map((i) => move(i, 192311, 2));
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, deps);
  assert.deepEqual(steps.plan[0].items, [{ moveId: 612602, productId: 70417, uomId: 1, qty: 1 }]);
  await assert.rejects(runApprovalSteps(request({ evidence: [], returnLines: [rline({ qty: 2 })] }), settings, deps), /Faltan 1 unidades/);
});

test('las devoluciones propias (nuestro origin o id guardado) no cuentan contra la solicitud al planear', async () => {
  const { odoo } = fakeOdoo({
    ...returnMovesOf([retRow(4603), retRow(4604)]),
    ...originsById({ 4603: 'CW-000123 · pick:192311:fallas', 4604: 'Retorno de EC/OUT/47954' }),
  });
  const deps = depsFor(odoo);
  deps.readMoves = async (ids) => ids.map((i) => move(i, 192311, 2));
  const req = request({ evidence: [], returnLines: [rline({ qty: 2 })], odoo: { steps: { pickings: {} } } });
  // 4604 sin dueño conocido: ocupa una unidad.
  await assert.rejects(runApprovalSteps(req, settings, deps), /Faltan 1 unidades/);
  const own = request({ evidence: [], returnLines: [rline({ qty: 2 })], odoo: { steps: { pickings: { 'pick:192311:ecommerce': { id: 4604 } } } } });
  const steps = await runApprovalSteps(own, settings, deps);
  assert.deepEqual(steps.plan[0].items.map((i) => i.qty), [2]);
});

test('reintento después de crear la propia devolución: reusa el plan, no tira Faltan ni la recrea', async () => {
  // Primera vuelta: crea la devolución y falla al leerla (queda guardada sin estado).
  let readFails = true;
  const { odoo, calls } = fakeOdoo({
    'stock.picking.read': ([ids]) => {
      if (readFails) throw new Error('timeout');
      return ids.map((id) => ({ id, name: 'EC/RET/00100', state: 'assigned', origin: OURS }));
    },
  });
  const saved = [];
  const deps = depsFor(odoo, { saved });
  await assert.rejects(runApprovalSteps(request({ evidence: [] }), settings, deps), /timeout/);
  const last = saved.at(-1);
  assert.equal(last.pickings['pick:192311:fallas'].id, 4321);
  // Ahora Odoo muestra esa devolución abierta sobre la unidad.
  readFails = false;
  calls.length = 0;
  Object.assign(deps, depsFor(fakeOdoo({ ...returnMovesOf([retRow(4321)]), ...originsById({ 4321: OURS }) }).odoo, { saved }));
  deps.createReturnPicking = async () => assert.fail('no la recrea');
  const steps = await runApprovalSteps(request({ evidence: [], odoo: { steps: last } }), settings, deps);
  assert.equal(steps.pickings['pick:192311:fallas'].id, 4321);
  // Y aunque se perdiera el plan, la propia devolución (nuestro origin) no cuenta en contra.
  const { odoo: o2 } = fakeOdoo({ ...returnMovesOf([retRow(4321)]), ...originsById({ 4321: OURS }), 'stock.picking.search_read': () => [{ id: 4321, name: 'EC/RET/00100', state: 'assigned' }] });
  const again = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(o2));
  assert.equal(again.pickings['pick:192311:fallas'].id, 4321);
});
