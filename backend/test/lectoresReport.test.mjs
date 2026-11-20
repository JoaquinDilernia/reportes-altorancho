import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLectores } from '../lectoresReport.mjs';

const s = (sku, local, date = '2026-11-18T15:10:00.000Z') => ({ sku, local, date, name: `desc ${sku}` });
const sale = (channel, items, status = 'completed') => ({ channel, status, items: items.map(([sku, qty]) => ({ sku, qty })) });

test('consultas por local, vs. período anterior, consultas por ticket y cruce con lo vendido', () => {
  const curSearches = [s('BCJ062PL', 'lomas'), s('BCJ062PL', 'lomas'), s('IME060AZ', 'lomas', '2026-11-18T19:00:00.000Z'), s('TOA006BG', 'belgrano'), s('XXX', 'nordelta'), s('YYY', 'sin_local')];
  const prevSearches = [s('BCJ062PL', 'lomas'), s('BCJ062PL', 'lomas')];
  const curSales = [
    sale('local_lomas', [['IME060AZ', 2]]),
    sale('local_lomas', [['IME060AZ', 1], ['OTRO', 1]]),
    sale('local_lomas', [['BCJ062PL', 5]], 'cancelled'),
    sale('local_belgrano', [['TOA006BG', 1]]),
  ];
  const productsBySku = new Map([['BCJ062PL', { name: 'BANCO JUNCO' }]]);
  const { byLocal, unassigned } = buildLectores({ curSearches, prevSearches, curSales, productsBySku });

  const l = byLocal.lomas;
  assert.equal(l.searches, 3);
  assert.equal(l.prevSearches, 2);
  assert.equal(l.vsPrev, 50);
  assert.equal(l.tickets, 2); // el cancelado no cuenta
  assert.equal(l.searchesPerTicket, 1.5);
  assert.equal(l.consultedSkus, 2);
  assert.equal(l.soldOfConsultedPct, 50);
  assert.deepEqual(l.top.map((p) => [p.sku, p.searches, p.unitsSold]), [['BCJ062PL', 2, 0], ['IME060AZ', 1, 3]]);
  assert.equal(l.top[0].name, 'BANCO JUNCO');
  assert.equal(l.top[1].name, 'desc IME060AZ');
  assert.deepEqual(l.hours, [{ hour: 12, searches: 2 }, { hour: 16, searches: 1 }]);

  assert.equal(byLocal.belgrano.top[0].unitsSold, 1);
  assert.equal(byLocal.belgrano.vsPrev, null);
  assert.equal(byLocal.alcorta.hasReader, false);
  assert.equal(byLocal.alcorta.searchesPerTicket, null);
  assert.equal(unassigned, 2); // nordelta (cerrado) y sin local
});

test('el top respeta el límite', () => {
  const curSearches = Array.from({ length: 30 }, (_, i) => s(`SKU${String(i).padStart(2, '0')}`, 'lomas'));
  const { byLocal } = buildLectores({ curSearches, prevSearches: [], curSales: [], productsBySku: new Map(), limit: 15 });
  assert.equal(byLocal.lomas.top.length, 15);
  assert.equal(byLocal.lomas.soldOfConsultedPct, 0);
});
