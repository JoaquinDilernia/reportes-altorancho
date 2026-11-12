import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotDateFor, webStockSnapshotDoc, claritySnapshotDoc } from '../snapshots.mjs';

test('snapshotDateFor: the 00:05, 06:00 and 12:00 ART runs all snapshot the previous day', () => {
  assert.equal(snapshotDateFor(new Date('2026-11-13T03:05:00Z')), '2026-11-12'); // 00:05 ART
  assert.equal(snapshotDateFor(new Date('2026-11-13T09:00:00Z')), '2026-11-12'); // 06:00 ART
  assert.equal(snapshotDateFor(new Date('2026-11-13T15:00:00Z')), '2026-11-12'); // 12:00 ART
});

test('webStockSnapshotDoc: keeps every known stock (zeros too), drops gift cards and unknowns, negatives become 0', () => {
  const products = new Map([
    ['GFT001AR', { sku: 'GFT001AR', currentStock: 100000000 }],
    ['X1', { sku: 'X1', currentStock: 3 }],
    ['X2', { sku: 'X2', currentStock: null }],
    ['X3', { sku: 'X3', currentStock: -2 }],
    ['X4', { sku: 'X4', currentStock: 0 }],
  ]);
  const doc = webStockSnapshotDoc(products, '2026-11-12');
  assert.equal(doc.date, '2026-11-12');
  assert.deepEqual(doc.bySku, { X1: 3, X3: 0, X4: 0 });
});

test('claritySnapshotDoc: empty project (real live shape) → zero sessions, no pages', () => {
  const empty = [
    { metricName: 'RageClickCount', information: [{ sessionsCount: 0, sessionsWithMetricPercentage: 0, subTotal: 0 }] },
    { metricName: 'Traffic', information: [{ totalSessionCount: 0, totalBotSessionCount: 0, distinctUserCount: 0, pagesPerSessionPercentage: null }] },
  ];
  const byUrl = [{ metricName: 'Traffic', information: [] }];
  const doc = claritySnapshotDoc(empty, byUrl, '2026-11-12');
  assert.equal(doc.date, '2026-11-12');
  assert.equal(doc.totals.sessions, 0);
  assert.deepEqual(doc.pages, []);
});
