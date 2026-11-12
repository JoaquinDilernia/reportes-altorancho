import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_FILTERS, filterDocs, overstock, warehouses, stockOf, modelStock, categoryStock } from '../productTab.mjs';

const doc = (channel, items, status = 'completed') => ({ id: `${channel}-${Math.random()}`, channel, status, date: '2026-11-03T15:00:00Z', items });
const products = (list) => new Map(list.map(p => [p.sku, p]));

test('filterDocs: channel filters (mayorista includes feria); all = everything', () => {
  const docs = ['ecommerce', 'local_lomas', 'local_belgrano', 'local_alcorta', 'mayorista', 'feria'].map(ch => doc(ch, []));
  assert.equal(filterDocs(docs, 'all').length, 6);
  assert.deepEqual(filterDocs(docs, 'locales').map(d => d.channel), ['local_lomas', 'local_belgrano', 'local_alcorta']);
  assert.deepEqual(filterDocs(docs, 'mayorista').map(d => d.channel), ['mayorista', 'feria']);
  assert.deepEqual(filterDocs(docs, 'web').map(d => d.channel), ['ecommerce']);
  assert.equal(filterDocs(docs, 'nope').length, 6);
  assert.deepEqual(Object.keys(CHANNEL_FILTERS), ['all', 'web', 'locales', 'mayorista']);
});

test('stockOf: web = max(Tiendanube, Odoo EC); other locations summed; old field as fallback; negatives 0', () => {
  assert.deepEqual(stockOf({ currentStock: 3, stockByLoc: { web_odoo: 20, rolon: 5, lomas_exhibicion: 1 } }), { web: 20, other: 6, total: 26 });
  assert.deepEqual(stockOf({ currentStock: 4, stockByLoc: { rolon: -2 } }), { web: 4, other: 0, total: 4 });
  assert.deepEqual(stockOf({ currentStock: null, stockByLocation: { deposito: 2, ecommerce_odoo: 1 } }), { web: 1, other: 2, total: 3 });
});

test('overstock: lots of stock, slow or no sales; junk and small stock out', () => {
  const p = products([
    { sku: 'SLOW01', name: 'Lenta', currentStock: 0, stockByLoc: { rolon: 200 } },
    { sku: 'NONE01', name: 'Sin ventas', currentStock: 10, stockByLoc: { mayorista: 40 } },
    { sku: 'FAST01', name: 'Rápida', currentStock: 5, stockByLoc: { rolon: 20 } },
    { sku: 'TINY01', name: 'Poca', currentStock: 2, stockByLoc: { rolon: 3 } },
    { sku: 'GFT001AR', name: 'GIFT CARD', currentStock: 100000000, stockByLoc: { web_odoo: 100000000 } },
  ]);
  const sales = [doc('ecommerce', [{ sku: 'SLOW01', qty: 1, unitPrice: 10 }]), doc('local_lomas', [{ sku: 'FAST01', qty: 40, unitPrice: 10 }])];
  const rows = overstock({ salesDocs8w: sales, productsBySku: p });
  assert.deepEqual(rows.map(r => r.sku), ['SLOW01', 'NONE01']);
  assert.equal(rows[0].stockTotal, 200);
  assert.equal(rows[0].coverageDays, 11200); // 200 u at 1 u / 56 days
  assert.equal(rows[1].coverageDays, null);
  assert.equal(rows[1].weeklyUnits, 0);
});

test('warehouses: units and products per location, junk out, negatives 0', () => {
  const w = warehouses(products([
    { sku: 'A', name: 'A', stockByLoc: { lomas_exhibicion: 2, rolon: 5 } },
    { sku: 'B', name: 'B', stockByLoc: { lomas_exhibicion: 1, rolon: -4 } },
    { sku: 'GFT001AR', name: 'GIFT CARD', stockByLoc: { web_odoo: 100000000 } },
  ]));
  const by = Object.fromEntries(w.map(x => [x.key, x]));
  assert.deepEqual([by.lomas_exhibicion.units, by.lomas_exhibicion.products], [3, 2]);
  assert.deepEqual([by.rolon.units, by.rolon.products], [5, 1]);
  assert.equal(by.web_odoo.units, 0);
  assert.ok(by.rolon.label && by.rolon.group === 'rolon');
  assert.equal(by.lomas_exhibicion.group, 'locales');
});

test('modelStock and categoryStock: summed by model / category from the new locations', () => {
  const p = products([
    { sku: 'MSI018VE', name: 'Silla Chicago Verde', odooCategPath: 'Biblia / Sillas', currentStock: 0, stockByLoc: { rolon: 5, lomas_stock: 1 } },
    { sku: 'MSI018NE', name: 'Silla Chicago Negro', odooCategPath: 'Biblia / Sillas', currentStock: 2, stockByLoc: { web_odoo: 2 } },
  ]);
  const m = modelStock(p).get('MSI018');
  assert.equal(m.total, 8);
  assert.deepEqual(m.byLoc, { rolon: 5, lomas_stock: 1 });
  assert.equal(m.web, 2);
  const c = categoryStock(p);
  assert.equal([...c.values()].reduce((s, n) => s + n, 0), 8);
});

test('prevYearToDate: a running period compares against the same elapsed days last year', async () => {
  const { prevYearToDate } = await import('../productTab.mjs');
  const ranges = { current: { start: '2026-11-09', end: '2026-11-15' }, prevYear: { start: '2025-11-09', end: '2025-11-15' } };
  // Wednesday: Mon–Wed this year vs Mon–Wed of last year's window.
  assert.deepEqual(prevYearToDate(ranges, '2026-11-11'), { start: '2025-11-09', end: '2025-11-11', partial: true });
  // Closed period: the whole window.
  assert.deepEqual(prevYearToDate(ranges, '2026-11-20'), { start: '2025-11-09', end: '2025-11-15', partial: false });
  assert.deepEqual(prevYearToDate(ranges, '2026-11-15'), { start: '2025-11-09', end: '2025-11-15', partial: false });
});

test('modelStock: web column is Tiendanube only (same number as Pasar a la web)', () => {
  const p = new Map([
    ['MSI018VE', { sku: 'MSI018VE', name: 'V', currentStock: 0, stockByLoc: { web_odoo: 20, rolon: 1 } }],
    ['MSI018NE', { sku: 'MSI018NE', name: 'N', currentStock: 3, stockByLoc: { web_odoo: 3 } }],
  ]);
  const m = modelStock(p).get('MSI018');
  assert.equal(m.tn, 3);
});
