import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topProductOfDay, peakHourOfDay } from '../eventReport.mjs';

const sale = (date, total, items, status = 'completed') => ({ date, total, items, status });

test('topProductOfDay: most units that ART day, ignoring discounts and other days', () => {
  const docs = [
    sale('2026-10-30T15:00:00Z', 10, [{ name: 'A', qty: 1, unitPrice: 5 }, { name: 'Descuento', qty: 5, unitPrice: -1 }]),
    sale('2026-10-30T16:00:00Z', 10, [{ name: 'B', qty: 3, unitPrice: 5 }]),
    sale('2026-10-29T16:00:00Z', 10, [{ name: 'C', qty: 9, unitPrice: 5 }]),
    sale('2026-10-30T16:00:00Z', 10, [{ name: 'D', qty: 9, unitPrice: 5 }], 'cancelled'),
  ];
  assert.deepEqual(topProductOfDay(docs, '2026-10-30'), { name: 'B', units: 3 });
  assert.equal(topProductOfDay(docs, '2026-10-01'), null);
});

test('peakHourOfDay: ART hour with most completed revenue', () => {
  const docs = [
    sale('2026-10-30T00:30:00Z', 100, []), // 21h ART of the 29th
    sale('2026-10-30T15:10:00Z', 50, []),  // 12h
    sale('2026-10-30T15:50:00Z', 70, []),  // 12h
    sale('2026-10-30T18:00:00Z', 90, []),  // 15h
  ];
  assert.deepEqual(peakHourOfDay(docs, '2026-10-30'), { hour: 12, revenue: 120 });
  assert.deepEqual(peakHourOfDay(docs, '2026-10-29'), { hour: 21, revenue: 100 });
  assert.equal(peakHourOfDay(docs, '2026-10-01'), null);
});
