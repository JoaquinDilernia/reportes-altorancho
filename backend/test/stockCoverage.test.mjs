import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webCoverage, isJunkSku } from '../stockCoverage.mjs';

const sale = (sku, qty, unitPrice, status = 'completed') => ({ channel: 'ecommerce', status, date: '2026-11-01T15:00:00Z', items: [{ sku, qty, unitPrice }] });
const products = (entries) => new Map(entries.map(p => [p.sku, p]));
const one = (stockByLoc, extra = {}) => webCoverage({
  webSalesDocs: [sale('A1', 28, 100)],
  productsBySku: products([{ sku: 'A1', name: 'Silla A', currentStock: 3, stockByLoc, ...extra }]),
})[0];

test('webCoverage: a product with < 7 days of web stock is listed with coverage, revenue and where', () => {
  const r = one({ rolon: 10, lomas_stock: 2, web_odoo: 20 });
  assert.equal(r.weeklyUnits, 7);
  assert.equal(r.dailyRevenue, 100);
  assert.equal(r.lostPerDay, 100);
  assert.equal(r.coverageDays, 3);
  assert.equal(r.group, 'rolon');
  assert.equal(r.onlyExhibition, false);
  // The web's own Odoo warehouse is not "somewhere else".
  assert.deepEqual(r.where, { rolon: 10, lomas_stock: 2 });
});

test('webCoverage: enough web stock → not listed', () => {
  const rows = webCoverage({
    webSalesDocs: [sale('A1', 28, 100)],
    productsBySku: products([{ sku: 'A1', name: 'Silla A', currentStock: 50, stockByLoc: {} }]),
  });
  assert.deepEqual(rows, []);
});

test('webCoverage: Alcorta en Rolón and mayorista count as Rolón', () => {
  assert.equal(one({ alcorta_en_rolon: 1 }).group, 'rolon');
  assert.equal(one({ mayorista: 4 }).group, 'rolon');
});

test('webCoverage: only on a store floor → local, flagged onlyExhibition', () => {
  const r = one({ belgrano_exhibicion: 2 });
  assert.equal(r.group, 'local');
  assert.equal(r.onlyExhibition, true);
  const s = one({ belgrano_exhibicion: 2, lomas_stock: 1 });
  assert.equal(s.onlyExhibition, false);
});

test('webCoverage: only in the web Odoo warehouse → none', () => {
  assert.equal(one({ web_odoo: 20 }).group, 'none');
});

test('webCoverage: falls back to the old stockByLocation when stockByLoc is missing', () => {
  const r = one(undefined, { stockByLocation: { deposito: 3, local_lomas: 1, ecommerce_odoo: 9 } });
  assert.equal(r.group, 'rolon');
  assert.deepEqual(r.where, { rolon: 3, lomas_stock: 1 });
});

test('webCoverage: groups ordered rolon, local, none; by lost sale inside', () => {
  const rows = webCoverage({
    webSalesDocs: [sale('N1', 28, 50), sale('L1', 28, 100), sale('R1', 28, 10), sale('R2', 28, 20)],
    productsBySku: products([
      { sku: 'N1', name: 'N', currentStock: 0, stockByLoc: {} },
      { sku: 'L1', name: 'L', currentStock: 0, stockByLoc: { belgrano_stock: 1 } },
      { sku: 'R1', name: 'R', currentStock: 1, stockByLoc: { mayorista: 4 } },
      { sku: 'R2', name: 'R2', currentStock: 1, stockByLoc: { rolon: 4 } },
    ]),
  });
  assert.deepEqual(rows.map(r => [r.sku, r.group]), [['R2', 'rolon'], ['R1', 'rolon'], ['L1', 'local'], ['N1', 'none']]);
});

test('webCoverage: gift cards and envío never listed; unknown SKUs skipped; negatives ignored; only completed sales', () => {
  const rows = webCoverage({
    webSalesDocs: [
      sale('GFT001AR', 5, 5000), sale('EnvioParticular', 3, 1000), sale('ZZZ999', 10, 10),
      sale('A1', 28, 100), sale('A1', 100, 100, 'cancelled'),
    ],
    productsBySku: products([
      { sku: 'GFT001AR', name: 'GIFT CARD', currentStock: 0 },
      { sku: 'EnvioParticular', name: 'Envio particular pos', currentStock: 0 },
      { sku: 'A1', name: 'Silla A', currentStock: 3, stockByLoc: { rolon: -2, lomas_stock: 0, alcorta_stock: 1 } },
    ]),
  });
  assert.deepEqual(rows.map(r => r.sku), ['A1']);
  assert.equal(rows[0].weeklyUnits, 7);
  assert.deepEqual(rows[0].where, { alcorta_stock: 1 });
  assert.equal(rows[0].group, 'local');
});

test('isJunkSku', () => {
  assert.equal(isJunkSku('GFT002AN', 'GIFT CARD'), true);
  assert.equal(isJunkSku('EnvioParticular', ''), true);
  assert.equal(isJunkSku('MSI018VE', 'Silla Chicago'), false);
});
