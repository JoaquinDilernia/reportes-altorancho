import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOCK_LOCATIONS, LOC_GROUPS, stockByLocFromQuants } from '../stockLocations.mjs';

const q = (sku, name, loc, quantity) => ({ product_id: [1, `[${sku}] ${name}`], location_id: [loc, 'x'], quantity });

test('STOCK_LOCATIONS: the ten physical locations, nothing else', () => {
  assert.deepEqual(Object.keys(STOCK_LOCATIONS).map(Number).sort((a, b) => a - b), [8, 150, 168, 174, 324, 372, 379, 397, 407, 415]);
  assert.equal(STOCK_LOCATIONS[324], 'lomas_exhibicion');
  assert.equal(STOCK_LOCATIONS[407], 'alcorta_en_rolon');
  assert.deepEqual(LOC_GROUPS.rolon, ['rolon', 'mayorista', 'alcorta_en_rolon']);
  assert.deepEqual(LOC_GROUPS.localExhibition, ['lomas_exhibicion', 'belgrano_exhibicion', 'alcorta_exhibicion']);
});

test('stockByLocFromQuants: sums per SKU and key; ignores other locations, junk and non-positive', () => {
  const m = stockByLocFromQuants([
    q('MSI018VE', 'Silla', 174, 5), q('MSI018VE', 'Silla', 174, 2), q('MSI018VE', 'Silla', 324, 1),
    q('MSI018VE', 'Silla', 330, 900), // Producto (packaging) — not a sales location
    q('MSI020NE', 'Silla Tube', 8, -3),
    q('GFT001AR', 'GIFT CARD', 150, 100000000),
    q('EnvioParticular', 'Envio particular pos', 8, 5),
  ]);
  assert.deepEqual(Object.fromEntries(m), { MSI018VE: { rolon: 7, lomas_exhibicion: 1 } });
});
