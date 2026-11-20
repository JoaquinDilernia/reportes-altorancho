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
