import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../customerType.mjs';

test('classify: first purchase ever is new; prior history or a 2nd order in the period is returning', () => {
  const orders = [
    { id: 2, created_at: '2026-11-05T10:00:00+0000', customer: { id: 7 } },
    { id: 1, created_at: '2026-11-02T10:00:00+0000', customer: { id: 7 } },
    { id: 3, created_at: '2026-11-03T10:00:00+0000', customer: { id: 8 } },
    { id: 4, created_at: '2026-11-03T11:00:00+0000', customer: null },
  ];
  const prior = new Map([[8, '2025-01-01T00:00:00.000Z']]);
  const m = classify(orders, prior);
  assert.equal(m.get('1'), 'nuevo');
  assert.equal(m.get('2'), 'recurrente');
  assert.equal(m.get('3'), 'recurrente');
  assert.equal(m.get('4'), 'sin-dato');
});
