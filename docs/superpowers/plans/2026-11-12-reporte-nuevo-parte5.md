# Reporte nuevo, parte 5: Pauta + Mayorista, y fuera el reporte viejo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Pauta tab (Meta and Google together, best/worst Meta ads, Google campaigns) and the Mayorista tab (mayorista + ferias, collected vs. invoiced, ferias by sales team), then remove the old report.

**Architecture:** Two new endpoints, `GET /api/v2/pauta` (`backend/pautaReport.mjs`, pure helpers in `backend/pautaTab.mjs`) and `GET /api/v2/mayorista` (`backend/mayoristaReport.mjs`, helpers in `backend/mayoristaTab.mjs`). Both follow the Locales pattern: `webPlan` for the comparison windows, 5-minute cache by range. Pauta reads the existing Meta and Google daily Firestore collections; Google campaigns are a live call (one Google Ads query + one GA4 report, cached) because no per-campaign data is stored. Ferias by team needs the sales team on feria sales docs: the feria sync starts saving it and backfills once. Finally the frontend drops `Dashboard`, `?v=actual`, `ComingSoon` and every component only they used.

**Tech Stack:** Node ESM + `node --test`, Firestore, Odoo JSON-RPC, Google Ads API, GA4 Data API, React 18 + Vite + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-reporte-normal-rediseno-design.md` (sections "Pauta", "Mayorista", "Google Ads / Meta", "Construcción por partes" item 5). Previous plans: `…-parte1.md` … `…-parte4.md`.

## Global Constraints

- Attribution as today: Meta `1d_click` (the stored `purchaseValue`); Google value = GA4 `purchaseRevenue` for `google / cpc` (`googlePurchaseValue`). Brand search = campaign matching `BRAND_CAMPAIGN_PATTERN` (`ga4.mjs`).
- Google ROAS in the headline numbers is **total, brand included**; "sin marca" is shown beside it in Pauta.
- Feria counts inside Mayorista and the total (`channel: 'feria'` plus `'mayorista'`). "Cobrado" only exists for `mayorista` docs (`amountCollected`); label it so.
- Money vs. last year is inflation-adjusted when INDEC has both months, otherwise "nominal". ROAS (a ratio) is never adjusted. Running periods compare the same elapsed days (`webPlan`).
- Pauta is "para tener la info a mano", not a campaign manager: no editing, no extra metrics beyond the spec.
- Quotas: the Google campaigns call is cached (closed periods 6 h, running 15 min) and failures don't break the tab.
- Writes only to the project's own Firestore collections. Never run `node index.mjs` locally; local checks use a scratch script importing `{ app }` with `TZ=UTC`, `CLARITY_API_TOKEN=''`, deleted afterwards. Never print secrets.
- Brand/`.nv` styling, 390 px with no horizontal scroll. Commits to `main` with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `dist` must point only to Railway.

## Review Focus

- **Period with no ad spend on one platform** (Google paused, Meta 0): its block shows $0 and "—" for ROAS/cost per purchase, never NaN/Infinity; the combined block still works. Test in Task 1.
- **Best/worst Meta ads with tiny spend:** an ad with $500 spend and one lucky sale must not top "Mejores". Test in Task 1 (min spend share).
- **Feria sales synced before the team field existed:** grouped as "Sin equipo" until the backfill runs, never dropped from totals. Test in Task 3.
- **Google campaigns API down or not configured:** the rest of Pauta renders, the campaigns card says why. Checked in Task 2 (try/catch → `campaignsError`), live in Task 6.
- **Old links with `?v=actual`:** open the new report instead of a blank page. Test in Task 5.

---

### Task 1: Pauta helpers (`pautaTab.mjs`)

**Files:** Create `backend/pautaTab.mjs`, `backend/test/pautaTab.test.mjs`.

**Interfaces:**
- Consumes: Meta daily docs `{date, spend, purchases, purchaseValue, …}`; Meta ad-daily docs `{adId, adName, campaignName, spend, impressions, clicks, purchases, purchaseValue}`; Google daily docs `{date, spend, spendBrand, purchaseValue, purchases, ga4RevenueBrand, ga4PurchasesBrand}`; `computeTopAds` (`aggregateAds.mjs`); `computeDelta`, `computeInflationAdjustedDelta`.
- Produces:
  - `adsBlock(rows) → { spend, value, purchases, roas (null if spend 0), costPerPurchase (null if purchases 0) }` (2-decimal roas).
  - `pautaSummary({ meta: {cur, prev, year}, google: {cur, prev, year}, inflation }) → { meta, google, total }`, each `{ ...adsBlock(cur), vsPrev: {spend, value, roas, costPerPurchase}, vsYear: {same}, yearAdjusted }`; `google` adds `brand: { spend, value }` and `nonBrand: { spend, value, roas }`. `total` = Meta + Google rows. `vsYear.spend/value/costPerPurchase` adjusted when both indexes exist; `roas` deltas always nominal.
  - `pautaDaily(metaRows, googleRows, { start, end }) → { bucket: 'day'|'week', rows: [{ key, meta: {spend, value}, google: {spend, value} }] }` — every day of the range (Monday-keyed weeks past 45 days, like `dailyStacked`).
  - `adRankings(adDailyRows, { limit = 10, minSpendShare = 0.01 }) → { spend, best, worst }`: `spend` = top by spend; `best`/`worst` by ROAS among ads with spend ≥ `minSpendShare` × total spend.
  - `googleCampaigns(costRows, ga4Rows) → [{ name, brand, spend, clicks, value, purchases, roas }]` sorted by spend; `costRows` = `[{ name, spend, clicks }]`, `ga4Rows` = `[{ name, value, purchases }]`, joined by name; GA4 names with no cost row are listed with spend 0.

- [ ] **Step 1: Write the failing tests:**
  - `adsBlock: empty platform has null ratios` → `adsBlock([])` is `{ spend: 0, value: 0, purchases: 0, roas: null, costPerPurchase: null }`.
  - `pautaSummary: combined total, google brand split` — Meta cur `[{spend:100, purchaseValue:500, purchases:5}]`, Google cur `[{spend:200, spendBrand:50, purchaseValue:1000, purchases:4, ga4RevenueBrand:600}]` → `total.spend 300, total.value 1500, total.roas 5`; `google.nonBrand { spend: 150, value: 400, roas: 2.67 }`; `meta.costPerPurchase 20`.
  - `pautaSummary: vs year adjusts money, never ROAS` — Meta cur spend 200 value 400, year spend 100 value 200, indexes 200/100 → `vsYear.spend 0`, `vsYear.roas 0`, `yearAdjusted true`; no indexes → `vsYear.spend 100`.
  - `pautaDaily: fills every day of the range` — range 3 days, Meta only on day 2 → 3 rows, day 2 `meta.spend` set, others 0.
  - `adRankings: tiny spenders stay out of best/worst` — ads A (spend 1000, value 3000), B (spend 5, value 500), total 1005 → `best[0].adId === 'A'`, B absent from best and worst, B present in `spend`.
  - `googleCampaigns: joins cost and GA4 by name, flags brand` — cost `[{name:'altorancho_search_brand_aon', spend:100, clicks:10}, {name:'pmax', spend:300, clicks:30}]`, ga4 `[{name:'pmax', value:900, purchases:3}, {name:'otra', value:50, purchases:1}]` → order `pmax, brand, otra`; pmax `roas 3`; brand `brand true, value 0, roas 0`; otra `spend 0, roas null`.
- [ ] **Step 2:** `cd backend && node --test test/pautaTab.test.mjs` → FAIL (module not found).
- [ ] **Step 3:** Implement `backend/pautaTab.mjs`.
- [ ] **Step 4:** Same command → PASS; `npm test` → all pass.
- [ ] **Step 5:** Commit `feat(reportes): cálculos de la pestaña Pauta`.

### Task 2: Endpoint `/api/v2/pauta` + Google campaigns fetch

**Files:** Create `backend/pautaReport.mjs`; modify `backend/googleAds.mjs` (`fetchGoogleCampaignCosts`), `backend/ga4.mjs` (`fetchGa4GoogleAdsByCampaign`), `backend/index.mjs`, `frontend/src/api/client.js` (`getPauta`).

**Interfaces:**
- `fetchGoogleCampaignCosts(since, until) → [{ name, spend, clicks }]`: one GAQL `SELECT campaign.name, metrics.cost_micros, metrics.clicks FROM campaign WHERE segments.date BETWEEN …`, summed by name.
- `fetchGa4GoogleAdsByCampaign(since, until) → [{ name, value, purchases }]`: dimension `sessionCampaignName`, same `google / cpc` filter and metrics as `fetchGa4GoogleAdsDaily`.
- `buildPauta(params, { now })` → `{ range, prevRange, prevPeriodRange, prevYear, summary, daily, ads: adRankings(...), campaigns | null, campaignsError | null, generatedAt }`. Reads Meta daily, Google daily for cur/prev/year windows and Meta ad-daily for cur. Campaigns: only if `isGoogleAdsConfigured()`; GA4 part skipped (values 0) when GA4 isn't configured; any failure → `campaigns: null, campaignsError: 'Google Ads no respondió'`; not configured → `'Google Ads no configurado'`. Campaign results cached separately (key `start|end`, 6 h if `range.end < today`, else 15 min).
- `getPauta(params)` (5-minute cache like `getLocales`), route `GET /api/v2/pauta`, `client.getPauta(params)`.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Live check** (scratch script, closed week 02/11 and October): `summary.meta.spend` and `.value` equal `/api/report` `ads.totals.spend` / `.purchaseValue` for the same period; `summary.total.spend` equals the Resumen's ads KPI spend; sum of `campaigns[].spend` ≈ `summary.google.spend` (±1%, Google cost data can lag a day); log `campaignsError`.
- [ ] **Step 3:** `cd backend && npm test` → all pass.
- [ ] **Step 4:** Commit `feat(reportes): endpoint de la pestaña Pauta`.

### Task 3: Feria sales team on sales docs

**Files:** Modify `backend/normalize.mjs` (`normalizeOdooSaleOrder` option `team`), `backend/sync/feria.mjs`; test in `backend/test/normalize.test.mjs` (or the file that already tests `normalizeOdooSaleOrder`).

**Interfaces:**
- `normalizeOdooSaleOrder(order, lines, categoryBySku, { channel, amountCollected, team })`: when `order.team_id` is `[id, name]` and the caller passes `team: true`, the doc gets `teamId: id, team: name`; otherwise no fields are added (mayorista docs unchanged).
- `syncFeria` reads `team_id`, passes `team: true`; if the sync metadata lacks `teamsBackfilled: true`, it ignores `lastSyncedAt` once (since `2000-01-01 00:00:00`) and then saves `teamsBackfilled: true`.

- [ ] **Step 1: Failing tests:** `normalizeOdooSaleOrder: feria doc carries its sales team` (`team_id: [21, 'Presentes']`, `{ channel: 'feria', team: true }` → `teamId 21, team 'Presentes'`); `normalizeOdooSaleOrder: mayorista doc has no team fields` (no `team` option → `'team' in doc === false`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement + sync change. **Step 4:** Run → PASS, `npm test` all pass.
- [ ] **Step 5:** Commit `feat(reportes): las ventas de feria guardan su equipo de venta`. (The backfill runs on Railway's next feria sync; local runs never sync.)

### Task 4: Mayorista helpers + endpoint

**Files:** Create `backend/mayoristaTab.mjs`, `backend/test/mayoristaTab.test.mjs`, `backend/mayoristaReport.mjs`; modify `backend/index.mjs`, `frontend/src/api/client.js` (`getMayorista`).

**Interfaces:**
- `mayoristaSummary({ curDocs, prevDocs, yearDocs, inflation }) → { kpis: { revenue, orders, avgTicket (null if 0 orders), units }, each { value, vsPrev, vsYear, yearAdjusted }, collected: { invoiced, collected, rate (0–100, 1 decimal; null if invoiced 0) } (mayorista docs only), sources: [{ id: 'mayorista'|'feria', label, revenue, orders, sharePct }] }`.
- `feriaTeams(curDocs) → [{ team, revenue, orders, sharePct }]` sorted by revenue; feria docs without `team` → `'Sin equipo'`.
- `buildMayorista(params)` → `{ range, prevRange, prevPeriodRange, prevYear, inflationAdjusted, summary, feriaTeams, daily: dailyStacked(cur, year, …), topModels (compareTopProducts limit 20 + stock via modelStock, same shape as Producto's), stockAsOf, generatedAt }`; channels `['mayorista', 'feria']`; `getMayorista` cached 5 min; route `GET /api/v2/mayorista`; `client.getMayorista`.

- [ ] **Step 1: Failing tests:** `mayoristaSummary: feria counts inside the totals` (mayorista 1000, feria 500 → revenue 1500, sources shares 66.7 / 33.3); `mayoristaSummary: collected only over mayorista docs` (mayorista total 1000 collected 400, feria 500 → `collected { invoiced: 1000, collected: 400, rate: 40 }`); `mayoristaSummary: no sales → null ticket and rate`; `feriaTeams: docs without team go to Sin equipo`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, `npm test` all pass.
- [ ] **Step 5: Live check:** revenue/orders = `/api/report?channels=mayorista,feria`; `collected` = old report's mayorista `amountCollected`.
- [ ] **Step 6:** Commit `feat(reportes): endpoint de la pestaña Mayorista`.

### Task 5: Frontend tabs and removal of the old report

**Files:**
- Create `frontend/src/nuevo/pauta/{Pauta.jsx, AdsBlocks.jsx, AdsDaily.jsx, MetaAdsCard.jsx, GoogleCampaignsCard.jsx}`, `frontend/src/nuevo/mayorista/{Mayorista.jsx, MayoristaKpis.jsx, FeriaTeamsCard.jsx}`, `frontend/src/App.test.jsx` (or a small pure helper test, see step 1).
- Modify `NuevoApp.jsx` (cases `pauta`, `mayorista`; drop `ComingSoon`), `TopBar.jsx` (drop "Reporte anterior"), `App.jsx` (always `NuevoApp`), `nuevo.css`.
- Delete `pages/Dashboard.jsx`, `nuevo/ComingSoon.jsx` and every component/style only reachable from them (find with an import graph from `main.jsx` after the change; keep anything `NuevoApp` or `components/event/*` still imports).

**Interfaces:** Consumes Tasks 2 and 4 responses; reuses `KpiStrip`-style pills from `format.js`, `TopModelsCard` (Producto), `DailyStacked` pattern.
- Pauta: `AdsBlocks` = three cards (Meta, Google, Total) with inversión, valor atribuido, ROAS, costo por compra and pills; Google card shows "sin marca: ROAS x" line. `AdsDaily` = per-day bars of spend split Meta/Google with ROAS of the day in the tooltip. `MetaAdsCard` = toggle Más gasto / Mejores / Peores (10 rows, thumbnail via `${API_URL}/api/ad-image/:adId`), note "Mejores y peores: solo anuncios con al menos 1% de la inversión". `GoogleCampaignsCard` = table name, marca chip, inversión, valor, ROAS; empty/err state from `campaignsError`. Footnote: "Meta: compras a 1 día del clic. Google: ventas de GA4 de google / cpc."
- Mayorista: KPIs (facturación, pedidos, ticket, unidades) + "Cobrado" card (`collected` with rate, "solo mayorista, sin ferias"); "Mayorista y ferias" split bars; `FeriaTeamsCard`; `DailyStacked` with the mayorista group; `TopModelsCard`; link "Ver categorías y origen →" that sets `{ tab: 'producto', ch: 'mayorista' }`.

- [ ] **Step 1: Failing test:** extract `export function pickApp(search) → 'nuevo'` in `App.jsx`'s module (or a `appMode.js`) and test `pickApp('?v=actual') === 'nuevo'` and `pickApp('') === 'nuevo'` — or, simpler and equally binding, a vitest that `urlState.parseUrlState('?v=actual&tab=pauta', today).tab === 'pauta'`; use the latter if `App.jsx` no longer branches at all. Also `pauta/format test`: none needed beyond reuse.
- [ ] **Step 2:** Run → FAIL where applicable. **Step 3:** Implement components, wiring and deletions. **Step 4:** `npx vitest run` and `npm run build` → pass; `grep -r "v=actual\|Dashboard\|ComingSoon" src` → no matches.
- [ ] **Step 5:** Commit `feat(reportes): pestañas Pauta y Mayorista; se retira el reporte anterior`.

### Task 6: Live check, build and deploy

- [ ] **Step 1:** Scratch backend + Vite; open Pauta and Mayorista for week 02/11 and October at desktop and 390 px (iframe). Expected: numbers equal the Task 2/4 checks; toggles work; no horizontal scroll; `?v=actual` opens the new report. Kill processes, delete scratch files and `vite.config.js.timestamp-*`.
- [ ] **Step 2:** `npm run build`; `dist` references only the Railway URL.
- [ ] **Step 3:** Push; Railway deploy SUCCESS; `/api/v2/pauta` and `/api/v2/mayorista` answer 401 without a token.
