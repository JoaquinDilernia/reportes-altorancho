import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts } from '../alerts.mjs';
import { ALERTS } from '../alertConfig.mjs';

const none = { period: 'week', days: 7, locales: null, coverage: null, behavior: null, clarity: null, origins: null };
const alcorta = { id: 'alcorta', label: 'Alcorta', revenue: 29e6, baselineRevenue: 35e6, orders: 80, baselineOrders: 101, avgTicket: 362e3, baselineAvgTicket: 346e3 };
const behaviorWith = ({ lowConversion = [], channels = [] } = {}) => ({
  totals: { cur: { sessions: 100000, conversion: 0.0043 } },
  channels,
  items: { lowConversion },
});
const crossNetwork = { key: 'Cross-network', cur: { sessions: 57000, purchases: 46, conversion: 0.0008 } };
const lowItem = { name: 'Reposera Tahití', views: 4733, carts: 60, purchases: 3, buyRate: 3 / 4733 };
const origin = (id, label, cur, prev) => ({ id, label, cur: { revenue: cur }, prev: { revenue: prev } });

test('config: thresholds', () => {
  assert.equal(ALERTS.maxAlerts, 6);
  assert.equal(ALERTS.localDropPct, 0.15);
  assert.deepEqual(ALERTS.localBaselinePeriods, { week: 8, month: 3, custom: 8 });
  assert.equal(ALERTS.coverageMinWeeklyUnits, 1);
});

test('all inputs null → no alerts', () => {
  assert.deepEqual(buildAlerts(none), []);
});

test('local: −17% vs baseline → red alert naming the store; −11% → nothing', () => {
  const [a, ...rest] = buildAlerts({ ...none, locales: [alcorta] });
  assert.equal(rest.length, 0);
  assert.equal(a.kind, 'local');
  assert.equal(a.tone, 'r');
  assert.equal(a.tab, 'locales');
  assert.match(a.title, /Alcorta/);
  assert.match(a.title, /17%/);
  assert.match(a.detail, /bajaron los tickets/i);
  assert.deepEqual(buildAlerts({ ...none, locales: [{ ...alcorta, revenue: 31e6 }] }), []);
});

test('stock: one alert summarising the products running out', () => {
  const coverage = [
    { sku: 'A', name: 'Silla A', group: 'rolon', weeklyUnits: 12, dailyRevenue: 678853 },
    { sku: 'B', name: 'Silla B', group: 'rolon', weeklyUnits: 3, dailyRevenue: 900000 },
    { sku: 'C', name: 'Mesa C', group: 'local', weeklyUnits: 1, dailyRevenue: 1000 },
    { sku: 'D', name: 'Raro D', group: 'rolon', weeklyUnits: 0.5, dailyRevenue: 9e6 },
  ];
  const alerts = buildAlerts({ ...none, coverage });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'stock');
  assert.equal(alerts[0].tab, 'producto');
  assert.match(alerts[0].title, /3 productos/);
  assert.match(alerts[0].detail, /2 en Rolón/);
  assert.match(alerts[0].detail, /Silla B/);
  assert.doesNotMatch(alerts[0].detail, /Raro D/);
  assert.deepEqual(buildAlerts({ ...none, coverage: [coverage[3]] }), []);
  assert.deepEqual(buildAlerts({ ...none, coverage: [] }), []);
});

test('web: lots of views, few sales — threshold scales with the period length', () => {
  const [a] = buildAlerts({ ...none, behavior: behaviorWith({ lowConversion: [lowItem] }) });
  assert.equal(a.kind, 'web');
  assert.equal(a.tab, 'web');
  assert.match(a.title, /Reposera Tahití/);
  assert.deepEqual(buildAlerts({ ...none, days: 14, behavior: behaviorWith({ lowConversion: [{ ...lowItem, views: 3000 }] }) }), []);
});

test('web: a traffic source with lots of sessions that barely converts', () => {
  const [a] = buildAlerts({ ...none, behavior: behaviorWith({ channels: [crossNetwork] }) });
  assert.equal(a.kind, 'web');
  assert.match(a.title, /Cross-network/);
  assert.match(a.title, /57%/);
  assert.match(a.detail, /0,43%/);
});

test('web: Clarity page with frustration clicks; null clarity → nothing', () => {
  const clarity = [{ date: '2026-11-10', pages: [{ path: '/sillas/', sessions: 500, rage: 8, dead: 3 }, { path: '/x/', sessions: 50, rage: 40, dead: 0 }] }];
  const alerts = buildAlerts({ ...none, clarity });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'web');
  assert.match(alerts[0].title, /\/sillas\//);
  assert.deepEqual(buildAlerts({ ...none, clarity: null }), []);
});

test('origin: a big move up is good news; −14% stays quiet', () => {
  const alerts = buildAlerts({ ...none, origins: [origin('importado', 'Importado', 501, 352), origin('fabrica', 'Fábrica', 86, 100)] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'bien');
  assert.equal(alerts[0].tone, 'g');
  assert.match(alerts[0].title, /Importado/);
  assert.match(alerts[0].title, /\+42%/);
});

test('cut at maxAlerts, keeping one piece of good news', () => {
  const locales = ['Alcorta', 'Lomas', 'Belgrano', 'Mayorista'].map((label, i) => ({ ...alcorta, id: `l${i}`, label }));
  const alerts = buildAlerts({
    ...none, locales,
    coverage: [{ sku: 'A', name: 'A', group: 'rolon', weeklyUnits: 5, dailyRevenue: 1 }],
    behavior: behaviorWith({ lowConversion: [lowItem], channels: [crossNetwork] }),
    origins: [origin('importado', 'Importado', 501, 352)],
  });
  assert.equal(alerts.length, 6);
  assert.deepEqual(alerts.map(a => a.kind), ['local', 'local', 'local', 'local', 'stock', 'bien']);
});
