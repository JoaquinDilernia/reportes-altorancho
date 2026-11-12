// Pauta tab (new report): Meta and Google together. Pure — the IO lives in
// pautaReport.mjs. Meta value = 1d_click purchases; Google value = GA4
// purchaseRevenue for google / cpc (already in the daily docs' purchaseValue).
import { computeDelta, computeInflationAdjustedDelta } from './aggregate.mjs';
import { addDays, weekdayOf } from './events.mjs';
import { BRAND_CAMPAIGN_PATTERN } from './ga4.mjs';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const sum = (rows, key) => (rows || []).reduce((s, r) => s + (r[key] || 0), 0);
const pctDelta = (cur, prev) => (cur == null || prev == null ? null : computeDelta(cur, prev).pct);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const mondayOf = (day) => addDays(day, -((weekdayOf(day) + 6) % 7));

export function adsBlock(rows) {
  const spend = sum(rows, 'spend');
  const value = sum(rows, 'purchaseValue');
  const purchases = sum(rows, 'purchases');
  return {
    spend, value, purchases,
    roas: spend ? round(value / spend) : null,
    costPerPurchase: purchases ? spend / purchases : null,
  };
}

function compared({ cur, prev, year }, inflation = {}) {
  const c = adsBlock(cur);
  const p = adsBlock(prev);
  const y = adsBlock(year);
  const { currentIndex, prevYearIndex } = inflation;
  const money = (key) => {
    if (c[key] == null || y[key] == null) return null;
    const adj = computeInflationAdjustedDelta(c[key], y[key], currentIndex, prevYearIndex);
    return adj ? adj.pct : pctDelta(c[key], y[key]);
  };
  return {
    ...c,
    vsPrev: { spend: pctDelta(c.spend, p.spend), value: pctDelta(c.value, p.value), roas: pctDelta(c.roas, p.roas), costPerPurchase: pctDelta(c.costPerPurchase, p.costPerPurchase) },
    vsYear: { spend: money('spend'), value: money('value'), roas: pctDelta(c.roas, y.roas), costPerPurchase: money('costPerPurchase') },
    yearAdjusted: !!(currentIndex && prevYearIndex),
  };
}

export function pautaSummary({ meta, google, inflation = {} }) {
  const both = (k) => [...(meta[k] || []), ...(google[k] || [])];
  const g = compared(google, inflation);
  const brandSpend = sum(google.cur, 'spendBrand');
  const brandValue = sum(google.cur, 'ga4RevenueBrand');
  const nbSpend = g.spend - brandSpend;
  const nbValue = g.value - brandValue;
  return {
    meta: compared(meta, inflation),
    google: {
      ...g,
      brand: { spend: brandSpend, value: brandValue },
      nonBrand: { spend: nbSpend, value: nbValue, roas: nbSpend ? round(nbValue / nbSpend) : null },
    },
    total: compared({ cur: both('cur'), prev: both('prev'), year: both('year') }, inflation),
  };
}

// Spend and value per day (per week past 45 days) and platform.
export function pautaDaily(metaRows, googleRows, { start, end }) {
  const bucket = daysBetween(start, end) + 1 > 45 ? 'week' : 'day';
  const keyOf = (day) => (bucket === 'week' ? mondayOf(day) : day);
  const rows = new Map();
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const key = keyOf(day);
    if (!rows.has(key)) rows.set(key, { key, meta: { spend: 0, value: 0 }, google: { spend: 0, value: 0 } });
  }
  const add = (list, side) => {
    for (const r of list || []) {
      const row = rows.get(keyOf(r.date));
      if (!row) continue;
      row[side].spend += r.spend || 0;
      row[side].value += r.purchaseValue || 0;
    }
  };
  add(metaRows, 'meta');
  add(googleRows, 'google');
  return { bucket, rows: [...rows.values()] };
}

// Meta ads: top by spend, and best/worst by ROAS among ads that carry at
// least `minSpendShare` of the spend (a $500 ad with one lucky sale isn't "best").
export function adRankings(adDailyRows, { limit = 10, minSpendShare = 0.01 } = {}) {
  const byAd = new Map();
  for (const r of adDailyRows || []) {
    const a = byAd.get(r.adId) ?? { adId: r.adId, adName: r.adName, campaignName: r.campaignName, spend: 0, value: 0, purchases: 0, clicks: 0, impressions: 0 };
    a.spend += r.spend || 0;
    a.value += r.purchaseValue || 0;
    a.purchases += r.purchases || 0;
    a.clicks += r.clicks || 0;
    a.impressions += r.impressions || 0;
    a.adName = r.adName ?? a.adName;
    a.campaignName = r.campaignName ?? a.campaignName;
    byAd.set(r.adId, a);
  }
  const ads = [...byAd.values()].map(a => ({
    ...a,
    roas: a.spend ? round(a.value / a.spend) : null,
    costPerPurchase: a.purchases ? a.spend / a.purchases : null,
  }));
  const total = ads.reduce((s, a) => s + a.spend, 0);
  const eligible = ads.filter(a => a.spend > 0 && a.spend >= total * minSpendShare);
  return {
    spend: [...ads].sort((a, b) => b.spend - a.spend).slice(0, limit),
    best: [...eligible].sort((a, b) => b.roas - a.roas).slice(0, limit),
    worst: [...eligible].sort((a, b) => a.roas - b.roas).slice(0, limit),
  };
}

// Google campaigns: cost from Google Ads, value from GA4 (google / cpc),
// joined by campaign name.
export function googleCampaigns(costRows, ga4Rows) {
  const by = new Map();
  const get = (name) => {
    if (!by.has(name)) by.set(name, { name, brand: BRAND_CAMPAIGN_PATTERN.test(name || ''), spend: 0, clicks: 0, value: 0, purchases: 0 });
    return by.get(name);
  };
  for (const r of costRows || []) { const c = get(r.name); c.spend += r.spend || 0; c.clicks += r.clicks || 0; }
  for (const r of ga4Rows || []) { const c = get(r.name); c.value += r.value || 0; c.purchases += r.purchases || 0; }
  return [...by.values()]
    .map(c => ({ ...c, roas: c.spend ? round(c.value / c.spend) : null }))
    .sort((a, b) => b.spend - a.spend || b.value - a.value);
}
