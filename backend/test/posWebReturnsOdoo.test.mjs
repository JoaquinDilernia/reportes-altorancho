import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWebReturnPickings, runApprovalSteps, runReceiveSteps } from '../posWebReturnsOdoo.mjs';
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
const openReturn = (pickingId, qty = 1) => ({
  'stock.move.search_read': ([domain]) => (domain[1]?.[1] === 'not in'
    ? [{ picking_id: [pickingId, 'EC/RET/7'], product_id: [70417, 'x'], product_uom_qty: qty }] : []),
});

test('reintento con una devolución abierta sin origin: la adopta, le escribe el origin y no crea otra', async () => {
  const { odoo, calls } = fakeOdoo({
    ...openReturn(4500),
    'stock.picking.read': ([ids]) => [{ id: ids[0], name: 'EC/RET/7', state: 'assigned', origin: false }],
  });
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
  assert.deepEqual(calls.find(isOpenSearch)[2][0], [['origin_returned_move_id', 'in', [612602]], ['state', 'not in', ['done', 'cancel']]]);
  assert.ok(!writes(calls).some((w) => w.startsWith('stock.return.picking')));
  assert.deepEqual(callOf(calls, 'stock.picking.write')[2], [[4500], { origin: 'CW-000123 · pick:192311:fallas' }]);
  assert.deepEqual(steps.pickings['pick:192311:fallas'], { id: 4500, name: 'EC/RET/7', state: 'assigned', lots: {} });
});

test('devolución abierta con nuestro origin exacto: se adopta sin reescribirlo', async () => {
  const { odoo, calls } = fakeOdoo({
    ...openReturn(4500),
    'stock.picking.read': ([ids]) => [{ id: ids[0], name: 'EC/RET/7', state: 'assigned', origin: 'CW-000123 · pick:192311:fallas' }],
  });
  const steps = await runApprovalSteps(request({ evidence: [] }), settings, depsFor(odoo));
  assert.ok(!writes(calls).some((w) => w.startsWith('stock.return.picking') || w === 'stock.picking.write'));
  assert.equal(steps.pickings['pick:192311:fallas'].id, 4500);
});

test('devolución abierta con otro origin o que no cubre la cantidad: no se adopta', async () => {
  const other = fakeOdoo({ ...openReturn(4500), 'stock.picking.read': ([ids]) => [{ id: ids[0], name: 'EC/RET/7', state: 'assigned', origin: 'Lorena' }] });
  await runApprovalSteps(request({ evidence: [] }), settings, depsFor(other.odoo));
  assert.ok(writes(other.calls).includes('stock.return.picking.create_returns'), 'otro origin');
  assert.ok(!other.calls.some(([mo, me, args]) => mo === 'stock.picking' && me === 'write' && args[0][0] === 4500));

  const short = fakeOdoo({ ...openReturn(4500, 1), 'stock.picking.read': ([ids]) => [{ id: ids[0], name: 'EC/RET/7', state: 'assigned', origin: false }] });
  const deps = depsFor(short.odoo);
  deps.readMoves = async (ids) => ids.map((i) => move(i, 192311, 2));
  await runApprovalSteps(request({ evidence: [], returnLines: [rline({ qty: 2 })] }), settings, deps);
  assert.ok(writes(short.calls).includes('stock.return.picking.create_returns'), 'menos cantidad');
});

test('createReturnPicking tira "Se creó la devolución 77": guarda el id; el reintento la lee, le marca el origin y no la recrea', async () => {
  const { odoo, calls } = fakeOdoo({
    'stock.picking.read': ([ids]) => [{ id: ids[0], name: 'EC/RET/77', state: 'assigned', origin: false }],
  });
  const saved = [];
  const deps = depsFor(odoo, { saved });
  deps.createReturnPicking = async () => { throw new Error('Se creó la devolución 77 en Odoo pero no se pudo marcar: timeout'); };
  await assert.rejects(runApprovalSteps(request({ evidence: [] }), settings, deps), /Se creó la devolución 77/);
  assert.deepEqual(saved.at(-1).pickings['pick:192311:fallas'], { id: 77, name: null, state: null, lots: {} });
  calls.length = 0;
  deps.createReturnPicking = async () => assert.fail('no la recrea');
  const steps = await runApprovalSteps(request({ evidence: [], odoo: { steps: saved.at(-1) } }), settings, deps);
  assert.deepEqual(callOf(calls, 'stock.picking.write')[2], [[77], { origin: 'CW-000123 · pick:192311:fallas' }]);
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
