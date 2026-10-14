import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmPosOrder, pairOdooLineIds, invoicingEnabledFor, invoicePosOrder, annulPosOrder, claimAndConfirmPos, runPostConfirmSteps,
} from '../posConfirm.mjs';
import { DEFAULT_LOCALES, DEFAULT_SETTINGS, DEFAULT_PAYMENT_METHODS } from '../posConfig.mjs';

const ctx = {
  locale: DEFAULT_LOCALES[0], locales: DEFAULT_LOCALES, settings: DEFAULT_SETTINGS,
  methodsById: new Map(DEFAULT_PAYMENT_METHODS.map((m) => [m.id, m])),
};

const baseOrder = () => ({
  id: 'o1', number: 'LL-0001', localId: 'LL', status: 'pendiente', wantsInvoice: false, odooOrders: [], odooOrderId: null,
  customer: { docNumber: '30123456', name: 'Ana', phone: '1155556666', email: 'a@b.com' },
  payments: [{ methodId: 'efectivo', detailId: null, amount: null }],
  totals: { lineDiscountPct: 15, shipping: 0, total: 2057 },
  shipping: null,
  lines: [
    { lineId: 'L1', productId: 10, sku: 'A', qty: 1, basePrice: 1210, origin: 'stock', delivery: 'ahora', status: 'activo' },
    { lineId: 'L2', productId: 11, sku: 'B', qty: 1, basePrice: 1210, origin: 'rolon', delivery: 'retira_local', status: 'activo' },
  ],
});

function fakeDeps(overrides = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push([name, ...structuredClone(args)]);
    return typeof result === 'function' ? result(...args) : result;
  };
  let nextOrderId = 9000;
  const lineIdsByOrder = { 9000: [71], 9001: [72, 73] };
  const deps = {
    findOrCreatePosPartner: rec('partner', 500),
    findPaymentMethodId: rec('paymentMethod', 5),
    findProductIdBySku: rec('productBySku', 45870),
    createChildPartner: rec('childPartner', 600),
    findChildPartner: rec('findChild', null),
    createSaleOrder: rec('createSaleOrder', () => nextOrderId++),
    saveOdooOrders: rec('saveOdooOrders'),
    readOrderLineIds: rec('readOrderLineIds', (id) => lineIdsByOrder[id]),
    saveOdooLineIds: rec('saveOdooLineIds'),
    confirmSaleOrder: rec('confirmSaleOrder'),
    findSaleOrdersByRef: rec('findByRef', []),
    readOrderStates: rec('orderStates', (ids) => ids.map((id) => ({ id, name: `S${id}`, state: 'draft' }))),
    clearPostConfirmPending: rec('clearPending'),
    markOrderConfirmed: rec('markOrderConfirmed'),
    getOrder: rec('getOrder', () => ({ id: 'o1', status: 'confirmado' })),
    alignFirstLegMoves: rec('alignFirstLegMoves', []),
    validateTwoStep: rec('validateTwoStep', { delivered: [71] }),
    markLinesDelivered: rec('markLinesDelivered'),
    setOrderWarning: rec('setOrderWarning'),
    invoice: rec('invoice', { status: 'skipped' }),
    ...overrides,
  };
  return { deps, calls };
}

const named = (calls, name) => calls.filter((c) => c[0] === name);
const indexOf = (calls, name, n = 0) => calls.findIndex((c) => c === named(calls, name)[n]);

test('pairOdooLineIds: asigna en orden y avisa si Odoo devolvió menos', () => {
  const lines = baseOrder().lines;
  assert.deepEqual(pairOdooLineIds(lines, [71, 72]).map((l) => l.odooLineId), [71, 72]);
  assert.throws(() => pairOdooLineIds(lines, [71]), /devolvió 1 líneas/);
});

