import { fetchGoogleAdsDaily, isGoogleAdsConfigured } from '../googleAds.mjs';
import { saveGoogleAdsDailyDocs, setSyncMetadata } from '../firestore.mjs';

function isoDate(d) { return d.toISOString().slice(0, 10); }

// Like Meta, Google keeps attributing conversions for weeks after the click,
// so every run re-fetches and overwrites the trailing `daysBack` days.
export async function syncGoogleAds({ daysBack = 30 } = {}) {
  if (!isGoogleAdsConfigured()) {
    console.log('[sync:googleAds] sin GOOGLE_ADS_SERVICE_ACCOUNT/GOOGLE_ADS_CUSTOMER_ID, salteado');
    return { dailyCount: 0, skipped: true };
  }
  const until = new Date();
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - daysBack);

  const docs = await fetchGoogleAdsDaily(isoDate(since), isoDate(until));
  await saveGoogleAdsDailyDocs(docs);
  await setSyncMetadata('googleAds', { lastSyncedAt: new Date().toISOString(), dailyCount: docs.length });

  console.log(`[sync:googleAds] ${docs.length} días`);
  return { dailyCount: docs.length };
}
