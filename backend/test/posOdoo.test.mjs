import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPartnerVals, partnerUpdate, buildOdooOrderLines, splitByOrigin, pickupLabelFor,
  planOdooOrders, shippingPartnerKindFor, firstLegMoves, alignFirstLegMoves, findSaleOrdersByRef, readOrderStates,
} from '../posOdoo.mjs';
import { DEFAULT_LOCALES, DEFAULT_SETTINGS } from '../posConfig.mjs';

const ids = {
  dni: 5, cuit: 4, state: null, country: null,
  responsibility: { responsable_inscripto: 1, consumidor_final: 5, monotributo: 6, exento: 4 },
};
const customer = {
  docNumber: '30712345671', name: 'Muebles SA', phone: '1155556666', email: 'compras@muebles.com',
  street: 'Av. Siempreviva 742', city: 'CABA', zip: '1428', afipResponsibility: 'responsable_inscripto', fromArca: true,
};

test('buildPartnerVals: CUIT con datos de ARCA queda listo para Factura A', () => {
  const vals = buildPartnerVals(customer, ids);
  assert.equal(vals.vat, '30712345671');
  assert.equal(vals.l10n_latam_identification_type_id, 4);
  assert.equal(vals.l10n_ar_afip_responsibility_type_id, 1);
  assert.equal(vals.street, 'Av. Siempreviva 742');
});

test('buildPartnerVals: DNI → consumidor final', () => {
  const vals = buildPartnerVals({ ...customer, docNumber: '30123456', afipResponsibility: null, fromArca: false }, ids);
  assert.equal(vals.l10n_latam_identification_type_id, 5);
  assert.equal(vals.l10n_ar_afip_responsibility_type_id, 5);
});

test('partnerUpdate: ARCA pisa razón social, domicilio y condición; email cambia si es distinto; teléfono solo si faltaba', () => {
  const existing = { name: 'MUEBLES', email: 'viejo@x.com', phone: '111', street: '', l10n_ar_afip_responsibility_type_id: [5, 'CF'] };
  const update = partnerUpdate(existing, customer, ids);
  assert.equal(update.name, 'Muebles SA');
  assert.equal(update.email, 'compras@muebles.com');
  assert.equal(update.l10n_ar_afip_responsibility_type_id, 1);
  assert.equal(update.phone, undefined);
  assert.equal(partnerUpdate({ ...existing, name: 'Muebles SA', email: 'compras@muebles.com', street: 'Av. Siempreviva 742', city: 'CABA', zip: '1428', l10n_ar_afip_responsibility_type_id: [1, 'RI'] }, customer, ids), null);
});

test('buildOdooOrderLines: redondea descuento y precio a 2 decimales (ruido de coma flotante)', () => {
  const lines = [{ productId: 1, qty: 1, basePrice: 1210, status: 'activo' }];
  const [l] = buildOdooOrderLines(lines, { lineDiscountPct: 15.000000000000004, shipping: 0 }, null);
  assert.equal(l.discountPct, 15);
  assert.equal(l.unitPrice, 1000);
});

test('buildOdooOrderLines: precio sin IVA + % de la cascada; envío sin descuento', () => {
  const lines = [
    { productId: 10, qty: 2, basePrice: 12100, status: 'activo' },
    { productId: 11, qty: 1, basePrice: 999, status: 'eliminado' },
  ];
  const result = buildOdooOrderLines(lines, { lineDiscountPct: 23.5, shipping: 6050 }, 45870);
  assert.deepEqual(result, [
    { productId: 10, qty: 2, unitPrice: 10000, discountPct: 23.5 },
    { productId: 45870, qty: 1, unitPrice: 5000, discountPct: 0 },
  ]);
});

test('splitByOrigin y pickupLabelFor', () => {
  const lines = [
    { lineId: 'L1', origin: 'stock', delivery: 'ahora', status: 'activo' },
    { lineId: 'L2', origin: 'rolon', delivery: 'retira_otro_local', pickupLocalId: 'AL', status: 'activo' },
    { lineId: 'L3', origin: 'rolon', delivery: 'envio', status: 'eliminado' },
  ];
  const { local, rolon } = splitByOrigin(lines);
  assert.deepEqual(local.map((l) => l.lineId), ['L1']);
  assert.deepEqual(rolon.map((l) => l.lineId), ['L2']);
  const lomas = DEFAULT_LOCALES[0];
  assert.equal(pickupLabelFor(lines[1], lomas, DEFAULT_LOCALES), 'Retira en Local Alcorta');
  assert.equal(pickupLabelFor({ delivery: 'retira_local' }, lomas, DEFAULT_LOCALES), 'Retira en Local Las Lomas');
  assert.equal(pickupLabelFor({ delivery: 'retira_rolon' }, lomas, DEFAULT_LOCALES), 'Retira en Rolón');
  assert.equal(pickupLabelFor({ delivery: 'ahora' }, lomas, DEFAULT_LOCALES), null);
});