test('confirmPosOrder: venta mixta → 2 pedidos (local 1, después Rolón 28), mismo equipo y referencia', async () => {
  const { deps, calls } = fakeDeps();
  await confirmPosOrder(baseOrder(), 'Caja Lomas', ctx, deps);
  const payloads = named(calls, 'createSaleOrder').map((c) => c[1]);
  assert.deepEqual(payloads.map((p) => p.warehouse_id), [1, 28]);
  assert.deepEqual(payloads.map((p) => p.team_id), [6, 6]);
  assert.deepEqual(payloads.map((p) => p.client_order_ref), ['LL-0001', 'LL-0001']);
  assert.deepEqual(payloads.map((p) => p.payment_method_ids), [5, 5]);
  assert.deepEqual(payloads.map((p) => p.pricelist_id), [314, 314]);
  assert.equal(payloads[0].order_line.length, 1);
  assert.equal(payloads[0].order_line[0][2].price_unit, 1000);
  assert.equal(payloads[0].order_line[0][2].discount, 15);
  assert.equal(payloads[0].order_line[0][2].product_id, 10);
  assert.equal(payloads[1].order_line[0][2].product_id, 11);
  // Local todo "ahora": entrega al propio cliente. Rolón retira en el local.
  assert.equal(payloads[0].partner_shipping_id, 500);
  assert.equal(payloads[1].partner_shipping_id, 600);
  assert.equal(named(calls, 'childPartner')[0][1].name, 'Ana — Retira en Local Las Lomas');
  // Cada pedido se guarda ANTES de crear el siguiente.
  assert.deepEqual(named(calls, 'saveOdooOrders').map((c) => c[2]), [
    [{ group: 'local', odooOrderId: 9000, odooOrderName: null }],
    [{ group: 'local', odooOrderId: 9000, odooOrderName: null }, { group: 'rolon', odooOrderId: 9001, odooOrderName: null }],
  ]);
  assert.ok(indexOf(calls, 'saveOdooOrders', 0) < indexOf(calls, 'createSaleOrder', 1));
  // Líneas emparejadas por grupo y guardadas una vez.
  assert.equal(named(calls, 'saveOdooLineIds').length, 1);
  assert.deepEqual(named(calls, 'saveOdooLineIds')[0][2].map((l) => [l.lineId, l.odooLineId]), [['L1', 71], ['L2', 72]]);
  assert.deepEqual(named(calls, 'confirmSaleOrder').map((c) => c[1]), [9000, 9001]);
  assert.deepEqual(named(calls, 'markOrderConfirmed')[0][2], {
    odooOrders: [{ group: 'local', odooOrderId: 9000, odooOrderName: 'S9000' }, { group: 'rolon', odooOrderId: 9001, odooOrderName: 'S9001' }],
    user: 'Caja Lomas',
  });
  assert.equal(named(calls, 'setOrderWarning').length, 0);
});

test('confirmPosOrder: reintento con el pedido local ya creado crea SOLO el de Rolón (Review Focus #5)', async () => {
  const { deps, calls } = fakeDeps({ createSaleOrder: async (vals) => { calls.push(['createSaleOrder', vals]); return 9001; } });
  const order = { ...baseOrder(), status: 'error', odooOrders: [{ group: 'local', odooOrderId: 9000, odooOrderName: null }], odooOrderId: 9000 };
  await confirmPosOrder(order, 'Reintento', ctx, deps);
  const created = named(calls, 'createSaleOrder');
  assert.equal(created.length, 1);
  assert.equal(created[0][1].warehouse_id, 28);
  assert.deepEqual(named(calls, 'saveOdooOrders').map((c) => c[2]), [
    [{ group: 'local', odooOrderId: 9000, odooOrderName: null }, { group: 'rolon', odooOrderId: 9001, odooOrderName: null }],
  ]);
  assert.deepEqual(named(calls, 'confirmSaleOrder').map((c) => c[1]), [9000, 9001]);
});

test('confirmPosOrder: reintento con todo creado y emparejado no crea ni vuelve a leer líneas', async () => {
  const { deps, calls } = fakeDeps();
  const order = {
    ...baseOrder(), status: 'error', odooOrderId: 9000,
    odooOrders: [{ group: 'local', odooOrderId: 9000, odooOrderName: null }, { group: 'rolon', odooOrderId: 9001, odooOrderName: null }],
    lines: baseOrder().lines.map((l, i) => ({ ...l, odooLineId: 71 + i })),
  };
  await confirmPosOrder(order, 'Reintento', ctx, deps);
  assert.equal(named(calls, 'createSaleOrder').length, 0);
  assert.equal(named(calls, 'paymentMethod').length, 0);
  assert.equal(named(calls, 'readOrderLineIds').length, 0);
  assert.equal(named(calls, 'saveOdooLineIds').length, 0);
  assert.deepEqual(named(calls, 'confirmSaleOrder').map((c) => c[1]), [9000, 9001]);
});

