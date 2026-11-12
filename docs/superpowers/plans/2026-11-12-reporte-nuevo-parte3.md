# Reporte nuevo, parte 3: pestaña Web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Web tab of the new report: Odoo web sales, GA4 behaviour for any period, and Clarity for the chosen period from the daily snapshots.

**Architecture:** A new `GET /api/v2/web` endpoint (`backend/webReport.mjs`) combines three parts:
- Odoo ecommerce sales, with KPIs and a daily chart.
- `getWebBehavior` from `eventBehavior.mjs`, called with the same ranges as the Resumen so the two share its GA4 cache.
- Clarity daily snapshots merged over the period by a new pure module, `backend/clarityPeriod.mjs`.

The frontend gets `frontend/src/nuevo/web/`, with `.nv` cards in the style of parts 1–2.

**Tech Stack:** Node ESM + `node --test`, Firestore, GA4 Data API, React 18 + Vite + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-reporte-normal-rediseno-design.md` (sections "Web", "GA4", "Clarity", "Datos nuevos a guardar"). Parts 1–2 plans: `2026-11-12-reporte-nuevo-parte1.md` and `-parte2.md`.

## Global Constraints

- Conversion is always purchases ÷ sessions. Never use GA4's `sessionConversionRate`, which is broken in this property.
- Never show or compare the checkout steps (`begin_checkout`, `add_shipping_info`, `add_payment_info`).
- Never compare categories with last year (2025 item names don't match the catalog). Day and source comparisons are fine.
- Revenue always comes from Odoo. GA4 only contributes behaviour, and `purchaseRevenue` is never shown as sales.
- Clarity is read only from the snapshots (`altorancho_reportes_clarity_daily`), with no live calls from this tab. Local runs start without `CLARITY_API_TOKEN`.
- Stay within the GA4 quota: the Web tab must reuse the cache key the Resumen uses for the same period.
- Brand: white and `#353434`, Poppins, `.nv` classes, `tabular-nums`, compact amounts. It must look right projected and on a phone at 390 px, with no horizontal page scroll.
- A period still running is compared with the same elapsed days last year (`prevYearToDate` from `productTab.mjs`; part 2's I1 lesson).
- Clarity heatmaps: link to `https://clarity.microsoft.com/projects/view/gqkzzchnqe/dashboard`.
- Commits go straight to `main` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Local servers use a scratch script that imports `{ app }`, with `TZ=UTC` and `CLARITY_API_TOKEN=''`.

## Review Focus

- **Period with no Clarity snapshots** (before 13/11, or the cron failed): the card says "Sin datos de Clarity para este período" and how many days exist. No zeros and no NaN. Test in Task 1.
- **Partial Clarity coverage** (3 of 7 days): it says "3 de 7 días" and the percentages use only those days. Test in Task 1.
- **GA4 down or not configured:** web sales and Clarity still render; the GA4 sections show one note. Test in Task 3.
- **Custom range longer than 60 days:** GA4's daily series isn't cut at 60 rows (the current `limit: 60`). Test in Task 3.
- **Running week:** sales "vs. año anterior" compares the same elapsed days, not a full week. Test in Task 2.

---

### Task 1: Clarity for a period (`clarityPeriod.mjs`)

**Files:**
- Create: `backend/clarityPeriod.mjs`
- Modify: `backend/alerts.mjs` (`clarityAlert` uses `mergeClarityPages`)
- Test: `backend/test/clarityPeriod.test.mjs`

**Interfaces:**
- Consumes: snapshot docs `{date, totals:{sessions, users, pagesPerSession, scrollDepth, totalTimeSec, activeTimeSec, signals:{rage|dead|quickback|errorClick|excessiveScroll|scriptError: {pct, sessions, count} | null}}, pages:[{path, sessions, scrollDepth, rage, dead, quickback}]}` (see `snapshots.mjs`).
- Produces:
  - `mergeClarityPages(snapshots) → [{path, sessions, scrollDepth, rage, dead, quickback}]`, sorted by sessions descending. Percentages and scroll depth are weighted by sessions.
  - `clarityForPeriod(snapshots, {start, end}) → { days, totalDays, dates, totals: {sessions, users, scrollDepth, activeTimeSec, signals:{rage, dead, quickback, excessiveScroll: {pct, count}}}, pages (top 20 with ≥ 50 sessions), daily: [{date, sessions, rage, dead, quickback}] } | { days: 0, totalDays }`.
  - `totalDays` is the inclusive day count of the range. `scrollDepth` and `activeTimeSec` are session-weighted averages. A signal's `pct` is session-weighted, `count` is summed, and a signal that is null on every day stays null.

- [ ] **Step 1: Write the failing tests** in `test/clarityPeriod.test.mjs`:
  - `mergeClarityPages: weights by sessions across days`. Day 1 has `/` with 100 sessions and rage 10. Day 2 has `/` with 300 sessions and rage 0. Expect `/` to have 400 sessions and rage 2.5.
  - `clarityForPeriod: 2 of 7 days, totals weighted`. Day A has 100 sessions, scroll 40, rage pct 1, count 3. Day B has 300 sessions, scroll 60, rage pct 3, count 9. Expect `days` 2, `totalDays` 7, sessions 400, scrollDepth 55, rage `{pct: 2.5, count: 12}`, and `daily.length` 2.
  - `clarityForPeriod: no snapshots → {days: 0, totalDays: 7}`, which has no `totals` key.
  - `clarityForPeriod: signal null every day stays null`, and a page with fewer than 50 sessions is not listed.
- [ ] **Step 2:** Run `cd backend && node --test test/clarityPeriod.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement both functions. Then make `alerts.mjs`'s `clarityAlert` merge with `mergeClarityPages` instead of its own loop.
- [ ] **Step 4:** Run `cd backend && node --test`. Expected: all pass, including the existing `alerts.test.mjs`.
- [ ] **Step 5:** Commit `feat(reportes): Clarity por período desde las fotos diarias`.

### Task 2: Web sales (`webSales.mjs`)

**Files:**
- Create: `backend/webSales.mjs`
- Test: `backend/test/webSales.test.mjs`

**Interfaces:**
- Consumes: `computeTotals(docs)` and `computeDelta` / `computeInflationAdjustedDelta` from `aggregate.mjs`; `dailyStacked(curDocs, prevYearDocs, {start, end, prevYearFactor})` from `resumen.mjs` (with ecommerce docs only, it fills just the `web` group).
- Produces: `webSalesSummary({ curDocs, prevDocs, prevYearDocs, range, inflation: {currentIndex, prevYearIndex}, prevYearFactor }) → { kpis: { revenue, orders, units, avgTicket }, daily: {bucket, rows} }`.
  - Each KPI is `{ value, vsPrev: pct|null, vsYear: pct|null, yearAdjusted: bool }`.
  - Money KPIs `vsYear` is inflation-adjusted when both indexes exist; counts are never adjusted.
  - Only `channel === 'ecommerce'` and `status === 'completed'` count, so docs from other channels passed in by mistake are ignored.

- [ ] **Step 1: Write the failing tests:**
  - `webSalesSummary: only completed ecommerce docs`. A completed ecommerce doc of 100, a cancelled one, and a local_lomas doc give revenue 100 and orders 1.
  - `webSalesSummary: vsPrev and vsYear`. Current 200, prev 100, prevYear 100 with indexes 200/100 give vsPrev 100, vsYear 0 and `yearAdjusted` true. With no indexes: vsYear 100 and `yearAdjusted` false.
  - `webSalesSummary: daily uses the web group only`. Each `rows[i].total` equals that day's ecommerce revenue.
- [ ] **Step 2:** Run `node --test test/webSales.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `node --test`. Expected: all pass.
- [ ] **Step 5:** Commit `feat(reportes): ventas web para la pestaña Web`.

### Task 3: `/api/v2/web` endpoint

**Files:**
- Create: `backend/webReport.mjs`
- Modify: `backend/index.mjs` (route), `backend/eventBehavior.mjs` (daily `limit: 400`; `sku` on item rows)
- Test: `backend/test/webReport.test.mjs`, `backend/test/eventBehavior.test.mjs`

**Interfaces:**
- Consumes: Task 1, Task 2, `prevYearToDate(ranges, today)` (productTab), `getWebBehavior({cur, prev, yoy})`, `queryDailySnapshots(CLARITY_DAILY_COL, start, end)`, `getInflationIndexByMonth`, `inflationFactor`, `isGa4Configured`.
- Produces: `GET /api/v2/web?period&date[&start&end]` behind `requireAuth`, with the same 400/500 handling as `/api/v2/producto`. Response: `{ ok, range, prevRange, prevYear, sales, behavior | null, behaviorError: string | null, clarity, generatedAt }`.
  - `behavior` is `shapeBehavior`'s output plus `items.*[].sku`, which is null when the name doesn't match.
  - `getWebBehavior` is called with `yoy = prevRange`. That equals the full prev-year window when the period is closed, so the Resumen's cache key is the same and GA4 isn't called again.
- Pure helper for tests: `webPlan(ranges, today) → { prevRange, gaRanges: {cur, prev, yoy} }` in `webReport.mjs`.

- [ ] **Step 1: Write the failing tests:**
  - `webPlan: closed week → yoy is the full prev-year week` (same object values as `ranges.prevYear`).
  - `webPlan: running week on Wednesday → yoy and prevRange cut to Mon–Wed`.
  - In `eventBehavior.test.mjs`, `shapeBehavior: item rows carry the matched sku (null if no match)`.
  - A `fetchRaw` daily-limit test is not practical without GA4. Instead export `BEHAVIOR_DAILY_LIMIT` and assert it is ≥ 366.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `webPlan` and `buildWeb(params, {now})`. GA4 is wrapped in `.catch`, which sets `behavior: null` and `behaviorError: 'GA4 no respondió'`; when GA4 isn't configured the message is `'GA4 no configurado'`. Clarity failure gives `{days: 0, totalDays}`. Also add `getWeb(params)` with a 5-minute cache keyed by the resolved range, the route, the eventBehavior changes, and `export const BEHAVIOR_DAILY_LIMIT = 400`.
- [ ] **Step 4:** Run `node --test`. Expected: all pass.
- [ ] **Step 5: Live check.** Run a local server on port 3011 with the scratch script and log in from `.env` without printing it. For week `2026-11-02`, `sales.kpis.revenue.value` must equal the ecommerce revenue of `/api/report?period=week&date=2026-11-02&channels=ecommerce`, and `behavior.totals.cur.sessions` must equal the Resumen's GA4 sessions for the same week. Also check a running week (`date=` today) gives `prevRange.partial` true, and that a request without a token gets 401. Record the numbers in the ledger, then delete the script.
- [ ] **Step 6:** Commit `feat(reportes): endpoint de la pestaña Web`.

### Task 4: Web tab: sales and GA4

**Files:**
- Create: `frontend/src/nuevo/web/Web.jsx`, `WebSalesCard.jsx`, `BehaviorKpis.jsx`, `FunnelCard.jsx`, `SourcesCard.jsx`, `SplitCard.jsx`, `ViewedCategoriesCard.jsx`, `ItemsCard.jsx`, `SearchesCard.jsx`, `EntryCard.jsx` (landings, hours, regions)
- Modify: `frontend/src/api/client.js` (`getWeb(params)`), `frontend/src/nuevo/NuevoApp.jsx` (`case 'web'`), `frontend/src/nuevo/nuevo.css`

**Interfaces:**
- Consumes: Task 3's response; `DailyStacked` from `resumen/` (it takes `daily` and `prevYear`); `money`, `pct`, `pp`, `num`, `toneOf` from `format.js`; `onUpdate({sku}, {push:true})` to open the product sheet.
- Produces: the Web tab. Its order follows the meeting:
  1. **Venta web:** 4 KPIs (facturación, pedidos, ticket, unidades) with vs. prev and vs. year pills. The year label reads "vs. 2025 hasta el DD/MM" when `prevRange.partial`, plus the daily chart.
  2. **Comportamiento:** sessions, conversion (in pp vs prev and vs year), pages per session, time per session.
  3. **Embudo**, cur vs prev period.
  4. **Fuentes:** sessions, share, conversion, purchases and vs prev, sorted by sessions. Rows whose conversion is under ⅓ of the site average are marked amber.
  5. Mobile vs desktop and new vs returning (`SplitCard` used twice).
  6. **Categorías vistas vs compradas:** views, cart rate, purchase rate, with no year column.
  7. **Productos:** a segmented control with three views: *Más vistos*, *Mucho interés, poca venta*, *Mejor conversión*. Rows with a `sku` open the sheet.
  8. **Búsquedas** (top 20).
  9. **Por dónde y cuándo entran:** landing pages, hours (24 CSS bars), regions.

  When `behavior` is null, sections 2–9 become one card showing `behaviorError`.

- [ ] **Step 1:** Write the components. There is no unit test for them; the pure logic is in Tasks 1–3. Loading, error and retry follow `Producto.jsx`.
- [ ] **Step 2:** Run `cd frontend && npx vitest run && npx vite build`. Expected: PASS / built.
- [ ] **Step 3:** Commit `feat(reportes): pestaña Web (ventas y comportamiento)`.

### Task 5: Clarity card

**Files:**
- Create: `frontend/src/nuevo/web/ClarityCard.jsx`
- Modify: `Web.jsx`, `nuevo.css`

**Interfaces:**
- Consumes: `clarity` from Task 3.
- Produces: an **Experiencia (Clarity)** card placed after Comportamiento.
  - Header "N de M días con datos". When `days === 0`, the text is "Sin datos de Clarity para este período (se guardan desde el 13/11/2026)".
  - 5 figures: rage clicks %, dead clicks %, quickbacks %, average scroll %, active time.
  - A per-page table: path, sessions, rage, dead, quickback, scroll. Rage ≥ 5% or dead ≥ 20% shows red, using the thresholds from `alertConfig.mjs` mirrored as constants with a comment.
  - A link "Ver mapas de calor en Clarity ↗" (`target="_blank" rel="noopener"`).
  - A note: "Clarity cuenta sesiones distinto que GA4; no se comparan."

- [ ] **Step 1:** Write the card.
- [ ] **Step 2:** Run `npx vitest run && npx vite build`. Expected: PASS / built.
- [ ] **Step 3:** Commit `feat(reportes): Clarity en la pestaña Web`.

### Task 6: Verification and delivery

- [ ] Browser pass on local backend + Vite:
  - week 2026-11-02 (closed);
  - current week (partial label);
  - month 2026-10;
  - custom 90 days (daily goes weekly; GA4 daily isn't cut);
  - click a product in Productos to open the sheet;
  - a Resumen alert with `tab: 'web'` lands here;
  - 390 px with no horizontal page scroll.
- [ ] Check the 13/11 Clarity snapshot exists (read-only script with `getDailySnapshot`). If it does, the card shows "1 de 7 días" for this week.
- [ ] Production build (Railway URL only), push, deploy SUCCESS, 401 without a token.
- [ ] Final whole-branch review by a fresh reviewer on the most capable model, then one fix pass.
