import crypto from 'node:crypto';

// Google Ads API (REST v24) with a service account — same approach as the
// altorancho-ventas backend (gineza-agent), which proved it works without a
// developer token. Shares that account's daily quota (2,880 ops), so keep
// the number of queries per sync tiny: account-level rows only.
const BASE = 'https://googleads.googleapis.com/v24/';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google's "purchase" changed over time: until Feb 2026 the conversion that
// tracked sales was "Tiendanube Website purchases"; from Mar 2026 "GA4
// purchase" took over (and the Tiendanube one degraded to ~half). Both are
// stored per day; purchaseValue picks the one that was the real one then.
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

export function googlePurchaseValue(doc) {
  return doc.date >= GA4_SWITCH_DATE ? doc.purchaseValueGa4 : doc.purchaseValueTn;
}

export function googlePurchases(doc) {
  return doc.date >= GA4_SWITCH_DATE ? doc.purchasesGa4 : doc.purchasesTn;
}

// Joins the account-level cost rows and per-conversion-action rows into one
// doc per day. `actionNames` maps conversion_action resource names to names.
export function normalizeGoogleAdsDaily(costRows, conversionRows, actionNames) {
  const byDate = new Map();
  const get = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date, spend: 0, clicks: 0, impressions: 0,
        purchaseValueTn: 0, purchasesTn: 0, purchaseValueGa4: 0, purchasesGa4: 0, currency: 'ARS',
      });
    }
    return byDate.get(date);
  };
  for (const r of costRows) {
    const d = get(r.segments.date);
    d.spend += Number(r.metrics.costMicros || 0) / 1e6;
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
  return [...byDate.values()]
    .map(d => ({ ...d, purchaseValue: googlePurchaseValue(d), purchases: googlePurchases(d) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 3 queries per call regardless of range length.
export async function fetchGoogleAdsDaily(since, until) {
  const between = `segments.date BETWEEN '${since}' AND '${until}'`;
  const [actions, costRows, conversionRows] = await Promise.all([
    search('SELECT conversion_action.resource_name, conversion_action.name FROM conversion_action'),
    search(`SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions FROM customer WHERE ${between}`),
    search(`SELECT segments.date, segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE ${between}`),
  ]);
  const actionNames = Object.fromEntries(actions.map(a => [a.conversionAction.resourceName, a.conversionAction.name]));
  return normalizeGoogleAdsDaily(costRows, conversionRows, actionNames);
}
