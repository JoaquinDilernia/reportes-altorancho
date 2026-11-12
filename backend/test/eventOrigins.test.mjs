import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOrigins, originIdOf } from '../eventOrigins.mjs';

test('originIdOf: Odoo names (with accents) map to ids; anything else is otro', () => {
  assert.equal(originIdOf('Fábrica'), 'fabrica');
  assert.equal(originIdOf('Proveedor Nacional'), 'nacional');
  assert.equal(originIdOf('Importado'), 'importado');
  assert.equal(originIdOf('DUAL'), 'otro');
  assert.equal(originIdOf(null), 'otro');
});

test('summarizeOrigins: revenue, units, orders, ticket and share; 2025 adjusted; discounts ignored', () => {
  const originBySku = new Map([
    ['F1', { clase: 'Fábrica', pais: 'Nacional' }],
    ['I1', { clase: 'Importado', pais: 'China' }],
  ]);
  const currentDocs = [
    { id: 'a', status: 'completed', date: '2026-11-02T15:00:00Z', items: [
      { sku: 'F1', qty: 2, unitPrice: 100 }, { sku: 'I1', qty: 1, unitPrice: 300 }, { sku: 'DESC', qty: 1, unitPrice: -50 },
    ] },
    { id: 'b', status: 'completed', date: '2026-11-02T16:00:00Z', items: [{ sku: 'F1', qty: 1, unitPrice: 100 }] },
    { id: 'c', status: 'cancelled', date: '2026-11-02T16:00:00Z', items: [{ sku: 'F1', qty: 9, unitPrice: 100 }] },
  ];
  const prevToDateDocs = [{ id: 'p', status: 'completed', date: '2025-11-03T15:00:00Z', items: [{ sku: 'F1', qty: 1, unitPrice: 100 }] }];
  const out = summarizeOrigins({ prevToDateDocs, currentDocs, originBySku, factorByRefDate: new Map([['2025-11-03', 1.5]]) });
  const fab = out.find(o => o.id === 'fabrica');
  assert.deepEqual(fab.cur, { revenue: 300, units: 3, orders: 2, avgTicket: 150, share: 0.5 });
  assert.equal(fab.prev.revenue, 150);
  const imp = out.find(o => o.id === 'importado');
  assert.deepEqual(imp.countries, [{ name: 'China', revenue: 300 }]);
  assert.equal(out.find(o => o.id === 'otro'), undefined);
});
