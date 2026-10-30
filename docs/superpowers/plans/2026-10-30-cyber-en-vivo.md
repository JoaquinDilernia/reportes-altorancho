# Cyber en vivo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Cyber/Black tab into a dark, animated "live" event page (flap counter, goal track, today ring, live sales feed, ticker, celebrations, categories vs 2025 with stock, ads pacing, day-by-day ads+sales table) fed by sales synced every 5 minutes.

**Architecture:** Backend adds pure logic in `events.mjs` (floor, status, projection, hourly curve, feed) and a new `eventCategories.mjs`; `eventReport.mjs` splits into a 60-min cached "static" input bundle (2025, inflation, products, baselines) and a 2-min cached live recompute; `index.mjs` adds a 5-min sales cron and 30-min ads cron while an event is active. Frontend replaces `EventPanel.jsx` with a page composed of small components under `frontend/src/components/event/`, themed by its own scoped CSS, polling `/api/event` every 2 min.

**Tech Stack:** Node ESM + Express + Firestore + `node-cron`, `node --test`; React 18 + Vite + Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-cyber-en-vivo-design.md` (approved mockup: `.superpowers/brainstorm/2026-1793365104/content/mix-v3.html`, not in git — copy its CSS/markup as the visual reference).

## Global Constraints

- Backend changes are **additive**: the currently published frontend must keep working against the new `/api/event` (add fields, never rename/remove). Railway auto-deploys every push to `main`.
- Work on `main`, no worktree. Commit per task, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Floor = 2025 aligned day revenue × inflation factor. Target = floor × (1 + `TARGET_REAL_GROWTH[group]`) (web 0.10, locales 0.05). Channels without 2025 history (Alcorta): floor = target = weekday baseline.
- Status values (exact strings): `'bajo_piso'` (revenue < floor), `'entre'` (floor ≤ revenue < target), `'sobre'` (revenue ≥ target).
- Google ROAS shown is **total** (brand included). Google value = GA4 `google / cpc` purchaseRevenue (already in `purchaseValue`).
- 2025 ad spend shown inflation-adjusted with the day's factor; note says so.
- No customer personal data in the feed (product, channel, province, amount, time only).
- Web revenue without IVA nor shipping, locales with IVA; days in ART (`argDay`).
- Never show interpolated/invented sales: counters animate only between real fetched values.
- Respect `prefers-reduced-motion` (no flap/runner/toast animation, values shown directly).
- Before handing off `frontend/dist`, run `grep -o 'https\?://[a-z0-9.-]*\(railway\|localhost\)[a-z0-9.:-]*' frontend/dist/assets/*.js` → must print only the Railway URL.

## Review Focus

- **Black before it starts / event over**: `today < current.start` → no played days, revenue 0, projection null, feed empty; page shows a countdown, not NaN/Infinity. Test in Task 2 (`projectClose` with no played days returns null) and Task 7 (page renders "faltan N días").
- **Launch day / today partially played**: today counts as played with partial revenue; status for today must not read "bajo piso" just because the day isn't over — today's status uses `expectedShare` from the hourly curve. Test in Task 2 (`dayStatusSoFar`).
- **Zero floor/target** (a 2025 ref day with no sales, Alcorta-only): status and pct must not divide by zero → `pct` null, status by plain comparison. Test in Task 2.
- **Sale items with SKUs not in products / discount lines (negative price)**: go to `'otros'` / are dropped; never crash the categories block. Test in Task 3.
- **Overlapping crons**: the 5-min live sync must skip while the 4-h full sync (or a previous live sync) is running, and a failing sub-sync must not stop the others. Covered by the shared `syncRunning` lock in Task 5 (verified by log output).

---

### Task 1: Store the Odoo category path on products

**Files:**
- Modify: `backend/sync/products.mjs` (the `for (const doc of productDocs)` loop near the end)

**Interfaces:**
- Produces: every `altorancho_reportes_products` doc gets `odooCategPath: string | null` (raw `categ_id[1]`, e.g. `'All / Biblia/ MUEBLES / SILLAS / SILLA / SILLA / TUBE'`).

- [ ] **Step 1:** In the loop that sets `stockByLocation`/`odooTemplateId`, add `doc.odooCategPath = odooProduct?.categ_id?.[1] ?? null;` (TN-sourced products get it too, via `odooBySku`).
- [ ] **Step 2:** Run `cd backend && npm test` → all existing tests PASS.
- [ ] **Step 3:** Run a live product sync locally: `node -e "import('./sync/products.mjs').then(m=>m.syncProducts()).then(r=>{console.log(r.count);process.exit(0)})"` (from `backend/`, `.env` loaded via `import 'dotenv/config'` the same way `backfill.mjs` does). Then read one SKU from Firestore and confirm `odooCategPath` is set.
- [ ] **Step 4:** Commit `feat(reportes): guardar categoría Odoo (Biblia) en productos`.

### Task 2: Event pure logic — floor, status, hourly curve, projection, feed

**Files:**
- Modify: `backend/events.mjs`
- Test: `backend/test/events.test.mjs`

**Interfaces:**
- Produces (all exported from `events.mjs`):
  - `buildEventDays` cells gain `floor: number`; `totals[group]` gains `floor`, `floorToDate`, `status`. Existing fields unchanged.
  - `statusOf(revenue: number, floor: number, target: number): 'bajo_piso'|'entre'|'sobre'`
  - `hourlyShareCurve(salesDocs): number[24]` — cumulative share (0..1) of completed revenue by end of each ART hour across all days of the docs; all zeros in → linear `(h+1)/24`.
  - `expectedShare(curve: number[24], nowIso: string): number` — share expected by now: `curve[h-1]` + fraction of hour h × (`curve[h]` − `curve[h-1]`), with `curve[-1]` = 0, using `argHour` and minutes in ART.
  - `dayStatusSoFar(cell, share: number): { pct: number|null, status }` — compares `cell.revenue` to `cell.floor*share` and `cell.target*share`; `pct` = revenue ÷ (target×share) ×100 rounded 1 decimal, null when that is 0.
  - `projectClose(days, group, todayShare: number): number|null` — pace = revenueToDate ÷ (Σ target of played days before today + today target × todayShare); projected = revenueToDate + pace × (today target × (1−todayShare) + Σ target of future days). Null when no played day or denominator 0.
  - `recentSales(salesDocs, limit = 12): Array<{ date, channel, province: string|null, label: string, itemCount: number, total: number }>` — completed only, newest first; `label` = name of the highest-`qty*unitPrice` item with `unitPrice >= 0`, `itemCount` = items with `unitPrice >= 0`.
  - `activeEvent(today: string): string|null` — id of the `EVENTS` entry whose `current.start <= today <= current.end`.

- [ ] **Step 1: Write failing tests** in `events.test.mjs`:
  - `statusOf`: `(90,100,110)→'bajo_piso'`, `(100,100,110)→'entre'`, `(110,100,110)→'sobre'`, `(0,0,0)→'sobre'`.
  - `buildEventDays floor`: reuse the existing buildEventDays fixture; assert for a history channel day `cell.floor === prevRevenue * inflationFactor` and `cell.target ≈ cell.floor * 1.10` (web); for Alcorta-only fixture `floor === target`; `totals.web.floorToDate` sums only played days.
  - `hourlyShareCurve`: two docs, $100 at ART 10:xx and $300 at ART 20:xx → `curve[9]===0`, `curve[10]===0.25`, `curve[20]===1`, `curve[23]===1`; `[]` → `curve[11]===0.5`.
  - `expectedShare`: curve linear, now = `'2026-11-02T15:30:00Z'` (12:30 ART) → `≈ 12.5/24`.
  - `dayStatusSoFar`: `{revenue:50, floor:100, target:110}`, share 0.5 → `status 'entre'`, `pct 90.9`; share 0 → `pct null`.
  - `projectClose`: 3 days targets 100/100/100, day1 played revenue 120, day2 is today revenue 30 with share 0.25, day3 future → pace = 150/125 = 1.2 → projected = 150 + 1.2×(75+100) = 360. No played days → null.
  - `recentSales`: completed/pending mix, discount line negative price ignored, newest first, limit respected, no customer fields in output (`Object.keys` exactly the six above).
  - `activeEvent('2026-10-30') === 'cyber'`, `activeEvent('2026-11-20') === null`, `activeEvent('2026-11-27') === 'black'`.
- [ ] **Step 2:** `cd backend && node --test test/events.test.mjs` → new tests FAIL (not exported).
- [ ] **Step 3:** Implement in `events.mjs` per the Interfaces above. In `buildEventDays` add `floor` to `emptyCell()` and accumulate `hasHistory ? prev.revenue*factor : baseline[weekday]`; totals get `floor`, `floorToDate` (played days) and `status = statusOf(revenue, floorToDate, targetToDate)`.
- [ ] **Step 4:** `npm test` → all PASS.
- [ ] **Step 5:** Commit `feat(reportes): piso, estado, proyección y feed para el evento`.

### Task 3: Categories 2025 vs 2026 with stock

**Files:**
- Create: `backend/eventCategories.mjs`
- Test: `backend/test/eventCategories.test.mjs`

**Interfaces:**
- Produces:
  - `EVENT_CATEGORIES: Array<{ id, label }>` in display order: `sillas` Sillas, `iluminacion_inalambrica` Iluminación inalámbrica, `iluminacion` Iluminación, `escritorios` Escritorios, `comodas` Cómodas, `mesas_comedor` Mesas de comedor, `mesas_ratonas` Mesas ratonas, `mesas_luz` Mesas de luz, `mesas_arrime` Mesas de arrime, `consolas` Consolas, `bancos` Bancos y banquetas, `otros_muebles` Otros muebles, `textil` Textil, `deco` Deco, `bazar` Bazar, `otros` Otros.
  - `eventCategoryOf(product: { name, odooCategPath } | undefined, itemName?: string): string` — rules in order: name (product or item) matches `/INAL[AÁ]MBRIC/i` → `iluminacion_inalambrica`; parse path by `/`, trim, drop `All` and `Biblia`; level1 = first, level2 = second, level3 = third, all upper-cased with accents stripped. `MUEBLES`+`SILLAS` → `sillas`; `ILUMINACION` → `iluminacion`; `MUEBLES` + level3 in {ESCRITORIO→escritorios, COMODA→comodas, MESA COMEDOR|MESA DE COMEDOR→mesas_comedor, MESA RATONA→mesas_ratonas, MESA DE LUZ→mesas_luz, MESA DE ARRIME→mesas_arrime, CONSOLA→consolas, BANCO|BANQUETA→bancos} else `otros_muebles`; `TEXTIL`/`DECO`/`BAZAR` → same id lower-case; anything else or no product → `otros`. Keep the level3 map as one constant object so it's easy to edit.
  - `summarizeCategories({ prevDocs, prevToDateDocs, currentDocs, productsBySku, factorByRefDate: Map<string, number> }): Array<{ id, label, prevUnits, prevRevenueAdj, prevUnitsToDate, prevRevenueToDateAdj, units, revenue, stock, cantMatch: boolean, topProducts: Array<{ sku, name, units, revenue }> }>` — only completed sales, items with `unitPrice >= 0`; revenue per item = `qty*unitPrice`; 2025 revenue × `factorByRefDate.get(argDay(doc.date)) ?? 1`; `stock` = sum of all values in `stockByLocation` over the category's products (includes mayorista and depósito); `cantMatch = units + stock < prevUnits`; `topProducts` = top 5 by 2026 units; omit categories with zero in both years; keep `EVENT_CATEGORIES` order.

- [ ] **Step 1: Write failing tests:** `eventCategoryOf` with the real paths `'All / Biblia/ MUEBLES / SILLAS / SILLA / SILLA / TUBE'`→sillas, `'All / Biblia/ ILUMINACION / ILUMINACION MESA / VELADOR / VELADOR / MAOZI'` + name `'LAMPARA DE MESA LED INALAMBRICA CONO VINO'`→iluminacion_inalambrica, same path other name→iluminacion, `'All / Biblia/ MUEBLES / MUEBLES / ESCRITORIO / ESCRITORIO / X'`→escritorios, `'All / Biblia/ MUEBLES / COMODA / COMODA / COMODA / X'`→comodas, `'All / Biblia/ MUEBLES / PERCHERO / PERCHERO / PERCHERO / X'`→otros_muebles, `'All / Biblia/ TEXTIL / MANTAS / ...'`→textil, `undefined`→otros. `summarizeCategories`: fixture with 2 chairs SKUs, one unknown SKU, one negative discount line, a pending order; assert units/revenue per year, factor applied to 2025 revenue, stock summed across locations, `cantMatch` true when `units+stock < prevUnits`, unknown SKU in `otros`, discount line and pending order ignored.
- [ ] **Step 2:** `node --test test/eventCategories.test.mjs` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(reportes): categorías del evento 2025 vs 2026 con stock`.

### Task 4: Event report — static/live split and new fields

**Files:**
- Modify: `backend/eventReport.mjs`

**Interfaces:**
- Consumes: Task 2 functions, Task 3 `summarizeCategories`, `getSyncMetadata` from `firestore.mjs`.
- Produces (added to the `/api/event` response; existing fields untouched):
  - `days[i].ads.prevAdj: { meta: { spend, value }, google: { spend, value } }` — 2025 spend/value × `day.inflationFactor`.
  - `days[i].ads.plan: { meta, google }` — planned spend from `investment.days[i]`.
  - `live: { updatedAt: string|null (ecommerce lastSyncedAt), now: string (ISO), todayShare: { web, locales }, todayStatus: { web, locales, total } ({pct,status} from dayStatusSoFar; total uses summed cells and web curve), projection: { web, locales, total } (projectClose; total = web+locales or null), feed: recentSales(currentSales, 12), topProductToday: { name, units }|null, peakHourYesterday: { hour, revenue }|null, categories: summarizeCategories(...) }`.
  - `curves: { web: number[24], locales: number[24] }` from 2025 window docs per group.
- Cache: `getStaticInputs(eventId)` caches the Promise of everything not depending on current sales/ads (`indexByMonth, productsBySku, prevSales, baselineSales, recapBaselineSales, prevAds, sharesAds, sharesWebSales, brandPrev, brandRecent`) for **60 min**; `getEventReport(eventId)` keeps its Map cache but TTL **2 min**, and on each miss fetches only `currentSales`, `currentAds`, sync metadata and recomputes everything else from the static bundle. Keep the existing `promise.catch(() => cache.delete(...))` pattern for both caches.
- `prevToDateDocs` for categories = `prevSales` whose ART day is a `refDate` of a played day; `factorByRefDate` = `refDate → inflationFactor` from `result.days`.

- [ ] **Step 1:** Implement the split and fields.
- [ ] **Step 2:** `npm test` → PASS (pure tests unaffected).
- [ ] **Step 3:** Live check: start `node index.mjs` locally, `curl -H "Authorization: Bearer <token from /api/auth/login>" "localhost:3055/api/event?event=cyber"` (port per `.env`) and confirm: `live.feed` has recent real orders with no customer fields; `live.categories` has `sillas` and `iluminacion_inalambrica` with plausible 2025 units; `days[0].ads.prevAdj.meta.spend > days[0].ads.prev.meta.spend`; old fields (`totals`, `investment`, `previousRecap`, `previousAds`) still present; second call within 2 min returns instantly. Also `?event=black` returns with `live.projection.total === null` and empty feed.
- [ ] **Step 4:** Commit `feat(reportes): reporte de evento en vivo (caché estático/vivo, feed, categorías)`.

### Task 5: Live sync crons during an event

**Files:**
- Modify: `backend/index.mjs` (around `runFullSync` / `cron.schedule`)

**Interfaces:**
- Consumes: `activeEvent(today)` and `argDay` from `events.mjs`; `syncEcommerce`, `syncLocales`, `syncPosLocales`, `syncMetaAds`, `syncGoogleAds`; `getProductsBySku`.
- Produces: module-level `let categoryBySkuCache = null` set from `runFullSync`'s `syncProducts()` result; `async function getCategoryBySku()` returns the cache or builds `Map(sku → category)` once from `getProductsBySku()`.

- [ ] **Step 1:** Add `runLiveSalesSync()`: return early unless `activeEvent(argDay(new Date().toISOString()))`; skip with a log if `syncRunning`; else set `syncRunning`, run `syncEcommerce(cat)`, `syncLocales(cat)`, `syncPosLocales(cat)` each in its own try/catch (log `[cron:live] <name> error:`), release in `finally`. Schedule `*/${LIVE_SYNC_MINUTES} * * * *` with `LIVE_SYNC_MINUTES = parseInt(process.env.LIVE_SYNC_MINUTES || '5', 10)`.
- [ ] **Step 2:** Add `runLiveAdsSync()` same guards, `syncMetaAds({ daysBack: 2, includeAdLevel: false })` and `syncGoogleAds({ daysBack: 2 })`, scheduled `*/30 * * * *`.
- [ ] **Step 3:** Run locally for ~6 minutes; confirm logs show `[sync:ecommerce] N órdenes sincronizadas` from the live cron and that `altorancho_reportes_sync_metadata/ecommerce.lastSyncedAt` advanced.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(reportes): sync de ventas cada 5 min y pauta cada 30 min durante el evento`, push to `main`, watch Railway logs for the first live run.

