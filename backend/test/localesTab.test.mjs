import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localesSideBySide, localesByHour, localDetail, LOCALES } from '../localesTab.mjs';

let seq = 0;
const doc = (total, { channel = 'local_lomas', status = 'completed', date = '2026-11-10T15:00:00Z', qty = 1, sku = 'A', paymentMethod } = {}) => ({
  id: `${channel}-${seq++}`, channel, status, date, total, paymentMethod, items: [{ sku, name: sku, qty, unitPrice: total / qty }],
});
const byId = (r, id) => r.locales.find(l => l.id === id);

test('localesSideBySide: per store totals, units per ticket and share', () => {
  const r = localesSideBySide({
    curDocs: [
      doc(100, { qty: 2 }), doc(100),
      doc(200, { channel: 'local_belgrano' }),
      doc(500, { channel: 'local_alcorta', status: 'cancelled' }),
      doc(900, { channel: 'ecommerce' }),
    ],
    prevDocs: [], yearDocs: [],
  });
  assert.deepEqual(LOCALES.map(l => l.id), ['lomas', 'belgrano', 'alcorta']);
  const l = byId(r, 'lomas');
  assert.equal(l.revenue, 200);
  assert.equal(l.orders, 2);
  assert.equal(l.avgTicket, 100);
  assert.equal(l.unitsPerTicket, 1.5);
  assert.equal(l.sharePct, 50);
  assert.equal(r.total.id, 'total');
  assert.equal(r.total.revenue, 400);
  assert.equal(r.total.orders, 3);
  assert.equal(r.total.sharePct, 100);
});

test('localesSideBySide: a store with no sales has null ticket metrics', () => {
  const r = localesSideBySide({ curDocs: [doc(100)], prevDocs: [], yearDocs: [] });
  const a = byId(r, 'alcorta');
  assert.equal(a.revenue, 0);
  assert.equal(a.orders, 0);
  assert.equal(a.avgTicket, null);
  assert.equal(a.vsPrev.avgTicket, null);
  assert.equal(a.vsYear.avgTicket, null);
  assert.equal(a.unitsPerTicket, null);
  assert.equal(a.sharePct, 0);
  assert.equal(a.vsPrev.revenue, null);
  assert.equal(a.vsPrev.unitsPerTicket, null);
});

test('localesSideBySide: vs year money adjusted, counts nominal', () => {
  const base = { curDocs: [doc(200)], prevDocs: [doc(100)], yearDocs: [doc(100)] };
  const adj = byId(localesSideBySide({ ...base, inflation: { currentIndex: 200, prevYearIndex: 100 } }), 'lomas');
  assert.equal(adj.vsYear.revenue, 0);
  assert.equal(adj.vsYear.orders, 0);
  assert.equal(adj.vsPrev.revenue, 100);
  assert.equal(adj.yearAdjusted, true);
  const nom = byId(localesSideBySide(base), 'lomas');
  assert.equal(nom.vsYear.revenue, 100);
  assert.equal(nom.yearAdjusted, false);
});

test('localesByHour: Argentina hour, gaps filled', () => {
  const h = localesByHour([
    doc(100, { date: '2026-11-10T13:10:00Z' }),
    doc(50, { channel: 'local_belgrano', date: '2026-11-11T01:30:00Z' }),
    doc(70, { channel: 'ecommerce', date: '2026-11-10T05:00:00Z' }),
  ]);
  assert.equal(h.from, 10);
  assert.equal(h.to, 22);
  assert.equal(h.rows.length, 13);
  const r22 = h.rows.find(r => r.hour === 22);
  assert.deepEqual(r22.byLocal.belgrano, { orders: 1, revenue: 50 });
  const r15 = h.rows.find(r => r.hour === 15);
  assert.deepEqual(r15.byLocal, { lomas: { orders: 0, revenue: 0 }, belgrano: { orders: 0, revenue: 0 }, alcorta: { orders: 0, revenue: 0 } });
  assert.deepEqual(localesByHour([]), { from: null, to: null, rows: [] });
});

const lomas = LOCALES[0];

test('localDetail: top models carry the store stock and Rolón', () => {
  const productsBySku = new Map([
    ['MMA008NE', { sku: 'MMA008NE', name: 'Mesa Negro', stockByLoc: { lomas_stock: 3, lomas_exhibicion: 1, rolon: 10, mayorista: 2, belgrano_stock: 9 } }],
  ]);
  const d = localDetail({
    local: lomas,
    curDocs: [doc(200, { sku: 'MMA008NE', qty: 2 }), doc(50, { sku: 'ZZZ999' })],
    prevDocs: [], productsBySku, originBySku: null, factorByRefDate: null,
  });
  const m = d.topModels.find(t => t.sku === 'MMA008');
  assert.deepEqual(m.local, { stock: 3, exhibition: 1 });
  assert.equal(m.rolon, 12);
  const z = d.topModels.find(t => t.sku === 'ZZZ999');
  assert.deepEqual(z.local, { stock: 0, exhibition: 0 });
  assert.equal(z.rolon, 0);
});

test('localDetail: payments by revenue with share', () => {
  const d = localDetail({
    local: lomas,
    curDocs: [doc(100, { paymentMethod: 'Efectivo' }), doc(300, { paymentMethod: 'Tarjeta' }), doc(100)],
    prevDocs: [], productsBySku: new Map(), originBySku: null,
  });
  assert.deepEqual(d.payments, [
    { method: 'Tarjeta', orders: 1, revenue: 300, sharePct: 60 },
    { method: 'Efectivo', orders: 1, revenue: 100, sharePct: 20 },
    { method: 'Sin dato', orders: 1, revenue: 100, sharePct: 20 },
  ]);
});

test('localDetail: origins null without origin map; stock from the store keys', () => {
  const productsBySku = new Map([
    ['A1', { sku: 'A1', name: 'a', stockByLoc: { lomas_exhibicion: 2, lomas_stock: 5 } }],
    ['B1', { sku: 'B1', name: 'b', stockByLoc: { lomas_exhibicion: 3, belgrano_stock: 4 } }],
    ['C1', { sku: 'C1', name: 'c', stockByLoc: { lomas_exhibicion: -2 } }],
  ]);
  const d = localDetail({ local: lomas, curDocs: [doc(100)], prevDocs: [], productsBySku, originBySku: null });
  assert.equal(d.origins, null);
  assert.deepEqual(d.stock, { stock: { units: 5, products: 1 }, exhibition: { units: 5, products: 2 }, exhibitionKnown: true });
  assert.ok(Array.isArray(d.categories));
});

test('localDetail: exhibition unknown while products only carry the legacy stock keys', () => {
  const legacy = new Map([['A1', { sku: 'A1', name: 'a', stockByLocation: { local_lomas: 4 } }]]);
  const d = localDetail({ local: lomas, curDocs: [doc(100, { sku: 'A1' })], prevDocs: [], productsBySku: legacy, originBySku: null });
  assert.equal(d.stock.exhibitionKnown, false);
  assert.equal(d.stock.stock.units, 4);
  const modern = new Map([['A1', { sku: 'A1', name: 'a', stockByLoc: { lomas_stock: 4 } }]]);
  assert.equal(localDetail({ local: lomas, curDocs: [], prevDocs: [], productsBySku: modern, originBySku: null }).stock.exhibitionKnown, true);
});