test('confirmPosOrder: pedido en Odoo sin detalle de grupos → error, nunca un pedido duplicado', async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(confirmPosOrder({ ...baseOrder(), odooOrderId: 9000, odooOrders: [] }, 'Caja', ctx, deps), /ya existe en Odoo/);
  assert.equal(named(calls, 'createSaleOrder').length, 0);
});

test('confirmPosOrder: "ahora" valida PICK y OUT del pedido local desde la ubicación exacta', async () => {
  const { deps, calls } = fakeDeps();
  await confirmPosOrder(baseOrder(), 'Caja', ctx, deps);
  assert.deepEqual(named(calls, 'validateTwoStep')[0].slice(1), [9000, [{ odooLineId: 71, qty: 1, locationId: 8 }]]);
  assert.deepEqual(named(calls, 'markLinesDelivered')[0].slice(1), ['o1', ['L1'], 'Caja']);
  assert.ok(indexOf(calls, 'markOrderConfirmed') < indexOf(calls, 'validateTwoStep'));
});

test('confirmPosOrder: línea de Exhibición → alignFirstLegMoves con la ubicación 324', async () => {
  const { deps, calls } = fakeDeps();
  const order = baseOrder();
  order.lines[0] = { ...order.lines[0], origin: 'exhibicion', delivery: 'retira_local' };
  await confirmPosOrder(order, 'Caja', ctx, deps);
  assert.deepEqual(named(calls, 'alignFirstLegMoves')[0].slice(1), [[{ odooLineId: 71, locationId: 324 }]]);
  assert.equal(named(calls, 'validateTwoStep').length, 0);
});

test('confirmPosOrder: si falla validateTwoStep la venta queda confirmada con aviso', async () => {
  const { deps, calls } = fakeDeps({ validateTwoStep: async () => { throw new Error('sin stock'); } });
  await confirmPosOrder(baseOrder(), 'Caja', ctx, deps);
  assert.ok(named(calls, 'markOrderConfirmed').length);
  assert.equal(named(calls, 'markLinesDelivered').length, 0);
  assert.match(named(calls, 'setOrderWarning')[0][2], /no se pudo validar la entrega en el acto \(sin stock\).*validá PICK y OUT en Odoo/);
});

test('confirmPosOrder: el costo de envío va en el pedido que tiene la línea con envío', async () => {
  const { deps, calls } = fakeDeps();
  const order = baseOrder();
  order.lines[1] = { ...order.lines[1], delivery: 'envio' };
  order.totals = { ...order.totals, shipping: 6050 };
  order.shipping = { street: 'Calle', number: '1', floor: '', city: 'CABA', zip: '1000', phone: '11', notes: '' };
  await confirmPosOrder(order, 'Caja', ctx, deps);
  const [local, rolon] = named(calls, 'createSaleOrder').map((c) => c[1]);
  assert.equal(local.order_line.length, 1);
  assert.deepEqual(rolon.order_line.map((l) => [l[2].product_id, l[2].price_unit, l[2].discount]), [[11, 1000, 15], [45870, 5000, 0]]);
  assert.equal(named(calls, 'childPartner')[0][1].street, 'Calle 1');
  // La línea de envío (73) queda última y no se empareja con ninguna línea de la app.
  assert.deepEqual(named(calls, 'saveOdooLineIds')[0][2].map((l) => l.odooLineId), [71, 72]);
});

test('confirmPosOrder: factura solo si la pidieron y está habilitada', async () => {
  process.env.POS_INVOICING_ENABLED = 'true';
  try {
    const { deps, calls } = fakeDeps();
    await confirmPosOrder({ ...baseOrder(), wantsInvoice: true }, 'Caja', ctx, deps);
    const [, invoiced, locale] = named(calls, 'invoice')[0];
    assert.deepEqual(invoiced.odooOrders.map((o) => o.odooOrderId), [9000, 9001]);
    assert.equal(locale.invoiceJournalId, 32);
    const second = fakeDeps();
    await confirmPosOrder(baseOrder(), 'Caja', ctx, second.deps);
    assert.equal(named(second.calls, 'invoice').length, 0);
  } finally {
    delete process.env.POS_INVOICING_ENABLED;
  }
});

