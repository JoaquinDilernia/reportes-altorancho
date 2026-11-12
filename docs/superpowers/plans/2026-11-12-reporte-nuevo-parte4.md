# Reporte nuevo, parte 4: pestaña Locales — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Locales tab of the new report: the three stores side by side, sales per day and per hour, and a selector to drill into one store (top sellers, categories, origin, payment methods and the store's stock).

**Architecture:** A new `GET /api/v2/locales` endpoint (`backend/localesReport.mjs`) reads the POS sales of the three stores for the period, the previous period and last year (both cut to the same elapsed days while the period runs, via `webPlan` from `webReport.mjs`). Pure helpers live in `backend/localesTab.mjs`. All three stores' detail comes in one response, so switching stores is instant. The frontend gets `frontend/src/nuevo/locales/` with `.nv` cards; the selected store lives in the URL (`?loc=`).

**Tech Stack:** Node ESM + `node --test`, Firestore, React 18 + Vite + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-reporte-normal-rediseno-design.md` (section "Locales", plus "Depósitos en Odoo", "Stock: siempre a hoy", "Estética"). Previous plans: `2026-11-12-reporte-nuevo-parte1.md` … `-parte3.md`.

## Global Constraints

- Stores: `local_lomas` (Lomas), `local_belgrano` (Belgrano), `local_alcorta` (Alcorta). Colors from `frontend/src/lib/channels.js`.
- Store stock = mini depot (`<x>_stock`) + exhibition (`<x>_exhibicion`) from `stockByLoc`; "Rolón" = `LOC_GROUPS.rolon` (`rolon`, `mayorista`, `alcorta_en_rolon`). Stock is always today's and labelled "stock a hoy".
- Money vs. last year is inflation-adjusted when INDEC has the month, otherwise labelled "nominal". Counts (tickets, units) are never adjusted.
- A running period is compared with the same elapsed days of the previous period and of last year (`webPlan(ranges, today)`), with the "Período en curso" note like the Web tab.
- Hours are Argentina time (`argHour` from `events.mjs`, UTC−3).
- Only `status === 'completed'` docs count (same as `computeTotals`, so totals match the Resumen's per-channel numbers).
- Brand: white and `#353434`, Poppins, `.nv` classes, `tabular-nums`, compact amounts. Must look right projected and at 390 px with no horizontal page scroll.
- Commits go straight to `main` ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never run `node index.mjs` locally; use a scratch script importing `{ app }` with `TZ=UTC` and `CLARITY_API_TOKEN=''`, then delete it. Check `dist` points only to Railway.

## Review Focus

- **A store with no sales in the period** (holiday, closed): its card shows $0 and "—" for ticket and units per ticket, never NaN or Infinity; shares still add up. Test in Task 1.
- **Sale after 21:00 ART** (next UTC day): it lands in its Argentina hour (e.g. 22 h), not 1 h. Test in Task 1.
- **Top model with no stock entry** (product doc missing or old `stockByLocation` keys only): stock columns show 0, no crash. Test in Task 1.
- **Running week:** "vs. sem. ant." and "vs. 2025" use the same elapsed days (reused `webPlan`, already tested); the page shows the "Período en curso" note. Checked live in Task 4.
- **Unknown `?loc=` in the URL:** falls back to Lomas. Test in Task 3.

---

### Task 1: Pure helpers (`localesTab.mjs`)

**Files:**
- Create: `backend/localesTab.mjs`
- Test: `backend/test/localesTab.test.mjs`

