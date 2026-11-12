import crypto from 'node:crypto';

// GA4 Data API with a service account (same property/account the
// altorancho-ventas backend uses). Marketing measures Google Ads results
// here — the "purchase" key event and GA4 revenue for google / cpc sessions —
// instead of Google Ads' own attribution (30–90 day windows, data-driven).
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_ADS_SOURCE_MEDIUM = 'google / cpc';
// Brand search ("altorancho" queries) is mostly demand that would buy anyway;
// kept apart so it doesn't pass for what the paid budget brings in.
// Matches "_brand_" as its own name segment (altorancho_search_brand_aon),
// not "branding" (altorancho_branding_demandgen_aon is Demand Gen, not brand search).
export const BRAND_CAMPAIGN_PATTERN = /(^|_)brand(_|$)/i;

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const sa = JSON.parse(process.env.GA4_SERVICE_ACCOUNT);
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
  if (!res.ok) throw new Error(`GA4 token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

const PAGE_SIZE = 100000;

async function runReportAll(body) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA4_PROPERTY_ID}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, offset, limit: PAGE_SIZE }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    rows.push(...(page.rows || []));
    if (!page.rows || page.rows.length < PAGE_SIZE || rows.length >= (page.rowCount || 0)) return rows;
  }
}

// One runReport call (single page) → rows as plain objects keyed by the
// dimension/metric names; metrics as numbers. With several dateRanges, GA4
// adds a `dateRange` dimension holding each range's `name`.
export async function runGa4Report(body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ga4Records(await res.json());
}

export function ga4Records(page) {
  const dims = (page.dimensionHeaders || []).map(h => h.name);
  const mets = (page.metricHeaders || []).map(h => h.name);
  return (page.rows || []).map(r => {
    const o = {};
    dims.forEach((d, i) => { o[d] = r.dimensionValues[i].value; });
    mets.forEach((m, i) => { o[m] = Number(r.metricValues[i].value || 0); });
    return o;
  });
}

export function isGa4Configured() {
  return Boolean(process.env.GA4_SERVICE_ACCOUNT && process.env.GA4_PROPERTY_ID);
}

// GA4 rows (date YYYYMMDD × campaign) → date -> { revenue, purchases,
// revenueBrand, purchasesBrand }.
export function normalizeGa4GoogleAdsRows(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const [rawDate, campaign] = r.dimensionValues.map(d => d.value);
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    if (!byDate.has(date)) byDate.set(date, { revenue: 0, purchases: 0, revenueBrand: 0, purchasesBrand: 0 });
    const e = byDate.get(date);
    const purchases = Number(r.metricValues[0].value || 0);
    const revenue = Number(r.metricValues[1].value || 0);
    e.purchases += purchases;
    e.revenue += revenue;
    if (BRAND_CAMPAIGN_PATTERN.test(campaign)) { e.purchasesBrand += purchases; e.revenueBrand += revenue; }
  }
  return byDate;
}

// One report call per sync, whatever the range.
export async function fetchGa4GoogleAdsDaily(since, until) {
  const rows = await runReportAll({
    dateRanges: [{ startDate: since, endDate: until }],
    dimensions: [{ name: 'date' }, { name: 'sessionCampaignName' }],
    dimensionFilter: { filter: { fieldName: 'sessionSourceMedium', stringFilter: { value: GOOGLE_ADS_SOURCE_MEDIUM } } },
    metrics: [{ name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
  });
  return normalizeGa4GoogleAdsRows(rows);
}

// Sessions and purchases per day (YYYY-MM-DD → { sessions, purchases }), for
// the conversion sparkline of the new report.
export async function fetchGa4DailyTotals(start, end) {
  const rows = await runReportAll({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'ecommercePurchases' }],
  });
  const out = new Map();
  for (const r of rows) {
    const raw = r.dimensionValues[0].value;
    out.set(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, {
      sessions: Number(r.metricValues[0].value || 0),
      purchases: Number(r.metricValues[1].value || 0),
    });
  }
  return out;
}

// GA4 purchases and revenue per Google Ads campaign (google / cpc) over a
// range, for the Pauta tab. One report call.
export async function fetchGa4GoogleAdsByCampaign(since, until) {
  const rows = await runReportAll({
    dateRanges: [{ startDate: since, endDate: until }],
    dimensions: [{ name: 'sessionCampaignName' }],
    dimensionFilter: { filter: { fieldName: 'sessionSourceMedium', stringFilter: { value: GOOGLE_ADS_SOURCE_MEDIUM } } },
    metrics: [{ name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
  });
  return rows.map(r => ({
    name: r.dimensionValues[0].value,
    purchases: Number(r.metricValues[0].value || 0),
    value: Number(r.metricValues[1].value || 0),
  }));
}