test('invoicingEnabledFor: necesita la variable y el diario del local', () => {
  delete process.env.POS_INVOICING_ENABLED;
  assert.equal(invoicingEnabledFor({ invoiceJournalId: 32 }), false);
  process.env.POS_INVOICING_ENABLED = 'true';
  assert.equal(invoicingEnabledFor({ invoiceJournalId: 32 }), true);
  assert.equal(invoicingEnabledFor({ invoiceJournalId: null }), false);
  delete process.env.POS_INVOICING_ENABLED;
});

// ---- Factura única ----

const invoicedOrder = { id: 'o1', odooOrders: [{ group: 'local', odooOrderId: 9000 }, { group: 'rolon', odooOrderId: 9001 }] };

function invoiceDeps(overrides = {}) {
  const calls = [];
  let invoices = [];
  const deps = {
    findOrderInvoices: async (id) => { calls.push(['find', id]); return invoices; },
    createInvoiceForOrders: async (ids) => { calls.push(['create', ids]); invoices = [{ id: 366, state: 'draft' }]; },
    postInvoice: async (id, journalId) => { calls.push(['post', id, journalId]); return { id, name: 'FA-B 00032-00000001' }; },
    markOrderInvoiced: async (id, saved) => { calls.push(['marked', id, saved]); },
    setInvoiceError: async (id, error) => { calls.push(['error', id, error]); },
    ...overrides,
  };
  return { deps, calls };
}

test('invoicePosOrder: una factura para todos los pedidos, en el diario del local vendedor', async () => {
  const { deps, calls } = invoiceDeps();
  const result = await invoicePosOrder(invoicedOrder, DEFAULT_LOCALES[0], deps);
  assert.deepEqual(result, { status: 'invoiced', invoiceId: 366, invoiceName: 'FA-B 00032-00000001' });
  assert.deepEqual(calls.find((c) => c[0] === 'create'), ['create', [9000, 9001]]);
  assert.deepEqual(calls.find((c) => c[0] === 'post'), ['post', 366, 32]);
  assert.deepEqual(calls.find((c) => c[0] === 'marked'), ['marked', 'o1', { invoiceId: 366, invoiceName: 'FA-B 00032-00000001' }]);
});

test('invoicePosOrder: si ya hay una factura validada en cualquiera de los pedidos, no crea otra', async () => {
  const { deps, calls } = invoiceDeps({
    findOrderInvoices: async (id) => { calls.push(['find', id]); return id === 9001 ? [{ id: 300, state: 'posted', name: 'FA-B 1' }] : []; },
  });
  const result = await invoicePosOrder(invoicedOrder, DEFAULT_LOCALES[0], deps);
  assert.equal(result.status, 'invoiced');
  assert.equal(calls.some((c) => c[0] === 'create' || c[0] === 'post'), false);
});

test('invoicePosOrder: un error se guarda en el pedido y no tira', async () => {
  const { deps, calls } = invoiceDeps({ postInvoice: async () => { throw new Error('AFIP caído'); } });
  const result = await invoicePosOrder(invoicedOrder, DEFAULT_LOCALES[0], deps);
  assert.equal(result.status, 'error');
  assert.match(calls.find((c) => c[0] === 'error')[2], /no se pudo facturar: AFIP caído/);
});

test('confirmPosOrder: grupo todo "ahora" manda partner_shipping_id = partnerId', async () => {
  const { deps, calls } = fakeDeps();
  const order = { ...baseOrder(), lines: [baseOrder().lines[0]] };
  await confirmPosOrder(order, 'Caja', ctx, deps);
  assert.equal(named(calls, 'createSaleOrder')[0][1].partner_shipping_id, 500);
  assert.equal(named(calls, 'childPartner').length, 0);
});

test('confirmPosOrder: contacto de retiro existente se reusa, no se crea otro', async () => {
  const looked = [];
  const { deps, calls } = fakeDeps({ findChildPartner: async (vals) => { looked.push(vals); return 777; } });
  await confirmPosOrder(baseOrder(), 'Caja', ctx, deps);
  assert.equal(named(calls, 'childPartner').length, 0);
  assert.equal(named(calls, 'createSaleOrder')[1][1].partner_shipping_id, 777);
  assert.equal(looked[0].type, 'delivery');
});

