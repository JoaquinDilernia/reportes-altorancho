// Vender stock web desde el local: la línea tiene origen "web", al confirmar
// se traslada EC/Stock → RL/Stock y después sale de Rolón como cualquier otra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLine, webTransferItems, pickWebLots } from '../posLines.mjs';
import { splitByOrigin, planOdooOrders } from '../posOdoo.mjs';
import { orderGroups } from '../posOrders.mjs';
import { originLocationId, shipLocationId, DEFAULT_LOCALES, DEFAULT_SETTINGS, DEFAULT_PAYMENT_METHODS, ORIGINS } from '../posConfig.mjs';
import { confirmPosOrder } from '../posConfirm.mjs';

const vctx = { localId: 'LL', localeIds: ['LL', 'BL', 'AL'] };
const line = (over = {}) => ({ lineId: 'L1', productId: 10, sku: 'QUE001', qty: 1, origin: 'web', delivery: 'envio', pickupLocalId: null, status: 'activo', ...over });
const lomas = DEFAULT_LOCALES[0];

test('web es un origen válido con las mismas entregas que Rolón', () => {
  assert.ok(ORIGINS.includes('web'));
  for (const delivery of ['retira_local', 'envio', 'retira_rolon']) assert.deepEqual(validateLine(line({ delivery }), vctx), []);
  assert.deepEqual(validateLine(line({ delivery: 'retira_otro_local', pickupLocalId: 'AL' }), vctx), []);
  assert.deepEqual(validateLine(line({ delivery: 'ahora' }), vctx), ['QUE001: "Se lo lleva ahora" solo sale del local (Stock o Exhibición)']);
});

test('web reserva en EC/Stock pero sale de RL/Stock', () => {
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'web'), 150);
  assert.equal(shipLocationId(lomas, DEFAULT_SETTINGS, 'web'), 174);
  assert.equal(shipLocationId(lomas, DEFAULT_SETTINGS, 'stock'), 8);
});

test('las líneas web van en el grupo de Rolón', () => {
  const lines = [line({ lineId: 'L1', origin: 'stock', delivery: 'ahora' }), line({ lineId: 'L2', origin: 'rolon' }), line({ lineId: 'L3' })];
  assert.deepEqual(splitByOrigin(lines).rolon.map((l) => l.lineId), ['L2', 'L3']);
  assert.deepEqual(orderGroups(lines).rolon.map((l) => l.lineId), ['L2', 'L3']);
  const plan = planOdooOrders({ lines, totals: { lineDiscountPct: 0, shipping: 0 }, locale: lomas, settings: DEFAULT_SETTINGS, shippingProductId: null });
  assert.deepEqual(plan.map((g) => [g.group, g.lines.length]), [['local', 1], ['rolon', 2]]);
});

test('webTransferItems suma por producto solo las líneas web activas', () => {
  const lines = [line({ qty: 2 }), line({ lineId: 'L2', qty: 1 }), line({ lineId: 'L3', productId: 11, qty: 3 }),
    line({ lineId: 'L4', productId: 12, status: 'eliminado' }), line({ lineId: 'L5', productId: 13, origin: 'rolon' })];
  assert.deepEqual(webTransferItems(lines), [{ productId: 10, qty: 3 }, { productId: 11, qty: 3 }]);
});

test('pickWebLots: lotes con stock de cada producto, de mayor a menor', () => {
  const quants = [
    { product_id: [10, 'A'], lot_id: [1, 'L1'], quantity: 2 },
    { product_id: [10, 'A'], lot_id: [2, 'L2'], quantity: 5 },
    { product_id: [11, 'B'], lot_id: false, quantity: 9 },
  ];
  assert.deepEqual([...pickWebLots(quants)], [[10, [{ lotId: 2, qty: 5 }, { lotId: 1, qty: 2 }]]]);
});

// ---- Confirmación ----
const ctx = { locale: lomas, locales: DEFAULT_LOCALES, settings: DEFAULT_SETTINGS, methodsById: new Map(DEFAULT_PAYMENT_METHODS.map((m) => [m.id, m])) };
const order = (over = {}) => ({
  id: 'o1', number: 'LL-0009', localId: 'LL', status: 'pendiente', wantsInvoice: false, odooOrders: [], odooOrderId: null,
  customer: { docNumber: '30123456', name: 'Ana', phone: '1155556666', email: 'a@b.com' },
  payments: [{ methodId: 'efectivo', detailId: null, amount: null }], totals: { lineDiscountPct: 15, shipping: 0, total: 1028.5 },
  shipping: null, lines: [line({ delivery: 'retira_rolon', basePrice: 1210 })], ...over,
});

