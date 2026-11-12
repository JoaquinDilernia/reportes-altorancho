import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webCoverage, isJunkSku } from '../stockCoverage.mjs';

const sale = (sku, qty, unitPrice, status = 'completed') => ({ channel: 'ecommerce', status, date: '2026-11-01T15:00:00Z', items: [{ sku, qty, unitPrice }] });
const products = (entries) => new Map(entries.map(p => [p.sku, p]));

test('webCoverage: a product with < 7 days of web stock is listed with coverage, revenue and where', () => {
  const rows = webCoverage({
    webSalesDocs: [sale('A1', 28, 100)],
    productsBySku: products([{ sku: 'A1', name: 'Silla A', currentStock: 3, stockByLocation: { deposito: 10, local_lomas: 2 } }]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weeklyUnits, 7);
  assert.equal(rows[0].dailyRevenue, 100);
  assert.equal(rows[0].coverageDays, 3);
  assert.equal(rows[0].group, 'rolon');
  assert.deepEqual(rows[0].where, { deposito: 10, local_lomas: 2 });
});

test('webCoverage: enough web stock → not listed', () => {
  const rows = webCoverage({
    webSalesDocs: [sale('A1', 28, 100)],
    productsBySku: products([{ sku: 'A1', name: 'Silla A', currentStock: 50, stockByLocation: {} }]),
  });
  assert.deepEqual(rows, []);
});

test('webCoverage: groups — only in a store → local; nowhere → none; order rolon, local, none', () => {
  const rows = webCoverage({
    webSalesDocs: [sale('N1', 28, 50), sale('L1', 28, 100), sale('R1', 28, 10)],
    productsBySku: products([
      { sku: 'N1', name: 'N', currentStock: 0, stockByLocation: {} },
      { sku: 'L1', name: 'L', currentStock: 0, stockByLocation: { local_belgrano: 1 } },
      { sku: 'R1', name: 'R', currentStock: 1, stockByLocation: { mayorista: 4 } },
    ]),
  });
  assert.deepEqual(rows.map(r => [r.sku, r.group, r.coverageDays]), [['R1', 'rolon', 1], ['L1', 'local', 0], ['N1', 'none', 0]]);
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
      { sku: 'A1', name: 'Silla A', currentStock: 3, stockByLocation: { deposito: -2, local_lomas: 0, local_alcorta: 1 } },
    ]),
  });
  assert.deepEqual(rows.map(r => r.sku), ['A1']);
  assert.equal(rows[0].weeklyUnits, 7);
  assert.deepEqual(rows[0].where, { local_alcorta: 1 });
  assert.equal(rows[0].group, 'local');
});

test('isJunkSku', () => {
  assert.equal(isJunkSku('GFT002AN', 'GIFT CARD'), true);
  assert.equal(isJunkSku('EnvioParticular', ''), true);
  assert.equal(isJunkSku('MSI018VE', 'Silla Chicago'), false);
});