### Task 6: Frontend pure helpers

**Files:**
- Create: `frontend/src/lib/eventLive.js`
- Test: `frontend/src/lib/eventLive.test.js`

**Interfaces:**
- Produces:
  - `STATUS_LABELS = { bajo_piso: 'bajo piso', entre: 'entre piso y obj.', sobre: 'sobre obj.' }`
  - `groupView(data, view: 'total'|'web'|'locales')` → `{ revenue, orders, floor, target, floorToDate, targetToDate, prevRevenue, status, projection, today: { revenue, floor, target, pct, status }, todayPrev: number }` (total = web + locales sums; today = the day with `date === data.today`).
  - `crossedMilestones(prev: view|null, next: view): Array<'piso_dia'|'objetivo_dia'|'piso_evento'|'objetivo_evento'>` — a milestone is crossed when `next` value ≥ threshold and (`prev` null or `prev` value < threshold); thresholds: today.floor, today.target, floor, target (event totals, full window). Zero thresholds never fire.
  - `MILESTONE_COPY = { piso_dia: '¡Pasamos el piso de HOY!', objetivo_dia: '¡Pasamos el objetivo de HOY!', piso_evento: '¡Pasamos el PISO del {label}!', objetivo_evento: '¡OBJETIVO del {label} cumplido!' }`
  - `minutesAgo(iso, nowMs) → number`
  - `buildTicker(data, view) → string[]` — from real data only: crossed milestones already reached, `🔥 {topProductToday.name}: {units} vendidas hoy`, `📈 Hora pico de ayer: {h} a {h+1} h, {money}`, `⚠ {category}: quedan {stock} en stock` for each `cantMatch`, `🎯 Faltan {money} para el piso|objetivo del {label}` (next unmet). Empty fields skipped.
  - `seenMilestones` helpers: `loadSeen(eventId)`/`markSeen(eventId, id)` using `sessionStorage`, wrapped in try/catch.

