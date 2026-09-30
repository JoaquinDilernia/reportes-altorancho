import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sellerCodeFor, CAJA_SELLER_CODE } from '../feriaCarts.mjs';
import { formatOrderNumber } from '../feriaLines.mjs';

test('los pedidos que arma caja se numeran aparte (FC-0001), sin buscar vendedor', () => {
  assert.equal(sellerCodeFor({ id: 'caja.usuario', name: 'Caja', role: 'caja' }), CAJA_SELLER_CODE);
  assert.equal(formatOrderNumber(1, CAJA_SELLER_CODE), 'FC-0001');
});