test('confirmPosOrder: contacto de retiro inexistente se crea', async () => {
  const { deps, calls } = fakeDeps();
  await confirmPosOrder(baseOrder(), 'Caja', ctx, deps);
  assert.equal(named(calls, 'findChild').length, 1);
  assert.equal(named(calls, 'childPartner').length, 1);
  assert.equal(named(calls, 'createSaleOrder')[1][1].partner_shipping_id, 600);
});

// ---- Anulación ----

function annulDeps(order, overrides = {}) {
  const calls = [];
  const deps = {
    getOrder: async () => order,
    hasDeliveredMoves: async (id) => { calls.push(['delivered?', id]); return false; },
    hasDoneTransfers: async (id) => { calls.push(['done?', id]); return false; },
    findOrderInvoices: async () => [],
    readOrderStates: async (ids) => ids.map((id) => ({ id, name: id === 9000 ? 'S1' : 'S2', state: 'sale' })),
    cancelSaleOrder: async (id) => { calls.push(['cancel', id]); },
    markOrderAnnulled: async (id, user, reason) => { calls.push(['annulled', id, user, reason]); return { ...order, status: 'anulado' }; },
    ...overrides,
  };
  return { deps, calls };
}

const confirmedOrder = () => ({
  ...baseOrder(), status: 'confirmado', odooOrderId: 9000,
  odooOrders: [{ group: 'local', odooOrderId: 9000, odooOrderName: 'S1' }, { group: 'rolon', odooOrderId: 9001, odooOrderName: 'S2' }],
});
const cajero = { name: 'Caja', localId: 'LL' };

test('annulPosOrder: revisa y cancela TODOS los pedidos de Odoo antes de anular', async () => {
  const { deps, calls } = annulDeps(confirmedOrder());
  await annulPosOrder('o1', cajero, 'se arrepintió', deps);
  assert.deepEqual(calls.filter((c) => c[0] === 'cancel').map((c) => c[1]), [9000, 9001]);
  assert.deepEqual(calls.at(-1), ['annulled', 'o1', 'Caja', 'se arrepintió']);
});

test('annulPosOrder: si algo de cualquier pedido ya se movió, no cancela nada', async () => {
  const { deps, calls } = annulDeps(confirmedOrder(), { hasDoneTransfers: async (id) => id === 9001 });
  await assert.rejects(annulPosOrder('o1', cajero, '', deps), /ya se entregó/);
  assert.equal(calls.some((c) => c[0] === 'cancel'), false);
});

test('annulPosOrder: con factura o de otro local no se anula', async () => {
  await assert.rejects(annulPosOrder('o1', cajero, '', annulDeps({ ...confirmedOrder(), invoiceName: 'FA-B 1' }).deps), /factura FA-B 1/);
  await assert.rejects(annulPosOrder('o1', { ...cajero, localId: 'BL' }, '', annulDeps(confirmedOrder()).deps), /acceso/);
});

test('annulPosOrder: con una factura validada en Odoo en cualquiera de los pedidos no se anula', async () => {
  const { deps, calls } = annulDeps(confirmedOrder(), {
    findOrderInvoices: async (id) => (id === 9001 ? [{ id: 300, state: 'posted', name: 'FA-B 00032-1' }] : []),
  });
  await assert.rejects(annulPosOrder('o1', cajero, '', deps), /factura FA-B 00032-1 en Odoo/);
  assert.equal(calls.some((c) => c[0] === 'cancel'), false);
});

test('annulPosOrder: si falla a mitad, avisa qué pedidos ya se cancelaron; el reintento salta los cancelados', async () => {
  const { deps } = annulDeps(confirmedOrder(), {
    cancelSaleOrder: async (id) => { if (id === 9001) throw new Error('timeout'); },
  });
  await assert.rejects(annulPosOrder('o1', cajero, '', deps), /ya se cancelaron en Odoo: S1.*timeout.*[Rr]eintentá/);
  const retry = annulDeps(confirmedOrder(), {
    readOrderStates: async (ids) => ids.map((id) => ({ id, name: id === 9000 ? 'S1' : 'S2', state: id === 9000 ? 'cancel' : 'sale' })),
  });
  await annulPosOrder('o1', cajero, '', retry.deps);
  assert.deepEqual(retry.calls.filter((c) => c[0] === 'cancel').map((c) => c[1]), [9001]);
});

