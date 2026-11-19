import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunks, toDailyDoc } from '../pinterestAds.mjs';

test('chunks parte el rango en tramos de hasta 90 días sin huecos', () => {
  assert.deepEqual(chunks('2026-11-01', '2026-11-19'), [['2026-11-01', '2026-11-19']]);
  const c = chunks('2026-01-01', '2026-12-31');
  assert.equal(c[0][0], '2026-01-01');
  assert.equal(c.at(-1)[1], '2026-12-31');
  for (let i = 1; i < c.length; i++) {
    const prevEnd = new Date(`${c[i - 1][1]}T12:00:00Z`).getTime();
    assert.equal(new Date(`${c[i][0]}T12:00:00Z`).getTime() - prevEnd, 864e5);
  }
  assert.ok(c.every(([s, e]) => (new Date(e) - new Date(s)) / 864e5 <= 89));
});

test('toDailyDoc pasa micros a pesos', () => {
  assert.deepEqual(toDailyDoc({ DATE: '2026-11-10', SPEND_IN_MICRO_DOLLAR: 12345670000, TOTAL_CHECKOUT: 3, TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR: 456000000000, TOTAL_CLICKTHROUGH: 80, TOTAL_IMPRESSION: 9000 }),
    { date: '2026-11-10', spend: 12345.67, purchases: 3, purchaseValue: 456000, clicks: 80, impressions: 9000 });
  assert.deepEqual(toDailyDoc({ DATE: '2026-11-11' }), { date: '2026-11-11', spend: 0, purchases: 0, purchaseValue: 0, clicks: 0, impressions: 0 });
});
