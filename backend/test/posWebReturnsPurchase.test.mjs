import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWebPurchase, resolveReturnLine, odooDateToISO } from '../posWebReturnsPurchase.mjs';
import { findOrderByNumber } from '../tiendanube.mjs';

const settings = { webReturns: { warehouseId: 24 } };
const tnOrder = { id: 1234567890, number: '123456', createdAt: '2026-11-20T10:00:00-0300', customer: { name: 'Ana' }, shippingAddress: 'x' };
const line = (over = {}) => ({ purchaseLineId: 10, productId: 5, sku: 'S1', name: 'Zapa', qtyBought: 2, qtyReturnedBefore: 0, unitValue: 100, lots: ['L1'], moveIds: [7], purchaseDate: '2026-11-20 13:07:30', ...over });
const mkDeps = (over = {}) => ({
  findOrderByNumber: async () => tnOrder,
  findSaleOrder: async () => ({ id: 77, name: 'TN1234567890', warehouse_id: [24, 'EC'] }),
  getPurchase: async () => ({ source: 'web', purchaseId: 77, date: '2026-11-20 13:07:30', lines: [line()] }),
  readReturnMoves: async () => [],
  activeRequests: async () => [],
  settings,
  ...over,
});

test('número inexistente en Tienda Nube', async () => {
  await assert.rejects(resolveWebPurchase('99999', mkDeps({ findOrderByNumber: async () => null })), /No encontramos el pedido #99999 en Tienda Nube/);
});

test('sin pedido en Odoo', async () => {
  await assert.rejects(resolveWebPurchase('#123456', mkDeps({ findSaleOrder: async () => null })), /El pedido #123456 todavía no está en Odoo/);
});

test('busca el sale.order por TN + id interno y limpia # y espacios', async () => {
  let name, num;
  const r = await resolveWebPurchase(' #123456 ', mkDeps({
    findOrderByNumber: async (n) => { num = n; return tnOrder; },
    findSaleOrder: async (n) => { name = n; return { id: 77, name: n, warehouse_id: [24, 'EC'] }; },
  }));
  assert.equal(num, '123456');
  assert.equal(name, 'TN1234567890');
  assert.equal(r.purchase.ref, '123456');
  assert.equal(r.purchase.tnOrderId, 1234567890);
  assert.equal(r.purchase.date, '2026-11-20T13:07:30.000Z');
  assert.equal(r.returnable[0].purchaseDate, '2026-11-20T13:07:30.000Z');
  assert.equal(r.returnable[0].available, 2);
  assert.equal(r.tn, tnOrder);
});

test('depósito distinto de E Commerce', async () => {
  await assert.rejects(resolveWebPurchase('123456', mkDeps({ findSaleOrder: async () => ({ id: 77, warehouse_id: [3, 'BL'] }) })), /no salió del depósito E Commerce/);
});

test('línea totalmente devuelta queda afuera; si no queda ninguna tira', async () => {
  const lines = [line({ purchaseLineId: 1, qtyBought: 2, qtyReturnedBefore: 2 }), line({ purchaseLineId: 2, qtyBought: 3, qtyReturnedBefore: 1 })];
  const r = await resolveWebPurchase('123456', mkDeps({ getPurchase: async () => ({ date: '2026-11-20T10:00:00.000Z', lines }) }));
  assert.deepEqual(r.returnable.map((l) => [l.purchaseLineId, l.available]), [[2, 2]]);
  await assert.rejects(resolveWebPurchase('123456', mkDeps({ getPurchase: async () => ({ date: 'x', lines: [lines[0]] }) })), /Ese pedido ya no tiene productos para devolver/);
});

test('odooDateToISO', () => {
  assert.equal(odooDateToISO('2026-11-20 13:07:30'), '2026-11-20T13:07:30.000Z');
  assert.equal(odooDateToISO('2026-11-20T13:07:30.000Z'), '2026-11-20T13:07:30.000Z');
  assert.equal(odooDateToISO(null), null);
});

test('resolveReturnLine', () => {
  const purchase = { lines: [line({ qtyBought: 2, qtyReturnedBefore: 1 })] };
  assert.throws(() => resolveReturnLine(purchase, { purchaseLineId: 10, qty: 3 }), /Solo se puede devolver 1/);
  assert.throws(() => resolveReturnLine(purchase, { purchaseLineId: 99, qty: 1 }), /Esa línea no está en la compra/);
  assert.throws(() => resolveReturnLine(purchase, { purchaseLineId: 10, qty: 0 }), /Cantidad inválida/);
  assert.throws(() => resolveReturnLine(purchase, { purchaseLineId: 10, qty: 1.5 }), /Cantidad inválida/);
  assert.deepEqual(resolveReturnLine(purchase, { purchaseLineId: '10', qty: 1 }),
    { purchaseLineId: 10, productId: 5, sku: 'S1', name: 'Zapa', qty: 1, unitValue: 100, moveIds: [7], lots: ['L1'] });
});

test('findOrderByNumber: match exacto, mapeo y 404 como null', async () => {
  const urls = [];
  const orders = [
    { id: 1, number: 1234567, contact_name: 'X' },
    { id: 2, number: 123456, contact_name: 'Ana', contact_email: 'a@x.com', contact_phone: '11', contact_identification: '30',
      created_at: '2026-11-20T10:00:00-0300', customer: { name: 'Otro' },
      shipping_address: { address: 'Calle', number: '12', floor: '', locality: 'Loc', city: 'CABA', province: 'BA', zipcode: '1000' } },
  ];
  const req = async (u) => { urls.push(u); return { data: orders }; };
  const o = await findOrderByNumber('123456', req);
  assert.match(urls[0], /orders\?q=123456&per_page=50&fields=/);
  assert.deepEqual(o, { id: 2, number: '123456', createdAt: '2026-11-20T10:00:00-0300',
    customer: { name: 'Ana', email: 'a@x.com', phone: '11', identification: '30' },
    shippingAddress: 'Calle 12, Loc, CABA, BA (1000)' });
  assert.equal(await findOrderByNumber('55555', async () => ({ data: orders })), null);
  assert.equal(await findOrderByNumber('55555', async () => { throw new Error('Tiendanube API error 404: Last page is 0'); }), null);
  await assert.rejects(findOrderByNumber('55555', async () => { throw new Error('Tiendanube API error 500: x'); }), /500/);
  await assert.rejects(findOrderByNumber('12a', req), /Número de pedido inválido/);
});

// ---- Lo que ya está tomado por otras devoluciones (no devolver dos veces la misma unidad) ----
const retMove = (o = {}) => ({ origMoveId: 7, pickingId: 900, origin: 'Devolución POS-000045', done: false, qty: 1, qtyDone: 0, ...o });
const active = (o = {}) => ({
  id: 'otra', number: 'CW-000050', status: 'pendiente_aprobacion', purchase: { purchaseId: '77' },
  returnLines: [{ purchaseLineId: '10', qty: 1 }], odoo: { steps: {} }, ...o,
});

test('devolución abierta del local sobre la línea: ya ocupa la unidad', async () => {
  let asked;
  const r = await resolveWebPurchase('123456', mkDeps({ readReturnMoves: async (ids) => { asked = ids; return [retMove()]; } }));
  assert.deepEqual(asked, [7]);
  assert.equal(r.returnable[0].available, 1);
  assert.throws(() => resolveReturnLine(r.purchase, { purchaseLineId: 10, qty: 2 }), /Solo se puede devolver 1/);
  assert.equal(resolveReturnLine(r.purchase, { purchaseLineId: 10, qty: 1 }).qty, 1);
  await assert.rejects(resolveWebPurchase('123456', mkDeps({ readReturnMoves: async () => [retMove({ qty: 2 })] })), /ya no tiene productos para devolver/);
});

test('otra solicitud web pendiente o aprobada sobre la línea: ya ocupa la unidad; otro pedido u otra línea no', async () => {
  const r = await resolveWebPurchase('123456', mkDeps({ activeRequests: async () => [
    active(),
    active({ id: 'x2', purchase: { purchaseId: '78' }, returnLines: [{ purchaseLineId: '10', qty: 1 }] }),
    active({ id: 'x3', returnLines: [{ purchaseLineId: '11', qty: 1 }] }),
  ] }));
  assert.equal(r.returnable[0].available, 1);
  assert.throws(() => resolveReturnLine(r.purchase, { purchaseLineId: 10, qty: 2 }), /Solo se puede devolver 1/);
  await assert.rejects(resolveWebPurchase('123456', mkDeps({ activeRequests: async () => [active({ status: 'aprobada', returnLines: [{ purchaseLineId: 10, qty: 2 }] })] })), /ya no tiene productos para devolver/);
});

test('editando una solicitud: no cuenta contra sí misma (ni sus líneas ni sus devoluciones)', async () => {
  const self = active({ id: 'yo', number: 'CW-000060', returnLines: [{ purchaseLineId: '10', qty: 2 }], odoo: { steps: { pickings: { 'pick:1:fallas': { id: 901 } } } } });
  const deps = mkDeps({
    activeRequests: async () => [self],
    readReturnMoves: async () => [retMove({ pickingId: 901, origin: 'Retorno de EC/OUT/1' }), retMove({ pickingId: 902, origin: 'CW-000060 · pick:1:fallas' })],
  });
  const r = await resolveWebPurchase('123456', deps, { excludeRequestId: 'yo' });
  assert.equal(r.returnable[0].available, 2);
  await assert.rejects(resolveWebPurchase('123456', deps), /ya no tiene productos para devolver/, 'sin excluirla sí cuenta');
});

test('la devolución de otra solicitud activa no se cuenta dos veces (abierta ni validada)', async () => {
  const r = await resolveWebPurchase('123456', mkDeps({
    getPurchase: async () => ({ date: 'x', lines: [line({ qtyBought: 3, qtyReturnedBefore: 1 })] }),
    activeRequests: async () => [
      active({ status: 'aprobada', number: 'CW-000050' }),
      active({ id: 'o2', status: 'aprobada', number: 'CW-000051', odoo: { steps: { pickings: { k: { id: 950 } } } } }),
    ],
    readReturnMoves: async () => [
      retMove({ pickingId: 940, origin: 'CW-000050 · pick:1:fallas' }),
      retMove({ pickingId: 950, origin: 'Retorno de EC/OUT/1', done: true, qtyDone: 1 }),
    ],
  }));
  // 3 compradas − 1 validada (es de CW-000051, se descuenta) − 1 (CW-000050) − 1 (CW-000051) = 1
  assert.equal(r.returnable[0].available, 1);
});
