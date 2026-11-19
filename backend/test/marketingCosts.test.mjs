import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costForRange, monthlyCost } from '../marketingCosts.mjs';
import { paidBlock, attributedOrders } from '../pautaRealTab.mjs';

test('monthlyCost: lo cargado, o el abono por defecto de Perfit; Pinterest sin cargar es null', () => {
  assert.equal(monthlyCost({ pinterest: { '2026-11': 300000 } }, 'pinterest', '2026-11'), 300000);
  assert.equal(monthlyCost({}, 'pinterest', '2026-11'), null);
  assert.equal(monthlyCost({}, 'perfit', '2026-11'), 500000);
  assert.equal(monthlyCost({ perfit: { '2026-11': 450000 } }, 'perfit', '2026-11'), 450000);
  assert.equal(monthlyCost(null, 'perfit', '2026-11'), 500000);
});

test('costForRange prorratea por día, corta en hoy y cruza meses', () => {
  const costs = { pinterest: { '2026-10': 310000, '2026-11': 300000 } };
  // mes completo
  assert.equal(costForRange(costs, 'pinterest', { start: '2026-11-01', end: '2026-11-30' }).cost, 300000);
  // mes en curso: hasta hoy (19 de 30 días)
  assert.equal(costForRange(costs, 'pinterest', { start: '2026-11-01', end: '2026-11-30' }, '2026-11-19').cost, 190000);
  // semana que cruza meses: 2 días de octubre (10.000/día) + 5 de noviembre (10.000/día)
  assert.equal(costForRange(costs, 'pinterest', { start: '2026-10-30', end: '2026-11-05' }).cost, 70000);
  // falta un mes: no se inventa
  const r = costForRange(costs, 'pinterest', { start: '2026-09-29', end: '2026-10-02' });
  assert.equal(r.cost, null);
  assert.deepEqual(r.missing, ['2026-09']);
  // período futuro
  assert.equal(costForRange(costs, 'pinterest', { start: '2026-12-01', end: '2026-12-07' }, '2026-11-19').cost, 0);
});

test('paidBlock sin "lo que dice la plataforma" ni gasto no rompe', () => {
  const orders = [{ total: 100000, grossProfit: 40000 }, { total: 50000, grossProfit: 20000 }];
  const b = paidBlock({ spend: 30000, reportedValue: null, orders });
  assert.equal(b.reported, null);
  assert.equal(b.real.roas, 5);
  assert.equal(b.poas, 2);
  assert.equal(b.profitAfterAds, 30000);
  assert.equal(b.overReportPct, null);
  assert.equal(b.verdict, 'gana');
  const n = paidBlock({ spend: null, reportedValue: null, orders });
  assert.equal(n.real.roas, null);
  assert.equal(n.profitAfterAds, null);
  assert.equal(n.costPerSale, null);
  assert.equal(n.verdict, null);
});

test('attributedOrders filtra por los canales pedidos (por defecto solo Meta y Google)', () => {
  const docs = [1, 2, 3].map((i) => ({ sourceId: String(i), status: 'completed', date: '2026-11-10T15:00:00Z', total: 1000, items: [] }));
  const attribution = new Map([['1', { channel: 'meta' }], ['2', { channel: 'pinterest' }], ['3', { channel: 'email' }]]);
  assert.deepEqual(attributedOrders(docs, attribution, new Map(), 0.5).map((o) => o.channel), ['meta']);
  assert.deepEqual(attributedOrders(docs, attribution, new Map(), 0.5, ['pinterest', 'email']).map((o) => o.channel), ['pinterest', 'email']);
});
