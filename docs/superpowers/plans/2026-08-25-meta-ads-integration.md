# Meta Ads Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Meta Ads (Facebook/Instagram) performance section to the existing Altorancho Reportes dashboard, sourced live from the Meta Marketing API and aligned to the same period/comparison structure as the sales report.

**Architecture:** Follows the same connector → sync job → Firestore → aggregate → report-endpoint → frontend-component pipeline already used for Tiendanube/Odoo. A new `meta.mjs` connector talks to the Graph API; a new `sync/metaAds.mjs` job re-syncs a rolling 30-day window (account-level + ad-level) on every cron tick, since Meta attributes conversions retroactively; a new `aggregateAds.mjs` sums/derives metrics the same way `aggregate.mjs` does for sales; `/api/report` gains a `current.metaAds` section computed from the exact same date ranges as the rest of the report; the frontend adds KPI cards, a daily spend chart, and a "top ads" table with live-proxied creative thumbnails.

**Tech Stack:** Node.js/Express (backend, ESM `.mjs`, `node --test`), React + Vite + Recharts (frontend, `vitest`), Firebase Firestore, Meta Graph API v21.0 (Marketing API / Insights).

**Spec:** `docs/superpowers/specs/2026-08-25-meta-ads-integration-design.md`

## Global Constraints

