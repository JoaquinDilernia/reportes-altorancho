import crypto from 'node:crypto';
import { BRAND_CAMPAIGN_PATTERN } from './ga4.mjs';

// Google Ads API (REST v24) with a service account — same approach as the
// altorancho-ventas backend (gineza-agent), which proved it works without a
// developer token. Shares that account's daily quota (2,880 ops), so keep
// the number of queries per sync tiny: account-level rows only.
const BASE = 'https://googleads.googleapis.com/v24/';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google Ads' own purchase conversions, kept for reference only: their
// attribution (30–90 day click, 15 day view, data-driven) isn't comparable
// with Meta's 1-day click, and the action that tracked sales changed in
// Mar 2026 ("Tiendanube Website purchases" → "GA4 purchase"). The value the
// report uses for Google is GA4's google / cpc revenue (see ga4.mjs), which
// is how marketing measures it.
export const TN_PURCHASE_ACTION = 'Tiendanube Website purchases';
export const GA4_PURCHASE_ACTION = 'ALTORANCHO - GA4 (web) purchase';
export const GA4_SWITCH_DATE = '2026-03-01';

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const sa = JSON.parse(process.env.GOOGLE_ADS_SERVICE_ACCOUNT);
  const iat = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Google Ads token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function search(query) {
  const cid = String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, '');
  const out = [];
  let pageToken;
  do {
    const res = await fetch(`${BASE}customers/${cid}/googleAds:search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(`Google Ads ${json.error?.code || res.status}: ${json.error?.message || `HTTP ${res.status}`}`);
    }
    out.push(...(json.results || []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

export function isGoogleAdsConfigured() {
  return Boolean(process.env.GOOGLE_ADS_SERVICE_ACCOUNT && process.env.GOOGLE_ADS_CUSTOMER_ID);
}

function adsPurchaseValue(doc) {
  return doc.date >= GA4_SWITCH_DATE ? doc.purchaseValueGa4 : doc.purchaseValueTn;
}

function adsPurchases(doc) {
  return doc.date >= GA4_SWITCH_DATE ? doc.purchasesGa4 : doc.purchasesTn;
}

// GA4 revenue when GA4 data was merged in for the day; Google Ads' own
// conversion value otherwise.
export function googlePurchaseValue(doc) {
  return doc.ga4Revenue ?? adsPurchaseValue(doc);
}

export function googlePurchases(doc) {
  return doc.ga4Purchases ?? adsPurchases(doc);
}

// Joins the per-campaign cost rows, per-conversion-action rows and (when
// available) GA4's google / cpc results into one doc per day.
// `actionNames` maps conversion_action resource names to names.
export function normalizeGoogleAdsDaily(costRows, conversionRows, actionNames, ga4ByDate = null) {
  const byDate = new Map();
  const get = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date, spend: 0, spendBrand: 0, clicks: 0, impressions: 0,
        purchaseValueTn: 0, purchasesTn: 0, purchaseValueGa4: 0, purchasesGa4: 0, currency: 'ARS',
      });
    }
    return byDate.get(date);
  };
  for (const r of costRows) {
    const d = get(r.segments.date);
    const cost = Number(r.metrics.costMicros || 0) / 1e6;
    d.spend += cost;
    if (BRAND_CAMPAIGN_PATTERN.test(r.campaign?.name || '')) d.spendBrand += cost;
    d.clicks += Number(r.metrics.clicks || 0);
    d.impressions += Number(r.metrics.impressions || 0);
  }
  for (const r of conversionRows) {
    const name = actionNames[r.segments.conversionAction];
    const value = Number(r.metrics.allConversionsValue || 0);
    const count = Number(r.metrics.allConversions || 0);
    const d = get(r.segments.date);
    if (name === TN_PURCHASE_ACTION) { d.purchaseValueTn += value; d.purchasesTn += count; }
    if (name === GA4_PURCHASE_ACTION) { d.purchaseValueGa4 += value; d.purchasesGa4 += count; }
  }
  if (ga4ByDate) {
    for (const [date, g] of ga4ByDate) {
      const d = get(date);
      d.ga4Revenue = g.revenue;
      d.ga4Purchases = g.purchases;
      d.ga4RevenueBrand = g.revenueBrand;
      d.ga4PurchasesBrand = g.purchasesBrand;
    }
  }
  return [...byDate.values()]
    .map(d => ({ ...d, purchaseValue: googlePurchaseValue(d), purchases: googlePurchases(d) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 3 Google Ads queries per call regardless of range length.
export async function fetchGoogleAdsDaily(since, until, ga4ByDate = null) {
  const between = `segments.date BETWEEN '${since}' AND '${until}'`;
  const [actions, costRows, conversionRows] = await Promise.all([
    search('SELECT conversion_action.resource_name, conversion_action.name FROM conversion_action'),
    search(`SELECT campaign.name, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions FROM campaign WHERE ${between}`),
    search(`SELECT segments.date, segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE ${between}`),
  ]);
  const actionNames = Object.fromEntries(actions.map(a => [a.conversionAction.resourceName, a.conversionAction.name]));
  return normalizeGoogleAdsDaily(costRows, conversionRows, actionNames, ga4ByDate);
}