// ---- planOdooOrders: un pedido de Odoo por depósito de origen ----

const lomas = DEFAULT_LOCALES[0];
const line = (lineId, origin, delivery, extra = {}) => ({
  lineId, productId: Number(lineId.slice(1)) + 100, qty: 1, basePrice: 1210, origin, delivery, status: 'activo', ...extra,
});
const totals = (shipping = 0) => ({ lineDiscountPct: 15, shipping });

test('planOdooOrders: solo local → un grupo con el depósito del local', () => {
  const plan = planOdooOrders({
    lines: [line('L1', 'stock', 'ahora'), line('L2', 'exhibicion', 'retira_local')],
    totals: totals(), locale: lomas, settings: DEFAULT_SETTINGS, shippingProductId: null,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].group, 'local');
  assert.equal(plan[0].warehouseId, 1);
  assert.deepEqual(plan[0].lines.map((l) => l.lineId), ['L1', 'L2']);
  assert.deepEqual(plan[0].odooLines, [
    { productId: 101, qty: 1, unitPrice: 1000, discountPct: 15 },
    { productId: 102, qty: 1, unitPrice: 1000, discountPct: 15 },
  ]);
});

test('planOdooOrders: solo Rolón → un grupo con el depósito de Rolón', () => {
  const plan = planOdooOrders({
    lines: [line('L1', 'rolon', 'retira_rolon')], totals: totals(), locale: lomas, settings: DEFAULT_SETTINGS, shippingProductId: null,
  });
  assert.deepEqual(plan.map((g) => [g.group, g.warehouseId]), [['rolon', 28]]);
});

test('planOdooOrders: mixto con envío en una línea de Rolón → local primero, el envío va al grupo de Rolón', () => {
  const plan = planOdooOrders({
    lines: [line('L1', 'stock', 'ahora'), line('L2', 'rolon', 'envio'), line('L3', 'stock', 'retira_local', { status: 'eliminado' })],
    totals: totals(6050), locale: lomas, settings: DEFAULT_SETTINGS, shippingProductId: 45870,
  });
  assert.deepEqual(plan.map((g) => [g.group, g.warehouseId]), [['local', 1], ['rolon', 28]]);
  assert.deepEqual(plan[0].lines.map((l) => l.lineId), ['L1']);
  assert.equal(plan[0].odooLines.length, 1);
  assert.deepEqual(plan[1].odooLines, [
    { productId: 102, qty: 1, unitPrice: 1000, discountPct: 15 },
    { productId: 45870, qty: 1, unitPrice: 5000, discountPct: 0 },
  ]);
});

test('planOdooOrders: envío en una línea del local → el costo va al grupo local', () => {
  const plan = planOdooOrders({
    lines: [line('L1', 'stock', 'envio'), line('L2', 'rolon', 'retira_rolon')],
    totals: totals(1210), locale: lomas, settings: DEFAULT_SETTINGS, shippingProductId: 45870,
  });
  assert.equal(plan[0].odooLines.at(-1).productId, 45870);
  assert.equal(plan[1].odooLines.some((l) => l.productId === 45870), false);
});

test('planOdooOrders: sin línea de envío pero con costo → al primer grupo; sin producto de envío no se agrega', () => {
  const lines = [line('L1', 'rolon', 'retira_rolon')];
  const withId = planOdooOrders({ lines, totals: totals(1210), locale: lomas, settings: DEFAULT_SETTINGS, shippingProductId: 45870 });
  assert.equal(withId[0].odooLines.at(-1).productId, 45870);
  const without = planOdooOrders({ lines, totals: totals(1210), locale: lomas, settings: DEFAULT_SETTINGS, shippingProductId: null });
  assert.equal(without[0].odooLines.length, 1);
});

test('shippingPartnerKindFor: envío > retiro > nada', () => {
  assert.equal(shippingPartnerKindFor([line('L1', 'stock', 'ahora'), line('L2', 'rolon', 'envio')]), 'envio');
  assert.equal(shippingPartnerKindFor([line('L1', 'stock', 'ahora'), line('L2', 'stock', 'retira_local')]), 'pickup');
  assert.equal(shippingPartnerKindFor([line('L1', 'rolon', 'retira_otro_local', { pickupLocalId: 'AL' })]), 'pickup');
  assert.equal(shippingPartnerKindFor([line('L1', 'stock', 'ahora')]), null);
});

// ---- Primer tramo (PICK) en 2 pasos ----
// En este Odoo 16 el move del PICK NO tiene sale_line_id: solo el del OUT lo
// tiene, y apunta al PICK por move_orig_ids (verificado en solo lectura).

const outMove = (id, saleLineId, origIds, extra = {}) => ({
  id, sale_line_id: [saleLineId, 'x'], move_orig_ids: origIds, picking_id: [900, 'LL/OUT'], state: 'waiting', ...extra,
});
const pickMove = (id, extra = {}) => ({
  id, sale_line_id: false, move_orig_ids: [], picking_id: [800, 'LL/PICK'], location_id: [8, 'LL/Stock'], state: 'assigned', ...extra,
});

