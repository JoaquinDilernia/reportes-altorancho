import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marginOf, orderGrossProfit, headline, withDeltas, verdict, attributedOrders, platforms, platformSpend, campaigns, daily, webSources,
} from '../pautaRealTab.mjs';

const costs = new Map([['A', 40], ['B', 10]]);
const doc = (o) => ({ status: 'completed', date: '2026-11-03T15:00:00.000Z', ...o });

test('marginOf: known cost vs unknown, coverage and ratio', () => {
  const m = marginOf([doc({ items: [{ sku: 'A', qty: 1, unitPrice: 100 }, { sku: 'X', qty: 1, unitPrice: 100 }] })], costs);
  assert.equal(m.costRatio, 0.4);
  assert.equal(m.costCoverage, 0.5);
});

test('orderGrossProfit: total minus cogs, unknown SKUs estimated with the fallback ratio', () => {
  const d = doc({ total: 180, items: [{ sku: 'A', qty: 2, unitPrice: 100 }] }); // 20 de descuento
  assert.equal(orderGrossProfit(d, costs, null), 100);
  const u = doc({ total: 100, items: [{ sku: 'X', qty: 1, unitPrice: 100 }] });
  assert.equal(orderGrossProfit(u, costs, 0.5), 50);
  assert.equal(orderGrossProfit(u, costs, null), 100);
});

test('headline: web + locales, gross profit after ads, MER', () => {
  const h = headline({
    webDocs: [doc({ total: 100, items: [{ sku: 'A', qty: 1, unitPrice: 100 }] }), doc({ status: 'cancelled', total: 999, items: [] })],
    localDocs: [doc({ total: 100, items: [{ sku: 'B', qty: 1, unitPrice: 100 }] })],
    spend: 50,
    costBySku: costs,
  });
  assert.equal(h.revenue, 200);
  assert.equal(h.grossProfit, 150);
  assert.equal(h.profitAfterAds, 100);
  assert.equal(h.merTotal, 4);
  assert.equal(h.merWeb, 2);
  assert.equal(h.adsShareOfRevenuePct, 25);
});

test('withDeltas: profit change is measured against the absolute previous value', () => {
  const r = withDeltas({ spend: 10, revenue: 10, grossProfit: 10, profitAfterAds: 50, merTotal: 1 }, { spend: 10, revenue: 10, grossProfit: 10, profitAfterAds: -100, merTotal: 1 });
  assert.equal(r.vsPrev.profitAfterAds, 150);
});

test('verdict: by POAS (gross profit / spend)', () => {
  assert.equal(verdict({ spend: 0, grossProfit: 0, sales: 0 }), null);
  assert.equal(verdict({ spend: 100, grossProfit: 0, sales: 0 }), 'sin-ventas');
  assert.equal(verdict({ spend: 100, grossProfit: 140, sales: 2 }), 'gana');
  assert.equal(verdict({ spend: 100, grossProfit: 110, sales: 2 }), 'justo');
  assert.equal(verdict({ spend: 100, grossProfit: 60, sales: 2 }), 'pierde');
});

test('platforms: reported vs real ROAS and POAS from attributed orders', () => {
  const web = [
    doc({ sourceId: '1', total: 100, items: [{ sku: 'A', qty: 1, unitPrice: 100 }] }),
    doc({ sourceId: '2', total: 100, items: [{ sku: 'B', qty: 1, unitPrice: 100 }] }),
    doc({ sourceId: '3', total: 100, items: [] }),
  ];
  const attribution = new Map([
    ['1', { channel: 'meta', campaignId: 'c1' }],
    ['2', { channel: 'google', campaignId: 'g1' }],
    ['3', { channel: 'organic' }],
  ]);
  const orders = attributedOrders(web, attribution, costs, null);
  assert.equal(orders.length, 2);
  const spendBy = platformSpend([{ spend: 50, purchaseValue: 400, purchases: 4 }], [{ spend: 100, purchaseValue: 100, purchases: 1 }]);
  const p = platforms({ spendBy, orders });
  assert.equal(p.meta.real.roas, 2);
  assert.equal(p.meta.reported.roas, 8);
  assert.equal(p.meta.overReportPct, 300);
  assert.equal(p.meta.poas, 1.2);
  assert.equal(p.meta.verdict, 'justo');
  assert.equal(p.google.poas, 0.9);
  assert.equal(p.google.verdict, 'pierde');
});

test('campaigns: join spend rows with attributed profit, drop rows with nothing', () => {
  const orders = [{ channel: 'meta', campaignId: 'c1', total: 300, grossProfit: 200 }];
  const rows = [{ id: 'c1', name: 'Cyber', spend: 100, metaRoas: 6 }, { id: 'c2', name: 'Vieja', spend: 0 }, { id: 'c3', name: 'Sin', spend: 40 }];
  const c = campaigns({ rows, orders, platform: 'meta' });
  assert.deepEqual(c.map((x) => x.id), ['c1', 'c3']);
  assert.equal(c[0].poas, 2);
  assert.equal(c[0].roas, 3);
  assert.equal(c[0].reportedRoas, 6);
  assert.equal(c[1].verdict, 'sin-ventas');
});

test('webSources: without gineza splits paid vs the rest', () => {
  const s = webSources({ webDocs: [doc({ total: 1000 })], orders: [{ channel: 'meta', total: 300 }], summaryChannels: null });
  assert.deepEqual(s.map((r) => [r.channel, r.revenue]), [['resto', 700], ['meta', 300], ['google', 0]]);
});

test('daily: fills every day, ART day of each sale', () => {
  const d = daily({
    range: { start: '2026-11-02', end: '2026-11-04' },
    webDocs: [doc({ date: '2026-11-04T01:00:00.000Z', total: 100, items: [{ sku: 'A', qty: 1, unitPrice: 100 }] })],
    localDocs: [],
    metaDaily: [{ date: '2026-11-03', spend: 20 }],
    googleDaily: [],
    costBySku: costs,
    fallback: null,
  });
  assert.equal(d.length, 3);
  assert.deepEqual(d[1], { date: '2026-11-03', spend: 20, web: 100, locales: 0, grossProfit: 60, profitAfterAds: 40 });
});
