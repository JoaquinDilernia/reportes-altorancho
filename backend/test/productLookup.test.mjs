import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchProducts, productSheet } from '../productLookup.mjs';

const products = new Map([
  ['MSI018RV', { sku: 'MSI018RV', name: 'Silla Chicago Roble', category: 'Sillas', currentStock: 4, stockByLocation: { deposito: 10 } }],
  ['MSI018VE', { sku: 'MSI018VE', name: 'Silla Chicago Verde', category: 'Sillas', currentStock: 0, stockByLocation: { local_lomas: 1 }, stockByLoc: { lomas_exhibicion: 1 } }],
  ['MSI020NE', { sku: 'MSI020NE', name: 'Silla Tube Negra', category: 'Sillas', currentStock: 2 }],
  ['ILU005BL', { sku: 'ILU005BL', name: 'Lámpara Inalámbrica Bola', category: 'Iluminación', currentStock: 7 }],
  ['GFT001AR', { sku: 'GFT001AR', name: 'GIFT CARD', category: 'Gift card', currentStock: 100000000 }],
]);

test('searchProducts: SKU prefix, any case', () => {
  assert.deepEqual(searchProducts(products, 'msi018').map(r => r.sku).sort(), ['MSI018RV', 'MSI018VE']);
});

test('searchProducts: every word of the name', () => {
  const skus = searchProducts(products, 'silla chicago verde').map(r => r.sku);
  assert.deepEqual(skus, ['MSI018VE']);
  const two = searchProducts(products, 'silla chicago').map(r => r.sku);
  assert.ok(two.includes('MSI018VE'));
  assert.ok(!two.includes('MSI020NE'));
});

test('searchProducts: ignores accents', () => {
  const [r] = searchProducts(products, 'lampara');
  assert.equal(r.sku, 'ILU005BL');
  assert.deepEqual(r, { sku: 'ILU005BL', name: 'Lámpara Inalámbrica Bola', category: 'Iluminación' });
});

test('searchProducts: gift cards excluded; empty query → nothing', () => {
  assert.deepEqual(searchProducts(products, 'gift'), []);
  assert.deepEqual(searchProducts(products, 'GFT'), []);
  assert.deepEqual(searchProducts(products, '  '), []);
});

const sale = (channel, date, items, status = 'completed') => ({ id: `${channel}-${date}`, channel, status, date, items });

test('productSheet: channels grouped (feria in mayorista), Argentine days, only this SKU', () => {
  const salesDocs = [
    sale('ecommerce', '2026-11-03T01:30:00.000Z', [{ sku: 'MSI018VE', qty: 2, unitPrice: 100 }, { sku: 'MSI020NE', qty: 9, unitPrice: 50 }]),
    sale('feria', '2026-11-04T15:00:00.000Z', [{ sku: 'MSI018VE', qty: 1, unitPrice: 90 }]),
    sale('mayorista', '2026-11-04T16:00:00.000Z', [{ sku: 'MSI018VE', qty: 3, unitPrice: 80 }]),
    sale('local_lomas', '2026-11-05T16:00:00.000Z', [{ sku: 'MSI018VE', qty: 5, unitPrice: 100 }], 'cancelled'),
  ];
  const s = productSheet({ sku: 'MSI018VE', productsBySku: products, salesDocs, originBySku: new Map([['MSI018VE', { clase: 'Importado', pais: 'China' }]]) });
  assert.equal(s.name, 'Silla Chicago Verde');
  assert.equal(s.webStock, 0);
  assert.deepEqual(s.stockByLocation, { local_lomas: 1 });
  assert.deepEqual(s.stockByLoc, { lomas_exhibicion: 1 });
  assert.deepEqual(s.origin, { clase: 'Importado', pais: 'China' });
  const by = Object.fromEntries(s.byChannel.map(c => [c.id, c]));
  assert.deepEqual(by.web, { id: 'web', units: 2, revenue: 200 });
  assert.deepEqual(by.mayorista, { id: 'mayorista', units: 4, revenue: 330 });
  assert.equal(by.lomas.units, 0);
  assert.deepEqual(s.byDay, [{ date: '2026-11-02', units: 2, revenue: 200 }, { date: '2026-11-04', units: 4, revenue: 330 }]);
});

test('productSheet: unknown SKU → null', () => {
  assert.equal(productSheet({ sku: 'NOPE', productsBySku: products, salesDocs: [], originBySku: new Map() }), null);
});
