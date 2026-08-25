import {
  fetchAccountCurrency, fetchAccountDailyInsights, fetchAdDailyInsights,
  normalizeDailyInsightRow, normalizeAdDailyInsightRow,
} from '../meta.mjs';
import { saveMetaAdsDailyDocs, saveMetaAdsAdDailyDocs, setSyncMetadata } from '../firestore.mjs';

function isoDate(d) { return d.toISOString().slice(0, 10); }

// Unlike the Tiendanube/Odoo syncs (incremental "since last sync"), Meta
// attributes conversions retroactively (up to a 7-day click window), so
// every run re-fetches and overwrites the trailing `daysBack` days rather
// than just the newest day.
export async function syncMetaAds({ daysBack = 30, includeAdLevel = true } = {}) {
  const until = new Date();
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - daysBack);

  const currency = await fetchAccountCurrency();

  const dailyRows = await fetchAccountDailyInsights(isoDate(since), isoDate(until));
  const dailyDocs = dailyRows.map(row => normalizeDailyInsightRow(row, currency));
  await saveMetaAdsDailyDocs(dailyDocs);

  let adDailyDocs = [];
  if (includeAdLevel) {
    const adRows = await fetchAdDailyInsights(isoDate(since), isoDate(until));
    adDailyDocs = adRows.map(row => normalizeAdDailyInsightRow(row, currency));
    await saveMetaAdsAdDailyDocs(adDailyDocs);
  }

  await setSyncMetadata('metaAds', {
    lastSyncedAt: new Date().toISOString(),
    dailyCount: dailyDocs.length,
    adDailyCount: adDailyDocs.length,
  });

  console.log(`[sync:metaAds] ${dailyDocs.length} días, ${adDailyDocs.length} filas de anuncios`);
  return { dailyCount: dailyDocs.length, adDailyCount: adDailyDocs.length };
}