test('firstLegMoves: los moves del PICK heredan el sale_line_id del OUT; en 1 paso el move de la línea es el primer tramo', () => {
  const lineMoves = [outMove(11, 71, [21]), outMove(12, 72, [22, 23]), { ...outMove(13, 73, []), location_id: [8, 'LL/Stock'] }, outMove(14, 74, [24], { state: 'cancel' })];
  const origMoves = [pickMove(21), pickMove(22, { state: 'done' }), pickMove(23), pickMove(24)];
  const result = firstLegMoves(lineMoves, origMoves);
  assert.deepEqual(result.map((m) => [m.id, m.sale_line_id[0]]), [[21, 71], [22, 72], [23, 72], [13, 73]]);
});

function fakeOdoo(responses) {
  const calls = [];
  const odoo = {
    read: async (model, method, args, kwargs) => {
      calls.push(['read', model, method, args, kwargs]);
      return responses(model, method, args) ?? [];
    },
    write: async (model, method, args, kwargs) => {
      calls.push(['write', model, method, args, kwargs]);
      return true;
    },
  };
  return { odoo, calls };
}

test('alignFirstLegMoves: re-apunta solo el move del PICK de la línea de Exhibición', async () => {
  const { odoo, calls } = fakeOdoo((model, method, args) => {
    if (model === 'stock.move' && method === 'search_read' && args[0][0][0] === 'sale_line_id') {
      return [outMove(11, 71, [21]), outMove(12, 72, [22])];
    }
    if (model === 'stock.move' && method === 'read') return [pickMove(21), pickMove(22, { location_id: [324, 'LL/Exhibicion'] })];
    return [];
  });
  const plan = await alignFirstLegMoves([{ odooLineId: 71, locationId: 324 }, { odooLineId: 72, locationId: 324 }], odoo);
  assert.deepEqual(plan, [{ moveId: 21, pickingId: 800, locationId: 324 }]);
  const writes = calls.filter((c) => c[0] === 'write').map((c) => [c[1], c[2], c[3]]);
  assert.deepEqual(writes, [
    ['stock.picking', 'do_unreserve', [[800]]],
    ['stock.move', 'write', [[21], { location_id: 324 }]],
    ['stock.picking', 'action_assign', [[800]]],
  ]);
});

test('alignFirstLegMoves: sin ítems no llama a Odoo', async () => {
  const { odoo, calls } = fakeOdoo(() => []);
  assert.deepEqual(await alignFirstLegMoves([], odoo), []);
  assert.equal(calls.length, 0);
});

test('findSaleOrdersByRef: busca por referencia, depósito y equipo, sin los cancelados', async () => {
  const { odoo, calls } = fakeOdoo(() => [{ id: 9000, name: 'S1', state: 'draft' }]);
  const found = await findSaleOrdersByRef({ clientOrderRef: 'LL-0001', warehouseId: 28, teamId: 6 }, odoo);
  assert.deepEqual(found, [{ id: 9000, name: 'S1', state: 'draft' }]);
  assert.deepEqual(calls[0].slice(1, 4), ['sale.order', 'search_read', [[
    ['client_order_ref', '=', 'LL-0001'], ['warehouse_id', '=', 28], ['team_id', '=', 6], ['state', '!=', 'cancel'],
  ]]]);
});

test('readOrderStates: lee nombre y estado de los pedidos', async () => {
  const { odoo, calls } = fakeOdoo(() => [{ id: 9000, name: 'S1', state: 'sale' }]);
  assert.deepEqual(await readOrderStates([9000], odoo), [{ id: 9000, name: 'S1', state: 'sale' }]);
  assert.deepEqual(calls[0].slice(1, 4), ['sale.order', 'read', [[9000]]]);
});

test('planOdooOrders: la subida al domicilio va justo después del envío, mismo grupo, sin IVA y sin descuento', () => {
  const plan = planOdooOrders({
    lines: [line('L1', 'stock', 'ahora'), line('L2', 'rolon', 'envio')],
    totals: { ...totals(6050), homeService: 6050 }, locale: lomas, settings: DEFAULT_SETTINGS,
    shippingProductId: 45870, homeServiceProductId: 57070,
  });
  assert.deepEqual(plan[1].odooLines.slice(-2), [
    { productId: 45870, qty: 1, unitPrice: 5000, discountPct: 0 },
    { productId: 57070, qty: 1, unitPrice: 5000, discountPct: 0 },
  ]);
  assert.equal(plan[0].odooLines.length, 1);
  const none = planOdooOrders({
    lines: [line('L2', 'rolon', 'envio')], totals: totals(6050), locale: lomas, settings: DEFAULT_SETTINGS,
    shippingProductId: 45870, homeServiceProductId: 57070,
  });
  assert.equal(none[0].odooLines.some((l) => l.productId === 57070), false);
});
