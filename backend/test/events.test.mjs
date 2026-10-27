import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENTS, alignEventDays, projectInflationIndex, inflationFactor, dailyByChannel,
  weekdayBaseline, buildEventDays, summarizePastEvent, weekdayOf, baselineRange,
} from '../events.mjs';

test('alignEventDays: Cyber Monday lines up with Cyber Monday, same weekday', () => {
  const days = alignEventDays(EVENTS.cyber.current, EVENTS.cyber.previous);
  const monday = days.find(d => d.date === '2026-11-02');
  assert.equal(monday.refDate, '2025-11-03');
  assert.equal(monday.phase, 'oficial');
  for (const d of days.filter(d => !d.isLaunch)) assert.equal(weekdayOf(d.date), weekdayOf(d.refDate));
});

test('alignEventDays: launch day compares against last year launch day', () => {
  const days = alignEventDays(EVENTS.cyber.current, EVENTS.cyber.previous);
  assert.deepEqual(days[0], { date: '2026-10-29', refDate: '2025-10-29', phase: 'pre', isLaunch: true });
  assert.equal(days[1].refDate, '2025-10-31');
  assert.equal(days.at(-1).date, '2026-11-15');
  assert.equal(days.at(-1).phase, 'extension');
  assert.equal(days.length, 18);
});

test('projectInflationIndex: published month returned as-is', () => {
  const idx = new Map([['2026-05', 100], ['2026-06', 102], ['2026-07', 104], ['2026-08', 106]]);
  assert.deepEqual(projectInflationIndex(idx, '2026-07'), { index: 104, projected: false });
});

test('projectInflationIndex: missing month compounds the last 3 months average rate', () => {
  const idx = new Map([['2026-05', 100], ['2026-06', 110], ['2026-07', 121], ['2026-08', 133.1]]);
  const r = projectInflationIndex(idx, '2026-10');
  assert.equal(r.projected, true);
  assert.ok(Math.abs(r.index - 161.051) < 1e-6);
});

test('inflationFactor: ratio of target to reference month', () => {
  const idx = new Map([['2025-11', 100], ['2026-11', 132]]);
  assert.deepEqual(inflationFactor(idx, '2025-11', '2026-11'), { factor: 1.32, projected: false });
});

test('weekdayBaseline: averages per weekday, counting empty days as zero', () => {
  // 2026-09-07 is a Monday
  const map = new Map([['2026-09-07', { revenue: 100, orders: 1 }]]);
  const b = weekdayBaseline(map, '2026-09-07', '2026-09-20');
  assert.equal(b[1], 50);
  assert.equal(b[2], 0);
});

function sale(channel, iso, total, status = 'completed') {
  return { channel, date: iso, total, status, items: [] };
}

test('buildEventDays: target = last year aligned day × inflation × growth; no-history channel uses baseline', () => {
  const current = { start: '2026-11-02', end: '2026-11-03', officialStart: '2026-11-02', officialEnd: '2026-11-03' };
  const previous = { start: '2025-11-03', end: '2025-11-04', officialStart: '2025-11-03', officialEnd: '2025-11-04' };
  const prevDaily = dailyByChannel([
    sale('ecommerce', '2025-11-03T15:00:00Z', 1000),
    sale('local_lomas', '2025-11-03T15:00:00Z', 200),
    sale('ecommerce', '2025-11-03T16:00:00Z', 999, 'cancelled'),
  ]);
  const currentDaily = dailyByChannel([sale('ecommerce', '2026-11-02T15:00:00Z', 1500)]);
  // Alcorta: 8 weeks before 2026-11-02 → only Mondays sold 80 each
  const baselineDocs = [];
  for (let i = 1; i <= 8; i++) {
    const d = new Date(Date.UTC(2026, 10, 2 - 7 * i, 15));
    baselineDocs.push(sale('local_alcorta', d.toISOString(), 80));
  }
  const res = buildEventDays({
    current, previous, prevDaily, currentDaily,
    baselineDaily: dailyByChannel(baselineDocs),
    indexByMonth: new Map([['2025-11', 100], ['2026-11', 130]]),
    growth: { web: 0.1, locales: 0.05 },
    today: '2026-11-02',
  });
  const [mon, tue] = res.days;
  assert.ok(Math.abs(mon.web.target - 1000 * 1.3 * 1.1) < 1e-6);
  assert.equal(mon.web.revenue, 1500);
  assert.ok(Math.abs(mon.locales.target - (200 * 1.3 * 1.05 + 80)) < 1e-6);
  assert.equal(tue.web.revenue, null);
  assert.equal(tue.played, false);
  assert.deepEqual(res.channelsWithoutHistory, ['local_belgrano', 'local_alcorta']);
  assert.equal(res.totals.web.revenue, 1500);
  assert.ok(Math.abs(res.totals.web.targetToDate - 1430) < 1e-6);
});