- All new Firestore collections and functions use the `meta_ads_*` naming prefix (not a generic `ads_*`), so a future Google Ads integration can add `google_ads_*` without colliding.
- The Meta Ads section must use the exact same period ranges (`range.start`/`range.end` from `getPeriodRanges`) as the rest of `/api/report` — no separate date picker on the frontend.
- The sync job always re-fetches and overwrites the trailing `daysBack` (default 30) days on every run — it is never "incremental since last sync" like the Tiendanube/Odoo connectors, because Meta attributes conversions retroactively.
- No new npm dependencies — use Node's built-in `fetch`/`AbortSignal.timeout`, matching the existing `tiendanube.mjs`/`odoo.mjs` connectors.
- `GET /api/ad-image/:adId` stays outside `requireAuth`, matching the existing `/api/product-image/:sku` precedent (an `<img src>` can't send an Authorization header, and it isn't sensitive data).
- Network/DB code (Meta API calls, Firestore reads/writes) is verified manually against the live services, not unit tested — the same convention already used for `tiendanube.mjs`/`odoo.mjs`/`firestore.mjs`. Only pure logic (chunking, parsing, normalization, aggregation) gets `node --test`/`vitest` coverage.
- Verified live account: `act_227532872978810` ("ND - Shake - Altorancho"), currency ARS, timezone `America/Argentina/Buenos_Aires` (matches the rest of the report's day-bucketing timezone).

---

### Task 1: Meta connector — date chunking and action-value extraction

**Files:**
- Create: `backend/meta.mjs`
- Test: `backend/test/meta.test.mjs`

**Interfaces:**
- Produces: `chunkDateRange(since: string, until: string, maxDays = 90): Array<{ since: string, until: string }>` — splits an inclusive `YYYY-MM-DD` range into consecutive windows of at most `maxDays`, no gaps or overlaps.
- Produces: `extractActionValue(actions: Array<{action_type: string, value: string}> | undefined, actionType: string): number` — pulls one metric out of Meta's `actions`/`action_values` array shape, defaulting to `0` when the array is missing or the type isn't present.

- [ ] **Step 1: Write the failing tests**

```js
// backend/test/meta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDateRange, extractActionValue } from '../meta.mjs';

test('chunkDateRange returns a single chunk when the range fits within maxDays', () => {
  const chunks = chunkDateRange('2026-08-01', '2026-08-01', 90);
  assert.deepEqual(chunks, [{ since: '2026-08-01', until: '2026-08-01' }]);
});

test('chunkDateRange splits a range into consecutive, non-overlapping windows', () => {
  const chunks = chunkDateRange('2026-01-01', '2026-01-05', 2);
  assert.deepEqual(chunks, [
    { since: '2026-01-01', until: '2026-01-02' },
    { since: '2026-01-03', until: '2026-01-04' },
    { since: '2026-01-05', until: '2026-01-05' },
  ]);
});

test('extractActionValue returns 0 when the actions array is missing', () => {
  assert.equal(extractActionValue(undefined, 'omni_purchase'), 0);
});

test('extractActionValue returns 0 when the action_type is not present', () => {
  const actions = [{ action_type: 'link_click', value: '41871' }];
  assert.equal(extractActionValue(actions, 'omni_purchase'), 0);
});

test('extractActionValue returns the numeric value when the action_type matches', () => {
  const actions = [{ action_type: 'omni_purchase', value: '87' }];
  assert.equal(extractActionValue(actions, 'omni_purchase'), 87);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `node --test test/meta.test.mjs`
Expected: FAIL — `meta.mjs` does not exist / does not export `chunkDateRange`/`extractActionValue`.

- [ ] **Step 3: Implement**

```js
// backend/meta.mjs
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/meta.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/meta.mjs backend/test/meta.test.mjs
git commit -m "feat(backend): add Meta Ads date-chunking and action-value helpers"
```

---

### Task 2: Meta connector — normalize insight rows

**Files:**
- Modify: `backend/meta.mjs`
- Modify: `backend/test/meta.test.mjs`

**Interfaces:**
- Consumes: `extractActionValue` from Task 1 (same file).
- Produces: `normalizeDailyInsightRow(row: object, currency: string): { date, spend, impressions, reach, clicks, purchases, purchaseValue, addToCart, initiateCheckout, landingPageViews, currency }` — all numeric fields are `Number`, `date` comes from `row.date_start`.
- Produces: `normalizeAdDailyInsightRow(row: object, currency: string): { ...same as above, adId, adName, campaignName, adsetName }`.

- [ ] **Step 1: Write the failing tests**

```js
// append to backend/test/meta.test.mjs
import { normalizeDailyInsightRow, normalizeAdDailyInsightRow } from '../meta.mjs';

// Shape captured live from GET /act_.../insights?level=account&time_increment=1
const ACCOUNT_ROW = {
  spend: '5854683.64', impressions: '1243756', reach: '573702', clicks: '50699',
  actions: [
    { action_type: 'omni_purchase', value: '87' },
    { action_type: 'omni_add_to_cart', value: '1155' },
    { action_type: 'omni_initiated_checkout', value: '214' },
    { action_type: 'omni_landing_page_view', value: '35348' },
    { action_type: 'link_click', value: '41871' },
  ],
  action_values: [{ action_type: 'omni_purchase', value: '28173257.6' }],
  date_start: '2026-08-18', date_stop: '2026-08-18',
};

test('normalizeDailyInsightRow maps Meta field names to the stored doc shape', () => {
  const doc = normalizeDailyInsightRow(ACCOUNT_ROW, 'ARS');
  assert.deepEqual(doc, {
    date: '2026-08-18', spend: 5854683.64, impressions: 1243756, reach: 573702, clicks: 50699,
    purchases: 87, purchaseValue: 28173257.6, addToCart: 1155, initiateCheckout: 214,
    landingPageViews: 35348, currency: 'ARS',
  });
});

test('normalizeDailyInsightRow defaults conversion metrics to 0 when actions/action_values are absent', () => {
  const row = { spend: '2521.19', impressions: '8504', reach: '8059', clicks: '2', date_start: '2026-08-20' };
  const doc = normalizeDailyInsightRow(row, 'ARS');
  assert.equal(doc.purchases, 0);
  assert.equal(doc.purchaseValue, 0);
  assert.equal(doc.addToCart, 0);
});

test('normalizeAdDailyInsightRow adds ad identity fields on top of the daily shape', () => {
  const row = {
    ...ACCOUNT_ROW,
    ad_id: '120248373465940142', ad_name: 'altorancho_boost_reel_fabrica',
    campaign_name: 'altorancho_conversiones_broad_aon', adset_name: 'altorancho_conversiones_broad_aon',
  };
  const doc = normalizeAdDailyInsightRow(row, 'ARS');
  assert.equal(doc.adId, '120248373465940142');
  assert.equal(doc.adName, 'altorancho_boost_reel_fabrica');
  assert.equal(doc.campaignName, 'altorancho_conversiones_broad_aon');
  assert.equal(doc.adsetName, 'altorancho_conversiones_broad_aon');
  assert.equal(doc.purchases, 87); // still normalizes the shared metrics
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/meta.test.mjs`
Expected: FAIL — `normalizeDailyInsightRow`/`normalizeAdDailyInsightRow` not exported.

- [ ] **Step 3: Implement**

```js
// append to backend/meta.mjs
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

export function normalizeAdDailyInsightRow(row, currency) {
  return {
    ...normalizeDailyInsightRow(row, currency),
    adId: row.ad_id,
    adName: row.ad_name,
    campaignName: row.campaign_name,
    adsetName: row.adset_name,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/meta.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/meta.mjs backend/test/meta.test.mjs
git commit -m "feat(backend): normalize Meta Ads insight rows into stored doc shape"
```

---

### Task 3: Meta connector — live Graph API calls

**Files:**
- Modify: `backend/meta.mjs`

**Interfaces:**
- Consumes: `chunkDateRange` from Task 1.
- Produces: `fetchAccountCurrency(): Promise<string>`.
- Produces: `fetchAccountDailyInsights(since: string, until: string): Promise<object[]>` — raw rows shaped like `ACCOUNT_ROW` in Task 2's tests.
- Produces: `fetchAdDailyInsights(since: string, until: string): Promise<object[]>` — raw rows with `ad_id`/`ad_name`/`campaign_name`/`adset_name` plus the same metric fields.
- Produces: `fetchAdThumbnail(adId: string): Promise<string | null>`.

No automated test for this task (network code — see Global Constraints). Verified manually in Step 2 against the real, already-confirmed-working account.

- [ ] **Step 1: Implement**

```js
// append to backend/meta.mjs
const DAILY_INSIGHT_FIELDS = 'spend,impressions,reach,clicks,actions,action_values';
const AD_INSIGHT_FIELDS = 'ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,clicks,actions,action_values';

async function request(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Meta Graph API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchAllInsightPages(firstUrl) {
  const rows = [];
  let url = firstUrl;
  while (url) {
    const json = await request(url);
    rows.push(...json.data);
    url = json.paging?.next || null;
  }
  return rows;
}

function insightsUrl(level, fields, since, until) {
  const params = new URLSearchParams({
    level,
    fields,
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    limit: '500',
    access_token: TOKEN,
  });
  return `${BASE_URL}/${ACCOUNT_ID}/insights?${params.toString()}`;
}

export async function fetchAccountCurrency() {
  const params = new URLSearchParams({ fields: 'currency', access_token: TOKEN });
  const json = await request(`${BASE_URL}/${ACCOUNT_ID}?${params.toString()}`);
  return json.currency;
}

export async function fetchAccountDailyInsights(since, until) {
  const rows = [];
  for (const window of chunkDateRange(since, until)) {
    rows.push(...await fetchAllInsightPages(insightsUrl('account', DAILY_INSIGHT_FIELDS, window.since, window.until)));
  }
  return rows;
}

export async function fetchAdDailyInsights(since, until) {
  const rows = [];
  for (const window of chunkDateRange(since, until)) {
    rows.push(...await fetchAllInsightPages(insightsUrl('ad', AD_INSIGHT_FIELDS, window.since, window.until)));
  }
  return rows;
}

export async function fetchAdThumbnail(adId) {
  const params = new URLSearchParams({ fields: 'creative{thumbnail_url}', access_token: TOKEN });
  const json = await request(`${BASE_URL}/${adId}?${params.toString()}`);
  return json.creative?.thumbnail_url || null;
}
```

- [ ] **Step 2: Verify manually against the live API**

Make sure `backend/.env` has `META_AD_ACCOUNT_ID=act_227532872978810` and `META_ACCESS_TOKEN=<the system-user token>` set (see Task 5 for `.env.example`; set the real `.env` now to unblock this check).

Run from `backend/`:

```bash
node -e "
import('./meta.mjs').then(async (m) => {
  console.log('currency:', await m.fetchAccountCurrency());
  const daily = await m.fetchAccountDailyInsights('2026-08-18', '2026-08-24');
  console.log('daily rows:', daily.length, daily[0]);
  const ads = await m.fetchAdDailyInsights('2026-08-20', '2026-08-21');
  console.log('ad rows:', ads.length, ads[0]);
  console.log('thumbnail:', await m.fetchAdThumbnail(ads[0].ad_id));
});
"
```

Expected: `currency` logs `ARS`; `daily rows` logs `7` with a row containing `spend`/`impressions`/`actions`; `ad rows` logs a positive count with `ad_id`/`ad_name`/`campaign_name`; `thumbnail` logs an `https://...fbcdn.net/...` URL (not `null`).

- [ ] **Step 3: Commit**

```bash
git add backend/meta.mjs
git commit -m "feat(backend): fetch Meta Ads insights and ad thumbnails from the Graph API"
```

---

### Task 4: Firestore persistence + Meta Ads sync job

**Files:**
- Modify: `backend/firestore.mjs`
- Create: `backend/sync/metaAds.mjs`

**Interfaces:**
- Consumes: `fetchAccountCurrency`, `fetchAccountDailyInsights`, `fetchAdDailyInsights`, `normalizeDailyInsightRow`, `normalizeAdDailyInsightRow` from `../meta.mjs` (Tasks 1-3); `setSyncMetadata` (existing).
- Produces: `saveMetaAdsDailyDocs(docs)`, `saveMetaAdsAdDailyDocs(docs)`, `queryMetaAdsDailyByRange(startDate, endDate)`, `queryMetaAdsAdDailyByRange(startDate, endDate)` in `firestore.mjs`.
- Produces: `syncMetaAds({ daysBack = 30, includeAdLevel = true } = {}): Promise<{ dailyCount, adDailyCount }>` in `sync/metaAds.mjs` — used by `index.mjs`'s cron (Task 5) and `backfill.mjs` (Task 5).

No automated test (Firestore is network/DB code — see Global Constraints). Verified manually in Step 2.

- [ ] **Step 1: Implement**

```js
// add to backend/firestore.mjs, after the existing METADATA_COL/BATCH_SIZE consts
const META_ADS_DAILY_COL = 'altorancho_reportes_meta_ads_daily';
const META_ADS_AD_DAILY_COL = 'altorancho_reportes_meta_ads_ad_daily';

export async function saveMetaAdsDailyDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(META_ADS_DAILY_COL).doc(doc.date), {
        ...doc,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  return { written: docs.length };
}

export async function saveMetaAdsAdDailyDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(META_ADS_AD_DAILY_COL).doc(`${doc.adId}_${doc.date}`), {
        ...doc,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  return { written: docs.length };
}

export async function queryMetaAdsDailyByRange(startDate, endDate) {
  const firestore = getDb();
  const snap = await firestore.collection(META_ADS_DAILY_COL)
    .where('date', '>=', startDate)
    .where('date', '<=', endDate)
    .get();
  return snap.docs.map(d => d.data());
}

export async function queryMetaAdsAdDailyByRange(startDate, endDate) {
  const firestore = getDb();
  const snap = await firestore.collection(META_ADS_AD_DAILY_COL)
    .where('date', '>=', startDate)
    .where('date', '<=', endDate)
    .get();
  return snap.docs.map(d => d.data());
}
```

```js
// backend/sync/metaAds.mjs
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
```

- [ ] **Step 2: Verify manually against live Meta + real Firestore**

Run from `backend/` (needs `META_AD_ACCOUNT_ID`/`META_ACCESS_TOKEN` plus the existing `FIREBASE_*` vars already in `.env`):

```bash
node -e "import('./sync/metaAds.mjs').then(m => m.syncMetaAds({ daysBack: 7 })).then(r => console.log('result:', r))"
```

Expected: log line `[sync:metaAds] 7 días, N filas de anuncios` and `result: { dailyCount: 7, adDailyCount: N }` with `N > 0`. Then confirm in the Firebase console (or a follow-up read) that `altorancho_reportes_meta_ads_daily` has 7 new docs (ids like `2026-08-18`) and `altorancho_reportes_meta_ads_ad_daily` has docs with ids like `<adId>_2026-08-18`.

- [ ] **Step 3: Commit**

```bash
git add backend/firestore.mjs backend/sync/metaAds.mjs
git commit -m "feat(backend): sync Meta Ads daily insights into Firestore"
```

---

### Task 5: Wire sync into cron, backfill, and env config

**Files:**
- Modify: `backend/index.mjs:1-18` (imports), `runFullSync` (around line 129-143)
- Modify: `backend/backfill.mjs`
- Modify: `backend/.env.example`

**Interfaces:**
- Consumes: `syncMetaAds` from Task 4.

- [ ] **Step 1: Add the import and cron call in `index.mjs`**

```js
// add alongside the other sync imports near the top of backend/index.mjs
import { syncMetaAds } from './sync/metaAds.mjs';
```

```js
// inside runFullSync(), after the existing three syncs:
async function runFullSync() {
  if (syncRunning) { console.log('[cron] sync already running, skipping'); return; }
  syncRunning = true;
  try {
    const { categoryBySku } = await syncProducts();
    await syncEcommerce(categoryBySku);
    await syncLocales(categoryBySku);
    await syncMayorista(categoryBySku);
    await syncMetaAds();
    console.log('[cron] full sync complete');
  } catch (err) {
    console.error('[cron] sync error:', err.message);
  } finally {
    syncRunning = false;
  }
}
```

- [ ] **Step 2: Add the backfill call in `backfill.mjs`**

```js
// backend/backfill.mjs — add import at the top
import { syncMetaAds } from './sync/metaAds.mjs';
```

```js
// inside backfill(), after the mayorista block — account-level history only;
// ad-level stays limited to the rolling window the regular cron already covers
const metaAdsResult = await syncMetaAds({ daysBack: months * 31, includeAdLevel: false });
console.log('[backfill] metaAds:', metaAdsResult);
```

- [ ] **Step 3: Add the new env vars to `.env.example`**

```bash
# add after the TN_* block in backend/.env.example
META_AD_ACCOUNT_ID=act_227532872978810
META_ACCESS_TOKEN=
```

- [ ] **Step 4: Verify manually**

Run from `backend/`: `npm run dev` — confirm it starts without errors and logs `[server] cron scheduled every 4h` (the new import must not break startup).

Run: `npm run backfill -- --months=1` — confirm the log includes a `[backfill] metaAds: { dailyCount: ..., adDailyCount: 0 }` line (adDailyCount is 0 by design, `includeAdLevel: false`).

- [ ] **Step 5: Commit**

```bash
git add backend/index.mjs backend/backfill.mjs backend/.env.example
git commit -m "feat(backend): wire Meta Ads sync into the cron and backfill scripts"
```

---

### Task 6: Ad image proxy endpoint

**Files:**
- Modify: `backend/index.mjs` (add route near the existing `/api/product-image/:sku` handler)

**Interfaces:**
- Consumes: `fetchAdThumbnail` from Task 3.

- [ ] **Step 1: Implement**

```js
// add the import alongside the other meta.mjs usage (or a new line near the top)
import { fetchAdThumbnail } from './meta.mjs';
```

```js
// add after the existing /api/product-image/:sku handler in backend/index.mjs
// Not behind requireAuth — same reasoning as /api/product-image/:sku: a plain
// <img src> can't send an Authorization header, and creative thumbnails
// aren't sensitive. Meta's thumbnail_url is a signed URL that expires, so
// this re-resolves it live and proxies the bytes rather than redirecting
// (avoids exposing the ever-rotating signed URL to the browser).
app.get('/api/ad-image/:adId', async (req, res) => {
  try {
    const thumbnailUrl = await fetchAdThumbnail(req.params.adId);
    if (!thumbnailUrl) return res.status(404).end();

    const imageRes = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(15_000) });
    if (!imageRes.ok) return res.status(404).end();

    res.set('Content-Type', imageRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await imageRes.arrayBuffer()));
  } catch (err) {
    console.error('[server] ad-image error:', err.message);
    res.status(500).end();
  }
});
```

- [ ] **Step 2: Verify manually**

With `npm run dev` running in `backend/`, run:

```bash
curl -s -o /tmp/ad-image-test.jpg -w "%{http_code} %{content_type} %{size_download}\n" http://localhost:3000/api/ad-image/120248373465940142
```

Expected: `200 image/jpeg <nonzero size>`. Open `/tmp/ad-image-test.jpg` to confirm it's a real image.

- [ ] **Step 3: Commit**

```bash
git add backend/index.mjs
git commit -m "feat(backend): add live-proxied Meta Ads creative thumbnail endpoint"
```

---

### Task 7: Ads aggregation

**Files:**
- Create: `backend/aggregateAds.mjs`
- Test: `backend/test/aggregateAds.test.mjs`

**Interfaces:**
- Produces: `computeAdTotals(dailyRows): { spend, impressions, reach, clicks, purchases, purchaseValue, addToCart, initiateCheckout, landingPageViews, ctr, cpc, roas, costPerPurchase, costPerAddToCart }` — derived metrics (`ctr`, `cpc`, `roas`, etc.) are computed from the *summed* totals, never averaged from per-day values.
- Produces: `computeAdDailyBreakdown(dailyRows): Array<{ date, spend, purchases }>` sorted ascending by date.
- Produces: `computeTopAds(adDailyRows, { limit = 10 } = {}): Array<{ adId, adName, campaignName, spend, purchases, purchaseValue, roas }>` sorted by `spend` descending.

- [ ] **Step 1: Write the failing tests**

```js
// backend/test/aggregateAds.test.mjs
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/aggregateAds.test.mjs`
Expected: FAIL — `aggregateAds.mjs` does not exist.

- [ ] **Step 3: Implement**

```js
// backend/aggregateAds.mjs
function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] || 0), 0);
}

export function computeAdTotals(dailyRows) {
  const spend = sum(dailyRows, 'spend');
  const impressions = sum(dailyRows, 'impressions');
  const reach = sum(dailyRows, 'reach');
  const clicks = sum(dailyRows, 'clicks');
  const purchases = sum(dailyRows, 'purchases');
  const purchaseValue = sum(dailyRows, 'purchaseValue');
  const addToCart = sum(dailyRows, 'addToCart');
  const initiateCheckout = sum(dailyRows, 'initiateCheckout');
  const landingPageViews = sum(dailyRows, 'landingPageViews');

  return {
    spend, impressions, reach, clicks, purchases, purchaseValue, addToCart, initiateCheckout, landingPageViews,
    ctr: impressions ? (clicks / impressions) * 100 : 0,
    cpc: clicks ? spend / clicks : 0,
    roas: spend ? purchaseValue / spend : 0,
    costPerPurchase: purchases ? spend / purchases : 0,
    costPerAddToCart: addToCart ? spend / addToCart : 0,
  };
}

export function computeAdDailyBreakdown(dailyRows) {
  return dailyRows
    .map(row => ({ date: row.date, spend: row.spend, purchases: row.purchases }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function computeTopAds(adDailyRows, { limit = 10 } = {}) {
  const byAd = new Map();

  for (const row of adDailyRows) {
    if (!byAd.has(row.adId)) {
      byAd.set(row.adId, { adId: row.adId, adName: row.adName, campaignName: row.campaignName, spend: 0, purchases: 0, purchaseValue: 0 });
    }
    const entry = byAd.get(row.adId);
    entry.spend += row.spend || 0;
    entry.purchases += row.purchases || 0;
    entry.purchaseValue += row.purchaseValue || 0;
    entry.adName = row.adName;
    entry.campaignName = row.campaignName;
  }

  return [...byAd.values()]
    .map(entry => ({ ...entry, roas: entry.spend ? entry.purchaseValue / entry.spend : 0 }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, limit);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/aggregateAds.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/aggregateAds.mjs backend/test/aggregateAds.test.mjs
git commit -m "feat(backend): add Meta Ads totals/daily/top-ads aggregation"
```

---

### Task 8: Extend `/api/report` with the `metaAds` section

**Files:**
- Modify: `backend/index.mjs`

**Interfaces:**
- Consumes: `queryMetaAdsDailyByRange`, `queryMetaAdsAdDailyByRange` (Task 4); `computeAdTotals`, `computeAdDailyBreakdown`, `computeTopAds` (Task 7); `computeDelta` (existing, from `aggregate.mjs`).
- Produces: `current.metaAds = { totals, dailyBreakdown, topAds }` and `comparisons.<range>.metaAdsDeltas` on the `/api/report` JSON response.

- [ ] **Step 1: Implement**

```js
// add to the existing import block in backend/index.mjs
import { querySalesByRange, getProductsBySku, getProductBySku, queryMetaAdsDailyByRange, queryMetaAdsAdDailyByRange } from './firestore.mjs';
import { computeAdTotals, computeAdDailyBreakdown, computeTopAds } from './aggregateAds.mjs';
```

```js
// add near buildTotalsSection in backend/index.mjs
async function buildAdsSection(range) {
  const [dailyRows, adDailyRows] = await Promise.all([
    queryMetaAdsDailyByRange(range.start, range.end),
    queryMetaAdsAdDailyByRange(range.start, range.end),
  ]);
  return {
    totals: computeAdTotals(dailyRows),
    dailyBreakdown: computeAdDailyBreakdown(dailyRows),
    topAds: computeTopAds(adDailyRows, { limit: 10 }),
  };
}

function diffAdTotals(current, previous) {
  return {
    spend: computeDelta(current.spend, previous.spend),
    impressions: computeDelta(current.impressions, previous.impressions),
    reach: computeDelta(current.reach, previous.reach),
    clicks: computeDelta(current.clicks, previous.clicks),
    ctr: computeDelta(current.ctr, previous.ctr),
    cpc: computeDelta(current.cpc, previous.cpc),
    purchases: computeDelta(current.purchases, previous.purchases),
    purchaseValue: computeDelta(current.purchaseValue, previous.purchaseValue),
    roas: computeDelta(current.roas, previous.roas),
    addToCart: computeDelta(current.addToCart, previous.addToCart),
    initiateCheckout: computeDelta(current.initiateCheckout, previous.initiateCheckout),
    landingPageViews: computeDelta(current.landingPageViews, previous.landingPageViews),
  };
}
```

```js
// modify the GET /api/report handler in backend/index.mjs — replace the
// existing Promise.all + res.json block with:
    const [current, prevPeriod, prevMonth, prevYear] = await Promise.all([
      buildTotalsSection(requestedChannels, ranges.current, productsBySku),
      buildTotalsSection(requestedChannels, ranges.prevPeriod, productsBySku),
      buildTotalsSection(requestedChannels, ranges.prevMonth, productsBySku),
      buildTotalsSection(requestedChannels, ranges.prevYear, productsBySku),
    ]);

    const [currentAds, prevPeriodAds, prevMonthAds, prevYearAds] = await Promise.all([
      buildAdsSection(ranges.current),
      buildAdsSection(ranges.prevPeriod),
      buildAdsSection(ranges.prevMonth),
      buildAdsSection(ranges.prevYear),
    ]);

    res.json({
      ok: true,
      range: ranges.current,
      current: { ...current, metaAds: currentAds },
      comparisons: {
        prevPeriod: {
          range: ranges.prevPeriod, totals: prevPeriod.totals, deltas: diffTotals(current.totals, prevPeriod.totals),
          metaAdsDeltas: diffAdTotals(currentAds.totals, prevPeriodAds.totals),
        },
        prevMonth: {
          range: ranges.prevMonth, totals: prevMonth.totals, deltas: diffTotals(current.totals, prevMonth.totals),
          metaAdsDeltas: diffAdTotals(currentAds.totals, prevMonthAds.totals),
        },
        prevYear: {
          range: ranges.prevYear, totals: prevYear.totals, deltas: diffTotals(current.totals, prevYear.totals),
          metaAdsDeltas: diffAdTotals(currentAds.totals, prevYearAds.totals),
        },
      },
    });
```

- [ ] **Step 2: Verify manually**

With `npm run dev` running in `backend/` and a real `DASHBOARD_PASSWORD` set, run:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d "{\"password\":\"$DASHBOARD_PASSWORD\"}" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
curl -s "http://localhost:3000/api/report?period=week&date=2026-08-24" -H "Authorization: Bearer $TOKEN" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')).current.metaAds, null, 2)"
```

Expected: a `metaAds` object with real, non-zero `totals.spend`/`totals.purchases` (matching the range synced in Task 4's manual check) and a populated `topAds` array.

- [ ] **Step 3: Commit**

```bash
git add backend/index.mjs
git commit -m "feat(backend): expose Meta Ads totals/comparisons on /api/report"
```

---

### Task 9: Frontend — generalize KpiCards/DailyChart, add formatRoas

**Files:**
- Modify: `frontend/src/lib/format.js`
- Modify: `frontend/src/lib/format.test.js`
- Modify: `frontend/src/components/KpiCards.jsx`
- Modify: `frontend/src/components/DailyChart.jsx`

**Interfaces:**
- Produces: `formatRoas(value: number | null): string` — e.g. `4.81x`, `—` for `null`/`undefined`.
- Produces: `KpiCards({ current, comparisons, metrics = SALES_METRICS, deltasKey = 'deltas' })` — existing sales call sites keep working unchanged via the defaults; also exports `SALES_METRICS`.
- Produces: `DailyChart({ data, channel, dataKey = 'revenue', title = 'Facturación por día', color })` — existing sales call sites keep working unchanged via the defaults.

- [ ] **Step 1: Write the failing test for formatRoas**

```js
// append to frontend/src/lib/format.test.js
import { formatRoas } from './format.js';

test('formatRoas shows two decimals with an x suffix', () => {
  expect(formatRoas(4.812089)).toBe('4.81x');
});

test('formatRoas returns an em dash for null', () => {
  expect(formatRoas(null)).toBe('—');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npm test`
Expected: FAIL — `formatRoas` is not exported from `format.js`.

- [ ] **Step 3: Implement formatRoas**

```js
// append to frontend/src/lib/format.js
export function formatRoas(value) {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}x`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Generalize KpiCards.jsx**

```jsx
// frontend/src/components/KpiCards.jsx — full replacement
import { formatCurrency, formatNumber, formatRate } from '../lib/format.js';
import DeltaBadge from './DeltaBadge.jsx';

export const SALES_METRICS = [
  { key: 'revenue', label: 'Facturación', format: formatCurrency },
  { key: 'shippingRevenue', label: 'Envíos facturados', format: formatCurrency },
  { key: 'avgDailyRevenue', label: 'Facturación promedio diaria', format: formatCurrency },
  { key: 'orders', label: 'Ventas', format: formatNumber },
  { key: 'units', label: 'Unidades', format: formatNumber },
  { key: 'avgTicket', label: 'Ticket promedio', format: formatCurrency },
  { key: 'cancellationRate', label: 'Tasa de cancelación', format: formatRate, invert: true },
];

const COMPARISON_LABELS = {
  prevPeriod: 'vs. período anterior',
  prevMonth: 'vs. mes anterior',
  prevYear: 'vs. año anterior',
};

export default function KpiCards({ current, comparisons, metrics = SALES_METRICS, deltasKey = 'deltas' }) {
  return (
    <div className="kpi-cards">
      {metrics.map((metric) => (
        <div className="kpi-card" key={metric.key}>
          <div className="kpi-label">{metric.label}</div>
          <div className="kpi-value">{metric.format(current[metric.key])}</div>
          <div className="kpi-deltas">
            {Object.entries(COMPARISON_LABELS).map(([key, label]) => (
              <div className="kpi-delta-row" key={key}>
                <span className="kpi-delta-label">{label}</span>
                <DeltaBadge pct={comparisons[key][deltasKey][metric.key]?.pct} invert={metric.invert} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Generalize DailyChart.jsx**

```jsx
// frontend/src/components/DailyChart.jsx — full replacement
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatCurrency } from '../lib/format.js';
import { getChannelColor } from '../lib/channels.js';

function formatDayTick(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

export default function DailyChart({ data, channel, dataKey = 'revenue', title = 'Facturación por día', color }) {
  const resolvedColor = color || getChannelColor(channel);

  return (
    <div className="chart-card">
      <h3 className="chart-title">{title}</h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="date" tickFormatter={formatDayTick} stroke="var(--ink-secondary)" fontSize={12} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={(v) => formatCurrency(v)} width={90} />
          <Tooltip formatter={(value) => formatCurrency(value)} labelFormatter={formatDayTick} />
          <Bar dataKey={dataKey} fill={resolvedColor} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 7: Run the full frontend test suite to confirm nothing broke**

Run: `npm test`
Expected: PASS (all existing tests, plus the new `formatRoas` tests)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/format.js frontend/src/lib/format.test.js frontend/src/components/KpiCards.jsx frontend/src/components/DailyChart.jsx
git commit -m "feat(frontend): generalize KpiCards/DailyChart for reuse, add formatRoas"
```

---

### Task 10: Frontend — Meta Ads metrics list and TopAdsTable

**Files:**
- Create: `frontend/src/lib/metaAdsMetrics.js`
- Create: `frontend/src/components/TopAdsTable.jsx`

**Interfaces:**
- Consumes: `formatCurrency`, `formatNumber`, `formatRate`, `formatRoas` (Task 9); `API_URL` from `../api/client.js` (existing).
- Produces: `META_ADS_METRICS` — a metrics array in the same shape `KpiCards` expects (Task 9).
- Produces: `TopAdsTable({ ads })` component — `ads` matches `computeTopAds`'s return shape (Task 7).

- [ ] **Step 1: Implement the metrics list**

```js
// frontend/src/lib/metaAdsMetrics.js
import { formatCurrency, formatNumber, formatRate, formatRoas } from './format.js';

export const META_ADS_METRICS = [
  { key: 'spend', label: 'Gasto', format: formatCurrency },
  { key: 'purchases', label: 'Compras', format: formatNumber },
  { key: 'purchaseValue', label: 'Valor de compras', format: formatCurrency },
  { key: 'roas', label: 'ROAS', format: formatRoas },
  { key: 'impressions', label: 'Impresiones', format: formatNumber },
  { key: 'reach', label: 'Alcance', format: formatNumber },
  { key: 'clicks', label: 'Clics', format: formatNumber },
  { key: 'ctr', label: 'CTR', format: formatRate },
  { key: 'cpc', label: 'CPC', format: formatCurrency },
  { key: 'addToCart', label: 'Agregados al carrito', format: formatNumber },
  { key: 'initiateCheckout', label: 'Checkouts iniciados', format: formatNumber },
  { key: 'landingPageViews', label: 'Vistas de landing', format: formatNumber },
];
```

- [ ] **Step 2: Implement TopAdsTable, modeled on TopProductsTable.jsx**

```jsx
// frontend/src/components/TopAdsTable.jsx
import { useState } from 'react';
import { formatCurrency, formatNumber, formatRoas } from '../lib/format.js';
import { API_URL } from '../api/client.js';

function AdThumb({ adId, name }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="product-thumb"
      src={`${API_URL}/api/ad-image/${encodeURIComponent(adId)}`}
      alt=""
      loading="lazy"
      title={name}
      onError={() => setFailed(true)}
    />
  );
}

export default function TopAdsTable({ ads }) {
  return (
    <div className="table-card">
      <div className="table-header">
        <h3 className="chart-title">Top anuncios</h3>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="product-thumb-col"></th>
            <th className="product-col">Anuncio</th>
            <th className="product-col">Campaña</th>
            <th className="numeric-col">Gasto</th>
            <th className="numeric-col">Compras</th>
            <th className="numeric-col">ROAS</th>
          </tr>
        </thead>
        <tbody>
          {ads.map((ad) => (
            <tr key={ad.adId}>
              <td className="product-thumb-col">
                <AdThumb adId={ad.adId} name={ad.adName} />
              </td>
              <td className="product-col" title={ad.adName}>{ad.adName}</td>
              <td className="product-col" title={ad.campaignName}>{ad.campaignName}</td>
              <td className="numeric-col">{formatCurrency(ad.spend)}</td>
              <td className="numeric-col">{formatNumber(ad.purchases)}</td>
              <td className="numeric-col">{formatRoas(ad.roas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

No dedicated component test (matches the existing convention — `TopProductsTable.jsx` has none either; components are verified via the end-to-end browser check in Task 11).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/metaAdsMetrics.js frontend/src/components/TopAdsTable.jsx
git commit -m "feat(frontend): add Meta Ads metrics list and top-ads table"
```

---

### Task 11: Wire Meta Ads into the Dashboard + end-to-end verification

**Files:**
- Modify: `frontend/src/pages/Dashboard.jsx`

**Interfaces:**
- Consumes: `KpiCards`/`DailyChart` (Task 9), `TopAdsTable` (Task 10), `META_ADS_METRICS` (Task 10), `report.current.metaAds`/`report.comparisons.*.metaAdsDeltas` (Task 8).

- [ ] **Step 1: Add the Meta Ads section to Dashboard.jsx**

```jsx
// frontend/src/pages/Dashboard.jsx — add imports
import TopAdsTable from '../components/TopAdsTable.jsx';
import { META_ADS_METRICS } from '../lib/metaAdsMetrics.js';
```

```jsx
// insert after the closing </div> of the sales `dashboard-grid` block and
// before the Locales/Mayorista `dashboard-grid` block — unconditional, not
// gated by `channel === null` (Meta Ads is account-wide, not per sales channel)
          <h2 className="chart-title">Meta Ads</h2>
          <KpiCards
            current={report.current.metaAds.totals}
            comparisons={report.comparisons}
            metrics={META_ADS_METRICS}
            deltasKey="metaAdsDeltas"
          />
          <DailyChart
            data={report.current.metaAds.dailyBreakdown}
            dataKey="spend"
            title="Gasto en Meta Ads por día"
            color="#1877F2"
          />
          <TopAdsTable ads={report.current.metaAds.topAds} />
```

- [ ] **Step 2: End-to-end browser verification**

Start both servers (`npm run dev` in `backend/` and in `frontend/`), log into the dashboard, and confirm:
- The "Meta Ads" heading and KPI cards render with real numbers (gasto, compras, ROAS, etc.) matching what Task 8's curl check showed.
- The daily spend chart renders bars for the selected period.
- The "Top anuncios" table renders rows with a visible creative thumbnail image for each ad (not broken images) — recall from Task 3 that ad id `120248373465940142` ("altorancho_boost_reel_fabrica") has a confirmed-working thumbnail, so it should render if it's in range/top spenders.
- Switching the period selector (week/month/custom range) updates the Meta Ads numbers together with the sales numbers, using the same dates (per Global Constraints).
- Switching the channel tabs does **not** hide or change the Meta Ads section (it's account-wide).

If anything renders wrong (broken image icons, misaligned table columns, zero data), fix it directly in the relevant component before moving on — this is the project's single consolidated end-to-end check, so it needs to actually pass with real data, not just "look implemented."

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Dashboard.jsx
git commit -m "feat(frontend): add Meta Ads section to the dashboard"
```