function fakeDeps(overrides = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push([name, ...structuredClone(args)]);
    return typeof result === 'function' ? result(...args) : result;
  };
  const deps = {
    findOrCreatePosPartner: rec('partner', 500), findPaymentMethodId: rec('paymentMethod', 5), findProductIdBySku: rec('productBySku', 1),
    createChildPartner: rec('childPartner', 600), findChildPartner: rec('findChild', null),
    createSaleOrder: rec('createSaleOrder', 9001), saveOdooOrders: rec('saveOdooOrders'),
    readOrderLineIds: rec('readOrderLineIds', [72]), saveOdooLineIds: rec('saveOdooLineIds'), confirmSaleOrder: rec('confirmSaleOrder'),
    findSaleOrdersByRef: rec('findByRef', []), readOrderStates: rec('orderStates', (ids) => ids.map((id) => ({ id, name: `S${id}`, state: 'draft' }))),
    clearPostConfirmPending: rec('clearPending'), markOrderConfirmed: rec('markOrderConfirmed'), getOrder: rec('getOrder', { id: 'o1', status: 'confirmado' }),
    alignFirstLegMoves: rec('align', []), validateTwoStep: rec('validateTwoStep', {}), markLinesDelivered: rec('delivered'),
    setOrderWarning: rec('warning'), invoice: rec('invoice', { status: 'skipped' }),
    findPickingByOrigin: rec('findPicking', null),
    createInternalTransfer: rec('transfer', { id: 800, name: 'EC/INT/00001', state: 'assigned' }),
    webLotsFor: rec('webLots', new Map([[10, [{ lotId: 2, qty: 5 }]]])),
    validatePicking: rec('validate', (id) => ({ id, name: 'EC/INT/00001', state: 'done' })),
    markVirtualTransfer: rec('reason'),
    saveWebTransfer: rec('saveWebTransfer'),
    ...overrides,
  };
  return { deps, calls };
}
const named = (calls, name) => calls.filter((c) => c[0] === name);
const at = (calls, name) => calls.findIndex((c) => c[0] === name);

test('confirmar con stock web: traslado EC → RL validado antes de crear la venta de Rolón', async () => {
  const { deps, calls } = fakeDeps();
  await confirmPosOrder(order(), 'Caja', ctx, deps);
  assert.deepEqual(named(calls, 'transfer')[0][1], {
    pickingTypeId: 166, fromLocationId: 150, toLocationId: 174, items: [{ productId: 10, qty: 1 }], origin: 'LL-0009 web a Rolón',
  });
  assert.deepEqual(named(calls, 'reason')[0].slice(1), [800, 'reasignacion_venta']);
  assert.ok(at(calls, 'reason') < at(calls, 'validate'));
  assert.deepEqual(named(calls, 'webLots')[0].slice(1), [[10], 150]);
  const [, pickingId, lots] = named(calls, 'validate')[0];
  assert.equal(pickingId, 800);
  assert.deepEqual([...lots], [[10, [{ lotId: 2, qty: 5 }]]]);
  assert.deepEqual(named(calls, 'saveWebTransfer')[0].slice(1), ['o1', { id: 800, name: 'EC/INT/00001', state: 'done' }]);
  assert.ok(at(calls, 'saveWebTransfer') < at(calls, 'createSaleOrder'));
  assert.equal(named(calls, 'createSaleOrder')[0][1].warehouse_id, 28);
});

test('si el traslado no queda validado no se crea ninguna venta', async () => {
  const { deps, calls } = fakeDeps({ validatePicking: async (id) => ({ id, name: 'EC/INT/00001', state: 'assigned' }) });
  await assert.rejects(confirmPosOrder(order(), 'Caja', ctx, deps), /EC\/INT\/00001.*no quedó validado/);
  assert.equal(named(calls, 'createSaleOrder').length, 0);
  assert.equal(named(calls, 'saveWebTransfer').length, 0);
});

test('reintento: reusa el traslado ya hecho (guardado o encontrado en Odoo)', async () => {
  let { deps, calls } = fakeDeps();
  await confirmPosOrder(order({ webTransfer: { id: 800, name: 'EC/INT/00001', state: 'done' } }), 'Caja', ctx, deps);
  assert.equal(named(calls, 'findPicking').length + named(calls, 'transfer').length + named(calls, 'validate').length, 0);

  ({ deps, calls } = fakeDeps({ findPickingByOrigin: async () => ({ id: 800, name: 'EC/INT/00001', state: 'done' }) }));
  await confirmPosOrder(order(), 'Caja', ctx, deps);
  assert.equal(named(calls, 'transfer').length + named(calls, 'validate').length, 0);
  assert.deepEqual(named(calls, 'saveWebTransfer')[0].slice(1), ['o1', { id: 800, name: 'EC/INT/00001', state: 'done' }]);

  ({ deps, calls } = fakeDeps({ findPickingByOrigin: async () => ({ id: 800, name: 'EC/INT/00001', state: 'assigned' }) }));
  await confirmPosOrder(order(), 'Caja', ctx, deps);
  assert.equal(named(calls, 'transfer').length, 0);
  assert.deepEqual(named(calls, 'reason')[0].slice(1), [800, 'reasignacion_venta']);
  assert.equal(named(calls, 'validate')[0][1], 800);
});

test('sin líneas web no hay traslado', async () => {
  const { deps, calls } = fakeDeps();
  await confirmPosOrder(order({ lines: [line({ origin: 'rolon', delivery: 'retira_rolon', basePrice: 1210 })] }), 'Caja', ctx, deps);
  assert.equal(named(calls, 'findPicking').length + named(calls, 'transfer').length, 0);
});

test('groupStock: el stock web descuenta lo reservado en la app', async () => {
  const { groupStock } = await import('../posCatalog.mjs');
  const view = groupStock({ freeByLoc: new Map([[150, 5]]), appReserved: new Map([[150, 2]]), locales: DEFAULT_LOCALES, settings: DEFAULT_SETTINGS, localId: 'LL' });
  assert.deepEqual(view.web, { qty: 3, unlimited: false });
});