test('summarizePastEvent: peak day, lift vs normal days, official share and hourly in ART', () => {
  const window = { start: '2025-11-02', end: '2025-11-03', officialStart: '2025-11-03', officialEnd: '2025-11-03' };
  const docs = [
    sale('ecommerce', '2025-11-02T15:00:00Z', 100),
    sale('ecommerce', '2025-11-03T23:30:00Z', 300), // 20:30 ART
  ];
  const baseline = [sale('ecommerce', '2025-10-20T15:00:00Z', 50), sale('ecommerce', '2025-10-21T15:00:00Z', 50)];
  const r = summarizePastEvent(docs, baseline, window);
  assert.equal(r.revenue, 400);
  assert.equal(r.peakDay.date, '2025-11-03');
  assert.equal(r.lift, 4);
  assert.equal(r.officialSharePct, 75);
  assert.equal(r.hourly[20].revenue, 300);
});

test('baselineRange: 8 weeks ending the day before the event, or yesterday if the event is further away', () => {
  assert.deepEqual(baselineRange({ start: '2026-10-29' }, '2026-11-20'), { start: '2026-09-03', end: '2026-10-28' });
  assert.deepEqual(baselineRange({ start: '2026-11-26' }, '2026-10-27'), { start: '2026-09-01', end: '2026-10-26' });
});

import { allocateWithBounds, adsByDate, attributionShares, buildInvestmentPlan } from '../events.mjs';
import { normalizeGoogleAdsDaily, GA4_SWITCH_DATE } from '../googleAds.mjs';

test('allocateWithBounds: spreads proportionally, caps big days and lifts small ones to the floor', () => {
  const r = allocateWithBounds([1, 1, 10, 1], 16, 2, 6);
  assert.deepEqual(r.map(x => Math.round(x * 100) / 100), [3.33, 3.33, 6, 3.33]);
  assert.ok(Math.abs(r.reduce((a, b) => a + b, 0) - 16) < 1e-9);
});

test('attributionShares: platform-reported value over real web revenue', () => {
  const ads = adsByDate(
    [{ date: '2026-10-01', spend: 10, purchaseValue: 30 }],
    [{ date: '2026-10-01', spend: 10, purchaseValue: 50 }],
  );
  const web = new Map([['2026-10-01', { revenue: 100, orders: 1 }]]);
  assert.deepEqual(attributionShares(ads, web, '2026-10-01', '2026-10-01'), { meta: 0.3, google: 0.5 });
});

test('buildInvestmentPlan: budget follows last year demand, split tilts to the platform that lifted more, ROAS target ties to the web target', () => {
  const days = [
    { date: '2026-11-01', refDate: '2025-11-02', phase: 'pre', isLaunch: true, web: { prevRevenue: 10, target: 13 } },
    { date: '2026-11-02', refDate: '2025-11-03', phase: 'oficial', isLaunch: false, web: { prevRevenue: 300, target: 400 } },
    { date: '2026-11-03', refDate: '2025-11-04', phase: 'extension', isLaunch: false, web: { prevRevenue: 100, target: 130 } },
  ];
  // baseline: both platforms ROAS 2; official day: meta ROAS 8 (4x lift), google ROAS 4 (2x)
  const prevAds = adsByDate(
    [{ date: '2025-10-20', spend: 1, purchaseValue: 2 }, { date: '2025-11-03', spend: 1, purchaseValue: 8 }, { date: '2025-11-04', spend: 1, purchaseValue: 2 }],
    [{ date: '2025-10-20', spend: 1, purchaseValue: 2 }, { date: '2025-11-03', spend: 1, purchaseValue: 4 }, { date: '2025-11-04', spend: 1, purchaseValue: 2 }],
  );
  const plan = buildInvestmentPlan({
    days,
    current: { dailyAdBudget: 4, launchHours: 6 },
    prevAds,
    prevBaselineDates: ['2025-10-20'],
    shares: { meta: 0.2, google: 0.3 },
  });
  const [launch, official, ext] = plan.days;
  assert.equal(launch.spend, 1);
  assert.ok(official.spend > ext.spend);
  assert.ok(Math.abs(official.spend + ext.spend - 8) < 1e-9);
  const oficial = plan.phases.find(p => p.phase === 'oficial');
  assert.ok(Math.abs(oficial.metaShare - 0.65) < 1e-9); // 0.5 × 4 / 3 = 0.667 → capped at 0.65
  assert.ok(Math.abs(official.roasTarget.meta - (0.2 * 400) / official.meta) < 1e-9);
  assert.equal(plan.phases.find(p => p.phase === 'extension').metaShare, 0.5);
});

