import 'dotenv/config';

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;
const ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;

// Splits [since, until] into consecutive windows of at most maxDays each, so
// a single Insights API call never spans an unbounded date range (Meta's
// practical limit for time_increment=1 queries is well under a year).
export function chunkDateRange(since, until, maxDays = 90) {
  const chunks = [];
  const end = new Date(`${until}T00:00:00Z`);
  let start = new Date(`${since}T00:00:00Z`);

  while (start <= end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({
      since: start.toISOString().slice(0, 10),
      until: chunkEnd.toISOString().slice(0, 10),
    });

    start = new Date(chunkEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }

  return chunks;
}

// Meta's `actions`/`action_values` fields are arrays of { action_type, value }
// instead of flat fields; this pulls one metric out by its action_type,
// defaulting to 0 when the array is missing (no activity that day/ad) or the
// action_type didn't occur.
export function extractActionValue(actions, actionType) {
  if (!actions) return 0;
  const match = actions.find(a => a.action_type === actionType);
  return match ? Number(match.value) : 0;
}

// Converts a Meta Ads Insights API row (account-level or ad-level) to the
// normalized shape for storage: string dates and spend become Date and Number,
// action arrays flatten to named fields, and field names follow our storage
// naming conventions (camelCase, omni_* → specific names).
export function normalizeDailyInsightRow(row, currency) {
  return {
    date: row.date_start,
    spend: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks: Number(row.clicks || 0),
    purchases: extractActionValue(row.actions, 'omni_purchase'),
    purchaseValue: extractActionValue(row.action_values, 'omni_purchase'),
    addToCart: extractActionValue(row.actions, 'omni_add_to_cart'),
    initiateCheckout: extractActionValue(row.actions, 'omni_initiated_checkout'),
    landingPageViews: extractActionValue(row.actions, 'omni_landing_page_view'),
    currency,
  };
}

// Adds ad identity fields (adId, adName, campaignName, adsetName) on top of
// the normalized daily shape, spreading normalizeDailyInsightRow to avoid
// duplicating conversion logic.
export function normalizeAdDailyInsightRow(row, currency) {
  return {
    ...normalizeDailyInsightRow(row, currency),
    adId: row.ad_id,
    adName: row.ad_name,
    campaignName: row.campaign_name,
    adsetName: row.adset_name,
  };
}
