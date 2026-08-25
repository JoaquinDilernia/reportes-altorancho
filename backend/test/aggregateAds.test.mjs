import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAdTotals, computeAdDailyBreakdown, computeTopAds } from '../aggregateAds.mjs';

function makeDailyRow(overrides) {
  return {
    date: '2026-08-18', spend: 1000, impressions: 10000, reach: 8000, clicks: 100,
    purchases: 2, purchaseValue: 5000, addToCart: 10, initiateCheckout: 5, landingPageViews: 50,
    currency: 'ARS',
    ...overrides,
  };
}

test('computeAdTotals sums raw metrics across days', () => {
  const rows = [makeDailyRow({}), makeDailyRow({ date: '2026-08-19', spend: 500, impressions: 5000, clicks: 50, purchases: 1, purchaseValue: 2000 })];
  const totals = computeAdTotals(rows);
  assert.equal(totals.spend, 1500);
  assert.equal(totals.impressions, 15000);
  assert.equal(totals.clicks, 150);
  assert.equal(totals.purchases, 3);
  assert.equal(totals.purchaseValue, 7000);
});

test('computeAdTotals derives ctr, cpc and roas from the summed totals, not averaged per-day', () => {
  const rows = [makeDailyRow({ spend: 1000, impressions: 10000, clicks: 100, purchaseValue: 5000 })];
  const totals = computeAdTotals(rows);
  assert.equal(totals.ctr, 1); // 100/10000 * 100
  assert.equal(totals.cpc, 10); // 1000/100
  assert.equal(totals.roas, 5); // 5000/1000
  assert.equal(totals.costPerPurchase, 500); // 1000/2
  assert.equal(totals.costPerAddToCart, 100); // 1000/10
});

test('computeAdTotals handles an empty period without dividing by zero', () => {
  const totals = computeAdTotals([]);
  assert.equal(totals.spend, 0);
  assert.equal(totals.ctr, 0);
  assert.equal(totals.cpc, 0);
  assert.equal(totals.roas, 0);
  assert.equal(totals.costPerPurchase, 0);
});

test('computeAdDailyBreakdown returns date/spend/purchases sorted ascending', () => {
  const rows = [
    makeDailyRow({ date: '2026-08-19', spend: 500, purchases: 1 }),
    makeDailyRow({ date: '2026-08-18', spend: 1000, purchases: 2 }),
  ];
  const breakdown = computeAdDailyBreakdown(rows);
  assert.deepEqual(breakdown, [
    { date: '2026-08-18', spend: 1000, purchases: 2 },
    { date: '2026-08-19', spend: 500, purchases: 1 },
  ]);
});

function makeAdDailyRow(overrides) {
  return {
    date: '2026-08-18', adId: 'A', adName: 'Ad A', campaignName: 'Campaign 1',
    spend: 1000, impressions: 10000, reach: 8000, clicks: 100,
    purchases: 2, purchaseValue: 5000, addToCart: 10, initiateCheckout: 5, landingPageViews: 50,
    currency: 'ARS',
    ...overrides,
  };
}

test('computeTopAds groups by adId across days and sorts by spend descending', () => {
  const rows = [
    makeAdDailyRow({ adId: 'A', spend: 1000, purchases: 2, purchaseValue: 5000 }),
    makeAdDailyRow({ adId: 'A', date: '2026-08-19', spend: 500, purchases: 1, purchaseValue: 2000 }),
    makeAdDailyRow({ adId: 'B', adName: 'Ad B', campaignName: 'Campaign 2', spend: 2000, purchases: 1, purchaseValue: 1000 }),
  ];
  const top = computeTopAds(rows, { limit: 10 });
  assert.equal(top.length, 2);
  assert.equal(top[0].adId, 'B'); // 2000 > 1500
  assert.equal(top[0].spend, 2000);
  assert.equal(top[1].adId, 'A');
  assert.equal(top[1].spend, 1500);
  assert.equal(top[1].purchases, 3);
  assert.equal(top[1].purchaseValue, 7000);
  assert.equal(top[1].roas, 7000 / 1500);
});

test('computeTopAds respects the limit', () => {
  const rows = [
    makeAdDailyRow({ adId: 'A', spend: 100 }),
    makeAdDailyRow({ adId: 'B', spend: 200 }),
    makeAdDailyRow({ adId: 'C', spend: 300 }),
  ];
  const top = computeTopAds(rows, { limit: 2 });
  assert.equal(top.length, 2);
  assert.deepEqual(top.map(a => a.adId), ['C', 'B']);
});