test('buildInvestmentPlan: one flat, rounded daily amount per phase even when last year zig-zagged', () => {
  const day = (date, phase, prevRevenue) => ({ date, refDate: date, phase, isLaunch: false, web: { prevRevenue, target: prevRevenue } });
  const days = [
    day('2026-10-30', 'pre', 120), day('2026-10-31', 'pre', 60), day('2026-11-01', 'pre', 100),
    day('2026-11-02', 'oficial', 400), day('2026-11-03', 'oficial', 300),
    day('2026-11-04', 'extension', 90), day('2026-11-05', 'extension', 150),
  ];
  const plan = buildInvestmentPlan({
    days,
    current: { dailyAdBudget: 4_000_000 },
    prevAds: adsByDate([], []),
    prevBaselineDates: [],
    shares: { meta: 0.2, google: 0.3 },
  });
  const byPhase = (phase) => plan.days.filter(d => d.phase === phase).map(d => d.spend);
  for (const phase of ['pre', 'oficial', 'extension']) assert.equal(new Set(byPhase(phase)).size, 1, phase);
  assert.ok(byPhase('oficial')[0] > byPhase('pre')[0]);
  for (const d of plan.days) {
    assert.equal(d.spend % 100_000, 0);
    assert.equal(d.meta % 100_000, 0);
  }
});

test('normalizeGoogleAdsDaily: Tiendanube purchase before the GA4 switch, GA4 purchase after', () => {
  const names = { a: 'Tiendanube Website purchases', b: 'ALTORANCHO - GA4 (web) purchase', c: 'Clics de llamada' };
  const cost = [
    { segments: { date: '2025-11-03' }, metrics: { costMicros: '2000000', clicks: '5', impressions: '100' } },
    { segments: { date: GA4_SWITCH_DATE }, metrics: { costMicros: '1000000' } },
  ];
  const conv = [
    { segments: { date: '2025-11-03', conversionAction: 'a' }, metrics: { allConversions: 2, allConversionsValue: 50 } },
    { segments: { date: '2025-11-03', conversionAction: 'c' }, metrics: { allConversions: 9, allConversionsValue: 0 } },
    { segments: { date: GA4_SWITCH_DATE, conversionAction: 'a' }, metrics: { allConversions: 1, allConversionsValue: 10 } },
    { segments: { date: GA4_SWITCH_DATE, conversionAction: 'b' }, metrics: { allConversions: 3, allConversionsValue: 30 } },
  ];
  const [old, recent] = normalizeGoogleAdsDaily(cost, conv, names);
  assert.equal(old.spend, 2);
  assert.equal(old.purchaseValue, 50);
  assert.equal(old.purchases, 2);
  assert.equal(recent.purchaseValue, 30);
  assert.equal(recent.purchaseValueTn, 10);
});

import { normalizeGa4GoogleAdsRows } from '../ga4.mjs';

test('Google: GA4 google / cpc revenue replaces Ads conversion value; brand campaigns tracked apart', () => {
  const ga4 = normalizeGa4GoogleAdsRows([
    { dimensionValues: [{ value: '20251103' }, { value: 'altorancho_search_brand_aon' }], metricValues: [{ value: '4' }, { value: '400' }] },
    { dimensionValues: [{ value: '20251103' }, { value: 'weare_pmax_muebles' }], metricValues: [{ value: '1' }, { value: '100' }] },
  ]);
  assert.deepEqual(ga4.get('2025-11-03'), { revenue: 500, purchases: 5, revenueBrand: 400, purchasesBrand: 4 });
  const cost = [
    { campaign: { name: 'altorancho_search_brand_aon' }, segments: { date: '2025-11-03' }, metrics: { costMicros: '1000000' } },
    { campaign: { name: 'weare_pmax_muebles' }, segments: { date: '2025-11-03' }, metrics: { costMicros: '3000000' } },
  ];
  const conv = [{ segments: { date: '2025-11-03', conversionAction: 'a' }, metrics: { allConversions: 9, allConversionsValue: 9000 } }];
  const [doc] = normalizeGoogleAdsDaily(cost, conv, { a: 'Tiendanube Website purchases' }, ga4);
  assert.equal(doc.spend, 4);
  assert.equal(doc.spendBrand, 1);
  assert.equal(doc.purchaseValue, 500);
  assert.equal(doc.purchaseValueTn, 9000);
  assert.equal(doc.ga4RevenueBrand, 400);
});

test('buildInvestmentPlan: a split set in the event config wins over the suggested one', () => {
  const days = [{ date: '2026-11-02', refDate: '2025-11-03', phase: 'oficial', isLaunch: false, web: { prevRevenue: 100, target: 130 } }];
  const plan = buildInvestmentPlan({
    days,
    current: { dailyAdBudget: 10, metaShare: 0.6 },
    prevAds: adsByDate([], []),
    prevBaselineDates: [],
    shares: { meta: 0.2, google: 0.3 },
  });
  assert.equal(plan.days[0].meta, 6);
  assert.equal(plan.days[0].google, 4);
  const p = plan.phases.find(x => x.phase === 'oficial');
  assert.equal(p.splitFromConfig, true);
  assert.equal(p.suggestedMetaShare, 0.5);
});
