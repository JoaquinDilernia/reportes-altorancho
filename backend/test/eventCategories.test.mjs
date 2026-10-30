import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_CATEGORIES, eventCategoryOf, summarizeCategories } from '../eventCategories.mjs';

const P = (odooCategPath, name = 'X') => ({ name, odooCategPath });

test('eventCategoryOf: maps real Biblia paths', () => {
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / SILLAS / SILLA / SILLA / TUBE')), 'sillas');
  const lamp = 'All / Biblia/ ILUMINACION / ILUMINACION MESA / VELADOR / VELADOR / MAOZI';
  assert.equal(eventCategoryOf(P(lamp, 'LAMPARA DE MESA LED INALAMBRICA CONO VINO')), 'iluminacion_inalambrica');
  assert.equal(eventCategoryOf(P(lamp, 'LAMPARA DE MESA CONO')), 'iluminacion');
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / MUEBLES / ESCRITORIO / ESCRITORIO / X')), 'escritorios');
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / COMODA / COMODA / COMODA / X')), 'comodas');
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / PERCHERO / PERCHERO / PERCHERO / X')), 'otros_muebles');
  assert.equal(eventCategoryOf(P('All / Biblia/ TEXTIL / MANTAS / MANTA')), 'textil');
  assert.equal(eventCategoryOf(undefined), 'otros');
});

test('eventCategoryOf: falls back to the item name when the product is unknown', () => {
  assert.equal(eventCategoryOf(undefined, 'Lámpara inalámbrica'), 'iluminacion_inalambrica');
});

test('eventCategoryOf: other level-3 muebles and accents', () => {
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / MESAS / MESA RATONA / X')), 'mesas_ratonas');
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / MESAS / MESA DE LUZ / X')), 'mesas_luz');
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / BANCOS / BANQUETA / X')), 'bancos');
  assert.equal(eventCategoryOf(P('All / Biblia/ MUEBLES / COMEDOR / CÓNSOLA / X')), 'consolas');
  assert.equal(eventCategoryOf(P('All / Fabrica / Insumos / Carpintería')), 'otros');
});

const sale = (iso, status, items) => ({ id: iso + status, channel: 'ecommerce', date: iso, status, total: 0, items });
const it = (sku, qty, unitPrice, name = sku) => ({ sku, name, qty, unitPrice });

test('summarizeCategories: units, revenue (2025 inflation-adjusted), stock and cantMatch', () => {
  const productsBySku = new Map([
    ['S1', { sku: 'S1', name: 'Silla 1', odooCategPath: 'All / Biblia/ MUEBLES / SILLAS / SILLA / X', stockByLocation: { local_lomas: 2, deposito: 3 } }],
    ['S2', { sku: 'S2', name: 'Silla 2', odooCategPath: 'All / Biblia/ MUEBLES / SILLAS / SILLA / X', stockByLocation: { local_lomas: 1, deposito: -5 } }],
  ]);
  const prevDocs = [
    sale('2025-11-03T15:00:00Z', 'completed', [it('S1', 10, 100), it('ZZ', 1, 50), it('S1', 1, -40)]),
    sale('2025-11-04T15:00:00Z', 'completed', [it('S2', 5, 200)]),
    sale('2025-11-03T16:00:00Z', 'pending', [it('S1', 99, 100)]),
  ];
  const currentDocs = [
    sale('2026-11-02T15:00:00Z', 'completed', [it('S1', 4, 300), it('S1', 1, -100)]),
    sale('2026-11-02T16:00:00Z', 'cancelled', [it('S2', 50, 300)]),
  ];
  const out = summarizeCategories({
    prevDocs, prevToDateDocs: prevDocs.slice(0, 1), currentDocs, productsBySku,
    factorByRefDate: new Map([['2025-11-03', 2], ['2025-11-04', 2]]),
  });
  assert.deepEqual(out.map(c => c.id), ['sillas', 'otros']);
  const sillas = out[0];
  assert.equal(sillas.label, 'Sillas');
  assert.equal(sillas.prevUnits, 15);
  assert.equal(sillas.prevRevenueAdj, (1000 + 1000) * 2);
  assert.equal(sillas.prevUnitsToDate, 10);
  assert.equal(sillas.prevRevenueToDateAdj, 2000);
  assert.equal(sillas.units, 4);
  assert.equal(sillas.revenue, 1200);
  assert.equal(sillas.stock, 6);
  assert.equal(sillas.cantMatch, true); // 4 + 6 < 15
  assert.deepEqual(sillas.topProducts, [{ sku: 'S1', name: 'Silla 1', units: 4, revenue: 1200 }]);
  const otros = out[1];
  assert.equal(otros.prevUnits, 1);
  assert.equal(otros.units, 0);
  assert.equal(otros.cantMatch, true); // 0 + 0 < 1
});
