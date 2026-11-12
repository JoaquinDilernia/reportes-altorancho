// Daily snapshots of what the sources don't keep: Clarity (its API only has
// the last 1–3 days) and the web stock (Tiendanube/Odoo only know "now").
// Cron at 00:05, 06:00 and 12:00 ART; the later runs only fill a missing day.
import { argDay } from './events.mjs';
import {
  CLARITY_DAILY_COL, WEB_STOCK_DAILY_COL, saveDailySnapshot, getDailySnapshot, getProductsBySku,
} from './firestore.mjs';
import { fetchClarityLast24h, isClarityConfigured, shapeClarityTotals, shapeClarityPages } from './clarity.mjs';

// The day a run snapshots: the Argentine day of (now − 13 h), so the three
// runs (00:05, 06:00, 12:00 ART) all refer to the day that just ended.
export function snapshotDateFor(now) {
  return argDay(new Date(now.getTime() - 13 * 3600 * 1000).toISOString());
}

export function claritySnapshotDoc(totalsResp, byUrlResp, date) {
  return {
    date,
    totals: shapeClarityTotals(totalsResp),
    pages: shapeClarityPages(byUrlResp, { limit: 50, minSessions: 10 }),
  };
}

// Every SKU whose web stock is known — zeros included, since the days at 0
// are the point. Gift cards carry a fake 100M stock.
export function webStockSnapshotDoc(productsBySku, date) {
  const bySku = {};
  for (const p of productsBySku.values()) {
    if (p?.currentStock == null || /^GFT/i.test(p.sku)) continue;
    bySku[p.sku] = Math.max(0, p.currentStock);
  }
  return { date, bySku };
}

async function snapshotOnce(col, date, build) {
  try {
    if (await getDailySnapshot(col, date)) return 'exists';
    const data = await build();
    if (!data) return 'skipped';
    await saveDailySnapshot(col, date, data);
    return 'saved';
  } catch (err) {
    console.error(`[snapshots] ${col} ${date}:`, err.message);
    return 'error';
  }
}

export async function takeDailySnapshots({ now = new Date() } = {}) {
  const date = snapshotDateFor(now);
  const clarity = await snapshotOnce(CLARITY_DAILY_COL, date, async () => {
    if (!isClarityConfigured()) return null;
    const { totalsResp, byUrlResp } = await fetchClarityLast24h();
    return claritySnapshotDoc(totalsResp, byUrlResp, date);
  });
  const stock = await snapshotOnce(WEB_STOCK_DAILY_COL, date, async () => webStockSnapshotDoc(await getProductsBySku(), date));
  console.log(`[snapshots] ${date}: clarity=${clarity} stock=${stock}`);
  return { clarity, stock };
}