- [ ] **Step 1:** Failing vitest tests: `crossedMilestones(null, view with revenue past floor)` → includes `'piso_evento'` only for reached ones; prev already past → not repeated; zero target → never fires; `groupView` total sums web+locales; `buildTicker` with no topProduct omits that line and includes one `⚠` line per `cantMatch`.
- [ ] **Step 2:** `cd frontend && npx vitest run src/lib/eventLive.test.js` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(reportes): helpers del evento en vivo (metas, ticker)`.

### Task 7: Live event page

**Files:**
- Create: `frontend/src/components/event/` — `EventLive.jsx` (page: fetch + 2-min polling + view/event selectors + celebration queue), `FlapCounter.jsx`, `GoalTrack.jsx`, `TodayRing.jsx`, `SalesFeed.jsx`, `Ticker.jsx`, `CelebrationToast.jsx`, `CategoryRace.jsx`, `AdsPacing.jsx`, `DayByDayTable.jsx`, `EventDetails.jsx` (folded `<details>`: `InvestmentPlan`, `Assumptions`, `PastEventRecap` moved from `EventPanel.jsx`)
- Create: `frontend/src/styles/event.css` (all rules scoped under `.event-live`, CSS variables from the mockup's `:root` moved onto `.event-live`); import from `EventLive.jsx`
- Modify: `frontend/src/pages/Dashboard.jsx` (render `EventLive` instead of `EventPanel`); delete `frontend/src/components/EventPanel.jsx` once its pieces are moved.

**Interfaces:**
- Consumes: `getEventReport(eventId)` (existing client), Task 6 helpers, response fields from Task 4.
- Component props: `FlapCounter({ value })` animates only digits that changed from the previous `value`; `GoalTrack({ value, floor, target })` positions flags at floor/max and target/max with max = target×1.1; `TodayRing({ pct })`; `SalesFeed({ items, now })`; `Ticker({ items })`; `CelebrationToast({ message, onDone })` auto-hides after 3.5 s; `CategoryRace({ categories })` with hover tooltip (2025 adj. vs 2026 revenue + top 5); `AdsPacing({ days })` cumulative played-day spend vs plan per platform, ROAS 2026 vs 2025; `DayByDayTable({ days, group, today })`.
- Layout and copy follow the mockup: ticker, topbar ("Alto**Cyber** 26"/"Alto**Black** 26", "en vivo · {weekday d/m} · {phase} · act. hace N min", Cyber/Black and Total/Web/Locales segmented controls), hero (flap counter, sub-line, track, 4 tiles: Hoy / Si seguimos así / Pauta invertida / ROAS Meta · Google), side (ring + web/locales status + hoy vs 2025, feed), Categorías, Pauta acumulada vs plan, Día por día, folded details.
- Day-by-day table columns exactly: Día | Meta: Inv. 25, Inv. 26, ROAS 25, ROAS 26 | Google: Inv. 25, Inv. 26, ROAS 25, ROAS 26 | Facturación: 2025 ajust., Objetivo, Real 2026, Estado. First row "Total a hoy" (played days). Today row highlighted with `⏳` and status from `live.todayStatus`; future rows show "plan $X" in Inv. 26 and `—` in real. Official days highlighted. Facturación columns follow the view selector; ads columns always web-level. Footnote: 2025 ajustada = piso; inversión 2025 también ajustada por inflación; Google medido con GA4 (google / cpc), incluye búsqueda de marca.
- `Assumptions` (in `EventDetails`) gains one line: "Proyección: lo vendido + el objetivo de los días que faltan × el ritmo actual contra el objetivo (el día de hoy se pondera con la curva horaria de {prevYear})."
- Before `current.start`: hero shows "Faltan N días" + 2025 recap numbers instead of the counter; feed hidden.
- Celebrations: on each fetch compute `crossedMilestones(prevView, nextView)`, drop ids already in `loadSeen`, show queued toasts one at a time, `markSeen`.

- [ ] **Step 1:** Build the components and CSS; wire into `Dashboard.jsx`.
- [ ] **Step 2:** `cd frontend && npm test && npm run build` → PASS, build succeeds.
- [ ] **Step 3:** Commit `feat(reportes): página Cyber en vivo`.

### Task 8: End-to-end check and handoff

- [ ] **Step 1:** Run frontend locally against Railway (`VITE_API_URL=<Railway URL> npm run dev`), open the Cyber tab in the browser (warn Joaquín before taking over Chrome). Check: numbers match `/api/event` totals; Web/Locales/Total switch updates hero, categories and the Facturación columns; Black tab shows countdown; table shows 18 rows + total; no console errors; resize to 390 px wide → readable, no horizontal page scroll (table scrolls inside its panel); with OS reduced-motion on, no animations.
- [ ] **Step 2:** Cross-check one day against Odoo: web revenue of yesterday in the table vs a direct Odoo sum of `sale.order` (team 1, `tiendanube_order_id` set, state sale/done) `amount_untaxed` minus shipping for that ART day.
- [ ] **Step 3:** `npm run build` (uses `.env.production`), run the dist URL grep from Global Constraints, hand `frontend/dist/` to Joaquín to upload.