test('annulPosOrder: pedido en error con presupuesto en Odoo → cancela (también draft) y anula', async () => {
  const order = { ...confirmedOrder(), status: 'error', odooOrders: [{ group: 'local', odooOrderId: 9000, odooOrderName: null }] };
  const { deps, calls } = annulDeps(order, {
    readOrderStates: async (ids) => ids.map((id) => ({ id, name: 'S1', state: 'draft' })),
  });
  await annulPosOrder('o1', cajero, 'x', deps);
  assert.deepEqual(calls.filter((c) => c[0] === 'cancel').map((c) => c[1]), [9000]);
  assert.deepEqual(calls.at(-1), ['annulled', 'o1', 'Caja', 'x']);
});

test('annulPosOrder: pedido en error con remitos hechos → rechaza sin cancelar', async () => {
  const order = { ...confirmedOrder(), status: 'error' };
  const { deps, calls } = annulDeps(order, { hasDoneTransfers: async (id) => id === 9000 });
  await assert.rejects(annulPosOrder('o1', cajero, '', deps), /ya se entregó/);
  assert.equal(calls.some((c) => c[0] === 'cancel'), false);
});

test('annulPosOrder: otros estados (pendiente) siguen rechazados', async () => {
  await assert.rejects(annulPosOrder('o1', cajero, '', annulDeps({ ...confirmedOrder(), status: 'pendiente' }).deps), /Solo se anulan/);
});

// ---- Fix round 1: pedidos perdidos, estados, pasos posteriores ----

test('confirmPosOrder: si Odoo ya tiene el pedido del grupo (respuesta perdida), lo adopta en vez de crear otro', async () => {
  const { deps, calls } = fakeDeps({
    findSaleOrdersByRef: async (q) => { calls.push(['findByRef', q]); return q.warehouseId === 28 ? [{ id: 9005, name: 'S9005', state: 'draft' }] : []; },
    readOrderLineIds: async (id) => ({ 9000: [71], 9005: [72] })[id],
  });
  await confirmPosOrder(baseOrder(), 'Caja', ctx, deps);
  assert.deepEqual(named(calls, 'createSaleOrder').map((c) => c[1].warehouse_id), [1]);
  assert.deepEqual(named(calls, 'findByRef').map((c) => c[1]), [
    { clientOrderRef: 'LL-0001', warehouseId: 1, teamId: 6 }, { clientOrderRef: 'LL-0001', warehouseId: 28, teamId: 6 },
  ]);
  assert.deepEqual(named(calls, 'saveOdooOrders').at(-1)[2].map((o) => [o.group, o.odooOrderId]), [['local', 9000], ['rolon', 9005]]);
  // El contacto de entrega solo se crea si de verdad se va a crear el pedido.
  assert.equal(named(calls, 'childPartner').length, 0);
});

test('confirmPosOrder: más de un pedido en Odoo para el mismo grupo → error, no crea nada', async () => {
  const { deps, calls } = fakeDeps({
    findSaleOrdersByRef: async () => [{ id: 9005, name: 'S9005' }, { id: 9006, name: 'S9006' }],
  });
  await assert.rejects(confirmPosOrder(baseOrder(), 'Caja', ctx, deps), /S9005, S9006/);
  assert.equal(named(calls, 'createSaleOrder').length, 0);
});

test('confirmPosOrder: solo confirma los pedidos en borrador; uno cancelado en Odoo frena con error', async () => {
  const { deps, calls } = fakeDeps({
    readOrderStates: async (ids) => ids.map((id) => ({ id, name: `S${id}`, state: id === 9000 ? 'sale' : 'draft' })),
  });
  await confirmPosOrder(baseOrder(), 'Caja', ctx, deps);
  assert.deepEqual(named(calls, 'confirmSaleOrder').map((c) => c[1]), [9001]);
  const cancelled = fakeDeps({
    readOrderStates: async (ids) => ids.map((id) => ({ id, name: `S${id}`, state: id === 9001 ? 'cancel' : 'draft' })),
  });
  await assert.rejects(confirmPosOrder(baseOrder(), 'Caja', ctx, cancelled.deps), /El pedido S9001 está cancelado en Odoo/);
  assert.equal(named(cancelled.calls, 'confirmSaleOrder').length, 0);
  assert.equal(named(cancelled.calls, 'markOrderConfirmed').length, 0);
});

