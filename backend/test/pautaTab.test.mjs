import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adsBlock, pautaSummary, pautaDaily, adRankings, googleCampaigns } from '../pautaTab.mjs';

const empty = { cur: [], prev: [], year: [] };

test('adsBlock: empty platform has null ratios', () => {
  assert.deepEqual(adsBlock([]), { spend: 0, value: 0, purchases: 0, roas: null, costPerPurchase: null });
});

test('pautaSummary: combined total, google brand split', () => {
  const s = pautaSummary({
    meta: { ...empty, cur: [{ date: '2026-11-02', spend: 100, purchaseValue: 500, purchases: 5 }] },
    google: { ...empty, cur: [{ date: '2026-11-02', spend: 200, spendBrand: 50, purchaseValue: 1000, purchases: 4, ga4RevenueBrand: 600 }] },
  });
  assert.equal(s.total.spend, 300);
  assert.equal(s.total.value, 1500);
  assert.equal(s.total.roas, 5);
  assert.deepEqual(s.google.nonBrand, { spend: 150, value: 400, roas: 2.67 });
  assert.deepEqual(s.google.brand, { spend: 50, value: 600 });
  assert.equal(s.meta.costPerPurchase, 20);
  assert.equal(s.meta.vsPrev.spend, null);
});

test('pautaSummary: vs year adjusts money, never ROAS', () => {
  const meta = { cur: [{ spend: 200, purchaseValue: 400, purchases: 2 }], prev: [], year: [{ spend: 100, purchaseValue: 200, purchases: 1 }] };
  const adj = pautaSummary({ meta, google: empty, inflation: { currentIndex: 200, prevYearIndex: 100 } });
  assert.equal(adj.meta.vsYear.spend, 0);
  assert.equal(adj.meta.vsYear.roas, 0);
  assert.equal(adj.meta.yearAdjusted, true);
  const nom = pautaSummary({ meta, google: empty });
  assert.equal(nom.meta.vsYear.spend, 100);
  assert.equal(nom.meta.yearAdjusted, false);
});

test('pautaDaily: fills every day of the range', () => {
  const d = pautaDaily([{ date: '2026-11-03', spend: 10, purchaseValue: 30 }], [], { start: '2026-11-02', end: '2026-11-04' });
  assert.equal(d.bucket, 'day');
  assert.equal(d.rows.length, 3);
  assert.deepEqual(d.rows[1], { key: '2026-11-03', meta: { spend: 10, value: 30 }, google: { spend: 0, value: 0 } });
  assert.deepEqual(d.rows[0].meta, { spend: 0, value: 0 });
});

test('adRankings: tiny spenders stay out of best/worst', () => {
  const r = adRankings([
    { adId: 'A', adName: 'a', spend: 1000, purchaseValue: 3000, purchases: 3 },
    { adId: 'B', adName: 'b', spend: 5, purchaseValue: 500, purchases: 1 },
    { adId: 'C', adName: 'c', spend: 400, purchaseValue: 0, purchases: 0 },
  ]);
  assert.equal(r.best[0].adId, 'A');
  assert.ok(!r.best.some(a => a.adId === 'B'));
  assert.ok(!r.worst.some(a => a.adId === 'B'));
  assert.equal(r.worst[0].adId, 'C');
  assert.ok(r.spend.some(a => a.adId === 'B'));
});

test('googleCampaigns: joins cost and GA4 by name, flags brand', () => {
  const c = googleCampaigns(
    [{ name: 'altorancho_search_brand_aon', spend: 100, clicks: 10 }, { name: 'pmax', spend: 300, clicks: 30 }],
    [{ name: 'pmax', value: 900, purchases: 3 }, { name: 'otra', value: 50, purchases: 1 }],
  );
  assert.deepEqual(c.map(x => x.name), ['pmax', 'altorancho_search_brand_aon', 'otra']);
  assert.equal(c[0].roas, 3);
  assert.equal(c[1].brand, true);
  assert.equal(c[1].value, 0);
  assert.equal(c[1].roas, 0);
  assert.equal(c[2].spend, 0);
  assert.equal(c[2].roas, null);
});
