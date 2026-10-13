import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posDocId, POS_STORES, toPosDoc } from '../sync/posLocales.mjs';

test('posDocId: no choca con los ids de pos.order del mismo canal', () => {
  assert.equal(posDocId('local_lomas', 123), 'local_lomas_so_123');
});

test('POS_STORES: un canal por local con su prefijo de número interno', () => {
  assert.deepEqual(POS_STORES.map((s) => s.channel), ['local_lomas', 'local_belgrano', 'local_alcorta']);
});

test('toPosDoc: normaliza un sale.order al formato del dashboard con id propio', () => {
  const doc = toPosDoc(
    { id: 9, date_order: '2026-10-13 15:00:00', amount_total: 1210, state: 'sale' },
    [{ product_id: [10, '[QUE001] Cajonera Queens'], product_uom_qty: 1, price_unit: 1000 }],
    'local_lomas', new Map([['QUE001', 'Cajoneras']]),
  );
  assert.equal(doc.id, 'local_lomas_so_9');
  assert.equal(doc.channel, 'local_lomas');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.items[0].sku, 'QUE001');
});