test('confirmPosOrder: los pasos posteriores terminan bajando postConfirmPending (aun con avisos)', async () => {
  const { deps, calls } = fakeDeps({ validateTwoStep: async () => { throw new Error('sin stock'); } });
  await confirmPosOrder(baseOrder(), 'Caja', ctx, deps);
  assert.deepEqual(named(calls, 'clearPending').map((c) => c[1]), ['o1']);
  assert.ok(indexOf(calls, 'setOrderWarning') < indexOf(calls, 'clearPending'));
  assert.ok(indexOf(calls, 'markOrderConfirmed') < indexOf(calls, 'clearPending'));
});

test('runPostConfirmSteps: Exhibición sin re-apuntar → no se valida en el acto esa línea, con aviso', async () => {
  const { deps, calls } = fakeDeps({ alignFirstLegMoves: async () => { throw new Error('picking bloqueado'); } });
  const order = {
    ...baseOrder(), status: 'confirmado',
    odooOrders: [{ group: 'local', odooOrderId: 9000, odooOrderName: 'S9000' }],
    lines: [
      { lineId: 'L1', productId: 10, sku: 'A', qty: 1, basePrice: 1210, origin: 'exhibicion', delivery: 'ahora', status: 'activo', odooLineId: 71 },
      { lineId: 'L3', productId: 12, sku: 'C', qty: 2, basePrice: 1210, origin: 'stock', delivery: 'ahora', status: 'activo', odooLineId: 73 },
    ],
  };
  await runPostConfirmSteps(order, 'Caja', ctx, deps);
  assert.deepEqual(named(calls, 'validateTwoStep')[0].slice(1), [9000, [{ odooLineId: 73, qty: 2, locationId: 8 }]]);
  assert.deepEqual(named(calls, 'markLinesDelivered')[0][2], ['L3']);
  const warning = named(calls, 'setOrderWarning')[0][2];
  assert.match(warning, /picking bloqueado/);
  assert.match(warning, /A no se validó en el acto/);
});

const confirmedForClaim = (extra) => ({
  ...baseOrder(), status: 'confirmado', odooOrderId: 9000,
  odooOrders: [{ group: 'local', odooOrderId: 9000, odooOrderName: 'S9000' }, { group: 'rolon', odooOrderId: 9001, odooOrderName: 'S9001' }],
  lines: baseOrder().lines.map((l, i) => ({ ...l, odooLineId: 71 + i })), ...extra,
});

test('claimAndConfirmPos: ya confirmado con pasos pendientes → los vuelve a correr', async () => {
  const { deps, calls } = fakeDeps({
    claimOrderForConfirm: async () => ({ order: confirmedForClaim({ postConfirmPending: true }), alreadyConfirmed: true }),
    loadCtx: async () => ctx,
  });
  await claimAndConfirmPos('o1', { name: 'Caja', localId: 'LL' }, deps);
  assert.deepEqual(named(calls, 'validateTwoStep')[0].slice(1), [9000, [{ odooLineId: 71, qty: 1, locationId: 8 }]]);
  assert.equal(named(calls, 'clearPending').length, 1);
  assert.equal(named(calls, 'createSaleOrder').length, 0);
  assert.equal(named(calls, 'markOrderConfirmed').length, 0);
});

test('claimAndConfirmPos: ya confirmado sin pendientes → no hace nada más', async () => {
  const order = confirmedForClaim({ postConfirmPending: false });
  const { deps, calls } = fakeDeps({
    claimOrderForConfirm: async () => ({ order, alreadyConfirmed: true }),
    loadCtx: async () => ctx,
  });
  assert.equal(await claimAndConfirmPos('o1', { name: 'Caja', localId: 'LL' }, deps), order);
  assert.equal(calls.length, 0);
});

test('annulPosOrder: error + en Odoo pero confirmándose en este momento → rechaza sin cancelar', async () => {
  const order = { ...confirmedOrder(), status: 'error', confirmingSince: new Date() };
  const { deps, calls } = annulDeps(order);
  await assert.rejects(annulPosOrder('o1', cajero, '', deps), /confirmando/);
  assert.equal(calls.some((c) => c[0] === 'cancel'), false);
});