**Interfaces:**
- Consumes: `computeTotals`, `computeDelta`, `computeInflationAdjustedDelta` (`aggregate.mjs`); `argHour` (`events.mjs`); `summarizeCategories`, `compareTopProducts` (`eventCategories.mjs`); `summarizeOrigins` (`eventOrigins.mjs`); `modelStock`, `warehouses` (`productTab.mjs`); `LOC_GROUPS` (`stockLocations.mjs`).
- Produces:
  - `LOCALES = [{ id: 'lomas', label: 'Lomas', channel: 'local_lomas', stockKey: 'lomas_stock', exhibitionKey: 'lomas_exhibicion' }, …belgrano, alcorta]`.
  - `localesSideBySide({ curDocs, prevDocs, yearDocs, inflation: { currentIndex, prevYearIndex } }) → { locales: Row[], total: Row }` where `Row = { id, label, revenue, orders, units, avgTicket, unitsPerTicket (null if 0 orders), sharePct (of the three stores, 1 decimal), vsPrev: { revenue, orders, avgTicket, unitsPerTicket }, vsYear: { same keys }, yearAdjusted }`. `total.id = 'total'`, `total.label = 'Total locales'`, `total.sharePct = 100` when there is revenue. Deltas are `computeDelta(...).pct` (null when the base is 0); `vsYear.revenue` and `vsYear.avgTicket` use `computeInflationAdjustedDelta` when both indexes exist.
  - `localesByHour(curDocs) → { from, to, rows: [{ hour, byLocal: { lomas: { orders, revenue }, … } }] }`. Rows cover every hour from the first to the last hour with a sale (any store), inclusive; `{ from: null, to: null, rows: [] }` with no sales.
  - `localDetail({ local, curDocs, prevDocs, productsBySku, originBySku, factorByRefDate }) → { topModels, categories, origins, payments, stock }`:
    - `curDocs`/`prevDocs` are already filtered to that store (prev = last year's cut window).
    - `topModels`: `compareTopProducts(..., limit: 15)` rows plus `local: { stock, exhibition }` and `rolon` (sum of `LOC_GROUPS.rolon` in the model's `byLoc`), all 0 when the model has no stock entry.
    - `categories`: `summarizeCategories` rows with `units > 0`, mapped to `{ id, label, units, revenue, prevRevenueToDateAdj }`, sorted by revenue desc.
    - `origins`: `summarizeOrigins(...)` or `null` when `originBySku` is empty/null.
    - `payments`: `[{ method, orders, revenue, sharePct }]` by revenue desc; a doc without `paymentMethod` goes to `'Sin dato'`.
    - `stock`: `{ stock: { units, products }, exhibition: { units, products } }` from `warehouses(productsBySku)` for the store's two keys.

- [ ] **Step 1: Write the failing tests** in `backend/test/localesTab.test.mjs` (doc helper like `webSales.test.mjs`: `{ id, channel, status, date, total, paymentMethod, items: [{ sku, qty, unitPrice }] }`):
  - `localesSideBySide: per store totals, units per ticket and share` — Lomas 2 docs of 100 (qty 2 and 1), Belgrano 1 doc of 200, a cancelled Alcorta doc and a web doc ignored. Expect Lomas `revenue 200, orders 2, avgTicket 100, unitsPerTicket 1.5, sharePct 50`; total `revenue 400, orders 3`.
  - `localesSideBySide: a store with no sales has null ticket metrics` — Alcorta with no docs: `revenue 0, orders 0, avgTicket 0, unitsPerTicket null, sharePct 0, vsPrev.revenue null` (prev also empty).
  - `localesSideBySide: vs year money adjusted, counts nominal` — cur Lomas 200 (1 doc), year 100 (1 doc), indexes 200/100 → `vsYear.revenue 0`, `vsYear.orders 0`, `yearAdjusted true`; without indexes `vsYear.revenue 100`, `yearAdjusted false`.
  - `localesByHour: Argentina hour, gaps filled` — docs at `2026-11-10T13:10:00Z` (10 h, Lomas) and `2026-11-11T01:30:00Z` (22 h, Belgrano, total 50). Expect `from 10, to 22, rows.length 13`, row 22 Belgrano `{ orders: 1, revenue: 50 }`, row 15 all zeros; `localesByHour([])` → `{ from: null, to: null, rows: [] }`.
  - `localDetail: top models carry the store stock and Rolón` — product `MMA008NE` with `stockByLoc { lomas_stock: 3, lomas_exhibicion: 1, rolon: 10, mayorista: 2, belgrano_stock: 9 }` sold 2 u. in Lomas → top model `MMA008` has `local { stock: 3, exhibition: 1 }`, `rolon 12`; a sold SKU missing from `productsBySku` → `local { stock: 0, exhibition: 0 }, rolon 0`.
  - `localDetail: payments by revenue with share` — docs Efectivo 100, Tarjeta 300, no method 100 → `[Tarjeta 60%, Efectivo 20%, Sin dato 20%]` (`sharePct` 1 decimal) with `orders` 1 each.
  - `localDetail: origins null without origin map; stock from the store keys` — `originBySku: null` → `origins null`; `stock.exhibition.units` is the sum of positive `lomas_exhibicion`.
- [ ] **Step 2:** Run `cd backend && node --test test/localesTab.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `backend/localesTab.mjs` with the signatures above. `unitsPerTicket` rounded to 2 decimals; `vsPrev/vsYear.unitsPerTicket` via `computeDelta` on the rounded values (null if either side is null).
- [ ] **Step 4:** Run the same command. Expected: PASS 7/7. Then `cd backend && npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(reportes): cálculos de la pestaña Locales`.

### Task 2: Endpoint `/api/v2/locales`

**Files:**
- Create: `backend/localesReport.mjs`
- Modify: `backend/index.mjs` (route next to `/api/v2/web`), `frontend/src/api/client.js` (`getLocales`)

**Interfaces:**
- Consumes: Task 1; `webPlan` (`webReport.mjs`); `dailyStacked` (`resumen.mjs`); `querySalesByRange`, `getProductsBySku`, `getInflationIndexByMonth` (`firestore.mjs`); `getOriginBySku` (`productOrigin.mjs`); `inflationFactor`, `argDay` (`events.mjs`).
- Produces:
  - `buildLocales({ period, date, start, end }, { now }) → { range, prevRange, prevPeriodRange, prevYear, inflationAdjusted, compare: localesSideBySide(...), daily: dailyStacked(localDocs, localPrevYearDocs, { ...range, prevYearFactor }), hours: localesByHour(...), detail: { lomas, belgrano, alcorta } (localDetail each), stockAsOf, generatedAt }`.
  - `getLocales(params)` with the same 5-minute cache shape as `getWeb` (key `start|end`).
  - Route `GET /api/v2/locales` (requireAuth, `parseReportParams`, `{ ok: true, ...data }`).
  - `client.getLocales(params)` → `getAuthed('/api/v2/locales?' + periodQuery(params), 'Locales fetch failed')`.
- Reads: the three store channels for `current`, `prevPeriodRange` and `prevRange` (three `querySalesByRange` calls), products, inflation, origins (origin failure → `null`, logged, like Producto). Factor for categories/top/origins: one month factor as in `productoReport.mjs`.

- [ ] **Step 1:** Implement `localesReport.mjs`, the route and `getLocales`.
- [ ] **Step 2: Verify live** with a scratch script in the scratchpad (imports `{ app }` from `backend/index.mjs`, `TZ=UTC`, `CLARITY_API_TOKEN=''`, a token from `auth.mjs`'s signer, request `/api/v2/locales?period=week&date=2026-11-02`), then delete it. Expected: each store's `revenue`/`orders` equals `/api/report?period=week&date=2026-11-02&channel=local_<x>` `current.totals`; the three `daily` sums equal `compare.total.revenue`; the hours rows' orders add up to `compare.total.orders`.
- [ ] **Step 3:** `cd backend && npm test`. Expected: all pass.
- [ ] **Step 4: Commit** `feat(reportes): endpoint de la pestaña Locales`.

### Task 3: Frontend tab

**Files:**
- Create: `frontend/src/nuevo/locales/Locales.jsx`, `CompareCards.jsx`, `HoursCard.jsx`, `LocalDetail.jsx`, `localesFormat.js`, `localesFormat.test.js`
- Modify: `frontend/src/nuevo/urlState.js` (+test), `frontend/src/nuevo/NuevoApp.jsx` (`case 'locales'`), `frontend/src/nuevo/nuevo.css`

**Interfaces:**
- Consumes: Task 2 response; `DailyStacked` with `groups` (only the three stores from `GROUPS`), `subtitle "apilado por local"`, `prevLabel`; `OriginsCard` as is; `format.js` (`money`, `num`, `pct`, `toneOf`).
- Produces:
  - `urlState`: `LOCAL_IDS = ['lomas', 'belgrano', 'alcorta']`; `parseUrlState` returns `loc` (unknown/missing → `'lomas'`); `serializeUrlState` writes `loc` only when not `'lomas'`.
  - `localesFormat.js`: `heatLevel(n, max) → 0..4` (0 when `n` is 0 or `max` is 0; otherwise `Math.ceil(n / max * 4)`), `upt(n) → '1,5' | '—'` (2 decimals max, `'—'` for null).

- [ ] **Step 1: Write the failing tests:**
  - `urlState.test.js`: `loc defaults to lomas and stays out of the URL`; `loc=belgrano round-trips`; `unknown loc falls back to lomas`.
  - `localesFormat.test.js`: `heatLevel(0, 10) === 0`, `heatLevel(1, 10) === 1`, `heatLevel(10, 10) === 4`, `heatLevel(3, 0) === 0`; `upt(1.5) === '1,5'`, `upt(null) === '—'`.
- [ ] **Step 2:** `cd frontend && npx vitest run src/nuevo/urlState.test.js src/nuevo/locales/localesFormat.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** urlState `loc`, `localesFormat.js`, and the components:
  - `Locales.jsx`: same fetch/skeleton/error/retry shape as `Web.jsx`; title by period ("Locales de la semana" / "del mes" / "del rango"); subtitle "Ventas de POS (Odoo) · stock a hoy (dd/mm)"; the "Período en curso" note when `prevRange.partial`. Order: `CompareCards`, `DailyStacked`, `HoursCard`, `LocalDetail`.
  - `CompareCards.jsx`: one card per store plus a slimmer "Total locales" card, store color as a top border. Big: facturación; then tickets, ticket promedio, unidades por ticket, % del total de locales; pills vs. período anterior and vs. año (`ajust.`/`nominal` like `WebSalesCard`). Cards wrap to one column under 720 px.
  - `HoursCard.jsx`: table hour × store, cell = tickets with a background level from `heatLevel` (store color at 15/30/50/75% opacity), title tooltip with revenue; inside `.nv-tscroll`. Subtitle "tickets por hora (hora del ticket en el POS)".
  - `LocalDetail.jsx`: `.nv-seg` store selector (`onUpdate({ loc })`), then a stock strip (depósito / exhibición, units and products, "stock a hoy"), "Más vendidos" table (model, unid., facturación, vs. año pill, stock local `dep + exh`, Rolón; local stock 0 in red; click opens `?sku=` via `onOpenSku`), "Categorías" table (unid., facturación, vs. año pill from `prevRevenueToDateAdj`), `OriginsCard` and "Medios de pago" (CSS bars with % and amount).
  - `NuevoApp`: `case 'locales': return <Locales state={state} onUpdate={onUpdate} onLogout={onLogout} />`.
- [ ] **Step 4:** Run the same vitest command. Expected: PASS. Then `cd frontend && npx vitest run` and `npm run build`. Expected: all pass, build OK.
- [ ] **Step 5: Commit** `feat(reportes): pestaña Locales`.

### Task 4: Live check, build and deploy

- [ ] **Step 1:** Run the backend locally via the scratch script and the frontend with Vite; open `/?tab=locales&period=week&date=2026-11-02` in the browser at desktop width and 390 px. Expected: numbers equal Task 2's check; no horizontal scroll; switching store updates the URL and the detail without a new request; a running week shows the "Período en curso" note. Kill the processes and delete the scratch script.
- [ ] **Step 2:** `cd frontend && npm run build` with the Railway API URL; `grep` that `dist` references only the Railway URL (no `localhost`).
- [ ] **Step 3:** Push `main`; confirm the Railway deploy succeeds and `/api/v2/locales` answers 401 without a token.
