# Reporte nuevo — Parte 1 (base + Resumen + fotos diarias) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un reporte nuevo en `/?v=nuevo`, con pestañas por tema, período en la URL, buscador de producto y la pestaña Resumen completa (KPIs con tendencia, alertas por reglas, por canal, por día), más dos fotos diarias (Clarity y stock web) que empiezan a juntar historia. El reporte actual en `/` queda intacto.

**Architecture:**
- Backend: endpoints nuevos bajo `/api/v2/*` armados con funciones puras testeadas (`resumen.mjs`, `alerts.mjs`, `stockCoverage.mjs`, `snapshots.mjs`) y las fuentes que ya existen (Firestore sales/ads/products, GA4 vía `eventBehavior.mjs` generalizado, Clarity, origen de Odoo).
- Frontend: una app aparte en `frontend/src/nuevo/`, con estilos propios scopeados bajo `.nv`, que `App.jsx` elige cuando la URL trae `v=nuevo`.

**Tech Stack:** Node/Express ESM (`.mjs`), `node --test`, Firestore (firebase-admin), node-cron; React 18 + Vite 5, Vitest. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-11-12-reporte-normal-rediseno-design.md`

## Global Constraints

- **Paleta:**
  - Marca: fondo de página `#fafafa`, tarjetas `#fff`, tinta `#353434`, bordes `#ececeb`, radio de ~14px, Poppins.
  - Etiquetas: verde (suba/bien), rojo (baja/problema), ámbar (stock) y azul (web/info).
  - Colores de canal: los de `frontend/src/lib/channels.js`.
- **Ruta:** el reporte nuevo vive en una ruta aparte y el actual sigue intacto en `/`. La spec dice `/nuevo`; como Hostinger sirve un `index.html` estático sin reescrituras, se implementa como el query `?v=nuevo` (mismo login y mismo build).
- **Pestañas:** Resumen · Web · Locales · Producto · Pauta · Mayorista, más "Cyber" mientras haya evento activo. Sin Feria. Las pestañas sin construir muestran "Próximamente" con un link al reporte actual (`/`).
- **Montos:** misma definición que hoy (`computeTotals`): web sin IVA ni envío, locales con IVA. La comparación interanual se ajusta por inflación con el mismo criterio que `/api/report`. Si falta el índice, se muestra la variación nominal rotulada "nominal".
- **Mayorista incluye feria** (canales `mayorista` + `feria`) en "Por canal" y en los totales.
- **Conversión web** = compras ÷ sesiones de GA4. Nunca `sessionConversionRate`.
- **ROAS de Google** = total, incluida la búsqueda de marca (`purchaseValue` de `googleAds` daily = GA4 `google / cpc`).
- **Stock:** siempre "a hoy", rotulado "stock a hoy". La cobertura web se calcula con 28 días de venta web hacia atrás desde hoy.
- **Clarity:**
  - Ninguna lectura en vivo desde el reporte nuevo: todo sale de `altorancho_reportes_clarity_daily`.
  - El cron corre a las 00:05, 06:00 y 12:00 hora Argentina, con una foto por día (las dos últimas solo si falta la del día).
  - Las corridas locales arrancan sin `CLARITY_API_TOKEN`.
- **Alertas:** máximo 6, con al menos una "Bien" si existe. Los umbrales viven solo en `backend/alertConfig.mjs`.
- **Corridas locales escriben en Firestore de producción:** nunca `node index.mjs` local. Para servir local se usa un script que importa `{ app }` sin crons, con `TZ=UTC`.
- **Commits:** directo a `main`, con la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. El push autodeploya el backend; el frontend lo sube Joaquín a mano desde `frontend/dist/`.

## Review Focus

- **Período sin datos de alguna fuente** (GA4 caído, sin fotos de Clarity, índice INDEC sin publicar, semana futura): el Resumen tiene que renderizar igual, con "—" o la nota correspondiente, nunca un error de página. Tests en Task 3 (KPIs con `web: null`, `ads` vacío, índice faltante) y en Task 4 (reglas con inputs `null`).
- **Rango personalizado largo** (por ejemplo 90 días) o de 1 día: el gráfico por día agrupa por semana cuando son más de 45 días; las tendencias usan 8 rangos previos del mismo largo. Test en Task 3.
- **Basura de stock** (gift cards con 100.000.000 u., "Envío particular" negativo, negativos chicos): no puede aparecer en "Pasar a la web" ni inflar totales. Test en Task 2.
- **Producto vendido en la web que no está en el catálogo** (SKU sin product doc): no rompe la cobertura; se saltea. Test en Task 2.
- **URL con parámetros inválidos** (fecha mal escrita, pestaña desconocida, `start > end`): cae a los valores por defecto (Resumen, semana actual), sin pantalla en blanco. Test en Task 6.

---

### Task 1: Fotos diarias (Clarity y stock web) con su cron

**Files:**
- Create: `backend/snapshots.mjs`
- Modify: `backend/clarity.mjs` (exportar la lectura cruda), `backend/firestore.mjs` (helpers de snapshots), `backend/index.mjs` (crons dentro del guard de main)
- Test: `backend/test/snapshots.test.mjs`

**Interfaces:**
- Produces:
  - `firestore.mjs`:
    - `saveDailySnapshot(col: string, date: string, data: object): Promise<void>`
    - `getDailySnapshot(col, date): Promise<object|null>`
    - `queryDailySnapshots(col, start, end): Promise<object[]>`, ordenado por `date`
    - Constantes `CLARITY_DAILY_COL = 'altorancho_reportes_clarity_daily'` y `WEB_STOCK_DAILY_COL = 'altorancho_reportes_web_stock_daily'`.
  - `clarity.mjs`: `fetchClarityLast24h(): Promise<{ totalsResp: object[], byUrlResp: object[] }>` (las mismas 2 llamadas y el mismo contador diario que hoy).
  - `snapshots.mjs`:
    - `claritySnapshotDoc(totalsResp, byUrlResp, date) → { date, totals, pages }`, que reutiliza `shapeClarityTotals`/`shapeClarityPages` con `limit: 50, minSessions: 10`.
    - `webStockSnapshotDoc(productsBySku, date) → { date, bySku: { [sku]: number } }`.
    - `takeDailySnapshots({ now = new Date() }): Promise<{ clarity: 'saved'|'exists'|'skipped'|'error', stock: … }>`.
    - `snapshotDateFor(now: Date): string`.

- [ ] **Step 1: Write the failing tests** in `backend/test/snapshots.test.mjs`
  - `snapshotDateFor(new Date('2026-11-13T03:05:00Z'))` === `'2026-11-12'` (00:05 ART → la foto es del día anterior); `snapshotDateFor(new Date('2026-11-13T15:00:00Z'))` === `'2026-11-12'` (reintento de las 12:00 ART, mismo día de foto).
  - `webStockSnapshotDoc` guarda todo SKU con `currentStock` conocido, incluidos los 0: los días en 0 son justamente lo que interesa. Con productos `{GFT001AR: currentStock 100000000}`, `{X1: currentStock 3}`, `{X2: currentStock null}`, `{X3: currentStock -2}` → `bySku` deep-equals `{ X1: 3, X3: 0 }` (sin gift cards (`/^GFT/`), sin null, negativos a 0).
  - `claritySnapshotDoc` con la respuesta vacía real (la de `test/clarity.test.mjs`) → `totals.sessions === 0` y `pages` deep-equals `[]`.

- [ ] **Step 2: Run** `cd backend && node --test test/snapshots.test.mjs`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**
  - `snapshotDateFor`: el día argentino de `now − 12 h`. Así las corridas de 00:05, 06:00 y 12:00 ART dan la misma fecha.
  - `takeDailySnapshots`:
    - Para cada colección, si `getDailySnapshot(col, date)` ya existe, devuelve `'exists'` sin llamar a la API.
    - Si no hay `CLARITY_API_TOKEN`, Clarity da `'skipped'`.
    - Los errores se loguean y devuelven `'error'`, sin tirar la excepción.
  - Crons en `index.mjs`, dentro del bloque `if (process.argv[1] === fileURLToPath(import.meta.url))`: `cron.schedule('5 0 * * *' | '0 6 * * *' | '0 12 * * *', () => takeDailySnapshots(), { timezone: 'America/Argentina/Buenos_Aires' })`.

- [ ] **Step 4: Run** `cd backend && node --test test/snapshots.test.mjs test/clarity.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(reportes): fotos diarias de Clarity y stock web`.

---

### Task 2: Cobertura de stock web ("Pasar a la web")

**Files:**
- Create: `backend/stockCoverage.mjs`
- Test: `backend/test/stockCoverage.test.mjs`

**Interfaces:**
- Consumes: product docs (`sku`, `name`, `currentStock` = stock web de Tienda Nube, `stockByLocation` con las claves actuales `local_lomas`, `local_belgrano`, `local_alcorta`, `mayorista`, `ecommerce_odoo`, `deposito`); sale docs (`channel`, `status`, `date`, `items[{sku, qty, unitPrice}]`).
- Produces:
  - `ROLON_KEYS = ['deposito', 'mayorista', 'alcorta_en_rolon']` y `LOCAL_KEYS = ['local_lomas', 'local_belgrano', 'local_alcorta']`, exportadas; la parte 2 agrega las de exhibición.
  - `isJunkSku(sku, name): boolean` (gift cards `/^GFT/`, `/envio/i` en sku o nombre).
  - `webCoverage({ webSalesDocs, productsBySku, windowDays = 28, maxCoverageDays = 7 }) → Array<{ sku, name, weeklyUnits, dailyRevenue, webStock, coverageDays, where: { [locationKey]: number }, group: 'rolon'|'local'|'none' }>`
    - Orden: `group` (rolon, local, none) y después `dailyRevenue` descendente.

- [ ] **Step 1: Write the failing tests**
  - **Producto que pasa:** `A1` con 28 u. vendidas en la web en la ventana ($100 c/u) y `currentStock: 3` → `weeklyUnits 7`, `dailyRevenue 100`, `coverageDays 3`.
    - Con `stockByLocation { deposito: 10, local_lomas: 2 }` → `group 'rolon'` y `where` deep-equals `{ deposito: 10, local_lomas: 2 }`.
  - **Mismo producto con más stock web:** `currentStock: 50` → no aparece (cobertura 50 > 7).
  - **Sin stock en Rolón:** `currentStock: 0` y `stockByLocation { local_belgrano: 1 }` → `coverageDays 0`, `group 'local'`.
    - Sin ningún stock → `group 'none'`.
  - **Basura:** gift card `GFT001AR` vendida y `EnvioParticular` → nunca en la lista.
  - **SKU vendido sin product doc** → se saltea sin lanzar.
  - **Negativos:** `where` ignora cantidades ≤ 0.
  - **Ventas no completadas:** solo cuentan los docs `status === 'completed'`.

- [ ] **Step 2: Run** `cd backend && node --test test/stockCoverage.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** en `backend/stockCoverage.mjs`.
  - Fórmulas: `coverageDays = webStock / (unitsInWindow / windowDays)`, redondeado a 1 decimal; `dailyRevenue = revenueInWindow / windowDays`.
  - Solo cuentan los productos con ventas en la ventana. Las líneas con `unitPrice < 0` son descuentos.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(reportes): cobertura de stock web por producto`.

---

### Task 3: Lógica del Resumen (KPIs, tendencias, por canal, por día)

**Files:**
- Create: `backend/resumen.mjs`
- Test: `backend/test/resumen.test.mjs`

**Interfaces:**
- Consumes: `computeTotals`, `computeInflationAdjustedDelta`, `computeDelta` de `aggregate.mjs`; `getPeriodRanges` de `periods.mjs`; `addDays`, `argDay` de `events.mjs`.
- Produces:
  - `RESUMEN_CHANNELS = [{ id: 'web', channels: ['ecommerce'] }, { id: 'lomas', channels: ['local_lomas'] }, { id: 'belgrano', channels: ['local_belgrano'] }, { id: 'alcorta', channels: ['local_alcorta'] }, { id: 'mayorista', channels: ['mayorista', 'feria'] }]`.
  - `sparkRanges(ranges: { current: {start, end} }, period: 'week'|'month'|'custom', n = 8) → Array<{start, end}>`: los n rangos consecutivos que terminan en el actual, el último es el actual. En modo `month`, n = 12 meses calendario.
  - `channelBreakdown(curDocs, prevDocs) → Array<{ id, revenue, orders, deltaPct, sharePct }>`.
  - `dailyStacked(curDocs, prevYearDocs, { start, end, prevYearFactor }) → { bucket: 'day'|'week', rows: Array<{ key, byChannel: { web, lomas, belgrano, alcorta, mayorista }, total, prevYearAdj }> }`.
    - `bucket` es `'week'` cuando el rango tiene más de 45 días.
    - Los días sin ventas aparecen con 0.
  - `buildKpis({ cur, prevPeriod, prevYear, sparks, inflation: { currentIndex, prevYearIndex }, web, ads }) → Array<{ id: 'revenue'|'orders'|'avgTicket'|'conversion'|'adSpend', value, vsPrev, vsYear, vsYearKind: 'real'|'nominal'|'pp'|null, spark: number[], extra? }>`.
    - `web` = `{ cur: {sessions, purchases}, prev, yoy, spark: [{sessions, purchases}] } | null`.
    - `ads` = `{ cur: {spend, value}, prev, spark: [{spend, value}] }`.
    - `conversion.vsPrev` y `vsYear` en puntos porcentuales (`vsYearKind 'pp'`).
    - `adSpend.extra = { roas, roasPrev }`.

- [ ] **Step 1: Write the failing tests**
  - `sparkRanges` semana 2026-11-02..08 → 8 rangos; el primero es `{start:'2026-09-14', end:'2026-09-20'}` y el último el actual.
    - Modo `month` (2026-10) → 12 rangos, el primero `2025-11-01..2025-11-30`.
    - Modo `custom` de 10 días → rangos de 10 días contiguos.
  - `channelBreakdown`: docs de `feria` y `mayorista` suman en `mayorista`; `sharePct` suma 100 (±0,1); `deltaPct` es `null` cuando el anterior es 0.
  - `dailyStacked`:
    - Rango de 7 días con un día sin ventas → 7 filas, una en 0.
    - Rango de 90 días → `bucket 'week'`.
  - `buildKpis`:
    - Con `web: null` → el KPI `conversion` tiene `value: null`, `vsPrev: null`, `spark: []`.
    - Con `inflation.prevYearIndex` undefined → `revenue.vsYearKind === 'nominal'`.
    - Con índices presentes → `'real'`, y `vsYear` igual a `computeInflationAdjustedDelta(...)`.
    - Ads con spend 0 → `extra.roas === null`.

- [ ] **Step 2: Run** `cd backend && node --test test/resumen.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** en `backend/resumen.mjs` (funciones puras, sin IO).

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(reportes): lógica del Resumen nuevo`.

---

### Task 4: Motor de alertas por reglas

**Files:**
- Create: `backend/alertConfig.mjs`, `backend/alerts.mjs`
- Test: `backend/test/alerts.test.mjs`

**Interfaces:**
- Consumes: el output de `webCoverage` (Task 2), `channelBreakdown` y los totales (Task 3), `shapeBehavior(...)` de `eventBehavior.mjs` (`channels`, `items.lowConversion`, `totals`), `summarizeOrigins(...)` de `eventOrigins.mjs`, las fotos de Clarity del rango (Task 1).
- Produces:
  - `alertConfig.mjs` exporta `ALERTS = { maxAlerts: 6, localDropPct: 0.15, localBaselinePeriods: { week: 8, month: 3, custom: 8 }, coverageDays: 7, trafficMinViewsPerWeek: 2000, sourceMinShare: 0.10, sourceConvRatio: 1/3, clarityMinSessions: 200, clarityRagePct: 5, clarityDeadPct: 20, movePct: 0.20 }`.
  - `alerts.mjs`:
    - `buildAlerts({ period, days, locales, coverage, behavior, clarity, origins }) → Array<{ id, kind: 'local'|'stock'|'web'|'producto'|'pauta'|'bien', tone: 'r'|'y'|'b'|'g', title, detail, tab: 'locales'|'producto'|'web'|'pauta' }>`.
    - Cualquier input puede ser `null`; esa regla simplemente no genera alerta.
    - `locales` = `Array<{ id, label, revenue, orders, avgTicket, baselineRevenue, baselineOrders, baselineAvgTicket }>`.
    - Orden de importancia: local (r), stock (y), web (b), producto (b), bien (g). Corte en `maxAlerts`; si hay alguna "bien", se garantiza una aunque desplace a la última.

- [ ] **Step 1: Write the failing tests** (una alerta por regla; textos en castellano, con el número):
  - **Local flojo:** `{ id:'alcorta', label:'Alcorta', revenue: 29e6, baselineRevenue: 35e6, orders: 80, baselineOrders: 101, avgTicket: 362e3, baselineAvgTicket: 346e3 }`.
    - Genera `kind 'local'`, `tone 'r'`, `tab 'locales'`.
    - `title` contiene `'Alcorta'` y `'17%'`.
    - `detail` menciona que bajaron los tickets.
    - Con `revenue: 31e6` (−11%) → no genera.
  - **Stock:** `coverage` con 2 filas `group 'rolon'` y 1 `'local'` → una sola alerta `kind 'stock'`, con `title` que contiene `'3 productos'` y `detail` que contiene `'2 en Rolón'`. Con `coverage: []` → ninguna.
  - **Mucho tráfico, poca venta:** `behavior.items.lowConversion[0]` con `views: 4733` (período de 7 días) → `kind 'web'`. Con `days: 14` y `views: 3000` (< 4000) → no genera.
  - **Fuente que no convierte:** `behavior.channels` con Cross-network 57% de las sesiones y conversión 0,08% contra un promedio de 0,43% → `kind 'web'`.
  - **Clarity:** foto con una página de 500 sesiones y `rage 8` → `kind 'web'`. Con `clarity: null` → nada.
  - **Origen que se mueve:** `origins` con importado `cur 501` / `prev 352` → `kind 'bien'`, `tone 'g'`, `title` contiene `'Importado'` y `'+42%'`. Con fábrica −14% → no genera (umbral 20%).
  - **Corte:** 8 alertas candidatas con una "bien" al final → devuelve 6 e incluye la "bien".

- [ ] **Step 2: Run** `cd backend && node --test test/alerts.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.** Los umbrales se leen siempre de `ALERTS`. El de tráfico se escala: `trafficMinViewsPerWeek * days / 7`.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(reportes): alertas por reglas del Resumen`.

---

### Task 5: Endpoints `/api/v2/resumen`, `/api/v2/product-search` y `/api/v2/product/:sku`

**Files:**
- Create: `backend/resumenReport.mjs` (IO + ensamblado), `backend/productLookup.mjs`
- Modify:
  - `backend/eventBehavior.mjs`: generalizar a cualquier rango. Exportar `getWebBehavior({ cur:{start,end}, prev:{start,end}, yoy?:{start,end} })`, que devuelve el `shapeBehavior` más `totals.yoy` cuando se pasa `yoy` (agregar un tercer `dateRange` llamado `'yoy'` solo a la consulta `totals`). Cache por clave de rangos: 30 min si `cur.end >= hoy`, 6 h si es pasado. `buildBehaviorReport` sigue igual por fuera.
  - `backend/ga4.mjs`: `fetchGa4DailyTotals(start, end) → Map<date, { sessions, purchases }>`, para las tendencias.
  - `backend/index.mjs`: tres rutas con `requireAuth`, con el mismo manejo de errores que `/api/event`.
- Test: `backend/test/productLookup.test.mjs`. El ensamblado de `resumenReport` se verifica en vivo en el Step 5.

**Interfaces:**
- Consumes: Tasks 1–4; `querySalesByRange`, `queryMetaAdsDailyByRange`, `queryGoogleAdsDailyByRange`, `getProductsBySku`, `getInflationIndexByMonth`, `queryDailySnapshots(CLARITY_DAILY_COL, …)`, `getOriginBySku`, `summarizeOrigins`.
- Produces:
  - `GET /api/v2/resumen?period=week|month|custom&date=YYYY-MM-DD[&start&end]` → `{ ok, range, ranges: { current, prevPeriod, prevYear }, kpis, alerts, channels, daily, stockAsOf: 'YYYY-MM-DD', sources: { ga4: boolean, clarityDays: number } }`.
    - Mismo parseo de parámetros que `/api/report` (`parseReportParams`).
    - Cache en memoria de 5 minutos por clave.
    - GA4, Clarity y origen van con `.catch(() => null)`, así una caída de esas fuentes no rompe el Resumen; `sources` dice qué faltó.
  - `productLookup.mjs`:
    - `searchProducts(productsBySku, q, limit = 10) → Array<{ sku, name, category }>`. Busca por SKU (prefijo, sin importar mayúsculas) y por nombre (todas las palabras, sin acentos). Excluye `isJunkSku`.
    - `productSheet({ sku, productsBySku, salesDocs, originBySku }) → { sku, name, category, origin, webStock, stockByLocation, byChannel: [{ id, units, revenue }], byDay: [{ date, units, revenue }] }`.
  - `GET /api/v2/product-search?q=` → `{ ok, results }`.
  - `GET /api/v2/product/:sku?period&date[&start&end]` → `{ ok, ...productSheet }`.

- [ ] **Step 1: Write the failing tests** (`productLookup.test.mjs`)
  - `searchProducts(map, 'msi018')` encuentra `MSI018RV` y `MSI018VE`.
  - `searchProducts(map, 'silla chicago')` encuentra "Silla Chicago Verde" y no "Silla Tube".
  - `searchProducts(map, 'lampara')` encuentra "Lámpara Inalámbrica…".
  - `'gift'` no devuelve `GFT*`.
  - `productSheet`:
    - suma `feria` en `mayorista` dentro de `byChannel`;
    - `byDay` agrupa por día argentino (un pedido de `2026-11-03T01:30:00Z` cae el `2026-11-02`);
    - excluye líneas de otros SKU.

- [ ] **Step 2: Run** `cd backend && node --test test/productLookup.test.mjs`. Expected: FAIL. Implement. Run again. Expected: PASS. Run the whole suite: `cd backend && node --test`. Expected: 0 fail.

- [ ] **Step 3: Implement `resumenReport.mjs` → `buildResumen(params): Promise<object>`**
  - Calcula los rangos con `getPeriodRanges` y `sparkRanges`.
  - Hace una sola consulta de ventas por el tramo `[primer spark .. actual]`, más `prevYear` y la ventana web de 28 días hasta hoy.
  - Toma el baseline de locales de `localBaselinePeriods`; en modo `month` lo ajusta por inflación con `inflationFactor`.
  - Ads: Meta + Google del mismo tramo.
  - GA4: `getWebBehavior({ cur, prev: prevPeriod, yoy: prevYear })` y `fetchGa4DailyTotals` sobre el tramo de tendencias.

- [ ] **Step 4: Serve locally without crons and without Clarity, then call the endpoints**

```bash
cd backend && printf "import { app } from './index.mjs';\napp.listen(3000);\n" > _serve_local.mjs
CLARITY_API_TOKEN= TZ=UTC node -e "process.env.CLARITY_API_TOKEN='';import('./_serve_local.mjs')"   # en background
```

Login con `DASHBOARD_PASSWORD` de `backend/.env`; después `GET /api/v2/resumen?period=week&date=2026-11-02`.

- [ ] **Step 5: Live verification**
  - `kpis.revenue.value` y `orders` coinciden exacto con `current.totals.revenue`/`orders` de `GET /api/report?period=week&date=2026-11-02` (todos los canales).
  - La suma de `channels[].revenue` es igual a ese mismo total.
  - Repetir con `period=month&date=2026-10-01`.
  - Anotar en el reporte de la tarea los números comparados.
  - Borrar `_serve_local.mjs`.

- [ ] **Step 6: Commit** `feat(reportes): endpoints del Resumen y buscador de producto`.

---

### Task 6: Shell del reporte nuevo (ruta, URL, estilos, pestañas, período)

**Files:**
- Create: `frontend/src/nuevo/NuevoApp.jsx`, `frontend/src/nuevo/urlState.js`, `frontend/src/nuevo/urlState.test.js`, `frontend/src/nuevo/nuevo.css`, `frontend/src/nuevo/TopBar.jsx`, `frontend/src/nuevo/PeriodBar.jsx`, `frontend/src/nuevo/ComingSoon.jsx`
- Modify:
  - `frontend/src/App.jsx`: si `new URLSearchParams(location.search).get('v') === 'nuevo'`, renderiza `<NuevoApp onLogout={logout} />`; si no, `Dashboard` como hoy.
  - `frontend/src/pages/Dashboard.jsx`: un link chico "Probar el reporte nuevo" en el header, que apunta a `?v=nuevo`.
  - `frontend/src/api/client.js`: `getResumen(params)`, `searchProducts(q)`, `getProductSheet(sku, params)`, con el mismo patrón de auth que `getEventBehavior`.

**Interfaces:**
- Consumes: `shiftPeriod`, `formatPeriodLabel` de `frontend/src/lib/periods.js`; `CHANNELS` de `lib/channels.js`; `EventLive` (la pestaña Cyber renderiza el componente actual tal cual).
- Produces:
  - `urlState.js`:
    - `TABS = ['resumen', 'web', 'locales', 'producto', 'pauta', 'mayorista', 'cyber']`.
    - `parseUrlState(search: string, today: string) → { tab, period: 'week'|'month'|'custom', date, start, end }`.
    - `serializeUrlState(state) → string`, que empieza con `?v=nuevo`.
    - `periodParams(state) → { period, date } | { period:'custom', start, end }`, con la misma forma que espera `client.js`.
  - `NuevoApp`:
    - Mantiene el estado sincronizado con la URL: `history.replaceState` al cambiar período y `pushState` al cambiar de pestaña. El botón atrás funciona escuchando `popstate`.
    - Renderiza `<TopBar>`, `<PeriodBar>` y el contenido de la pestaña.
  - Todas las clases del CSS nuevo van bajo `.nv`. Usa las variables de la paleta de Global Constraints.
  - `ComingSoon({ tabLabel })` muestra "Próximamente" y un link "Ver en el reporte actual" a `/`.
  - `NuevoApp` monta el asistente IA que ya existe (`InsightsButton` y `ChatWidget`, con `channel = null` y el período actual). Se restila solo por CSS bajo `.nv`, sin tocar los componentes.

- [ ] **Step 1: Write the failing tests** (`urlState.test.js`)
  - `parseUrlState('?v=nuevo', '2026-11-12')` → `{ tab:'resumen', period:'week', date:'2026-11-12', start:null, end:null }`.
  - `parseUrlState('?v=nuevo&tab=producto&period=month&date=2026-10-01', …)` → `tab 'producto'`, `period 'month'`.
  - Tab desconocida, fecha `'2026-13-45'`, o `custom` con `start > end` → defaults de Resumen y semana de hoy.
  - Round-trip: `parseUrlState(serializeUrlState(s), today)` deep-equals `s` para un estado custom válido.

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/nuevo/urlState.test.js`. Expected: FAIL. Implement. Run. Expected: PASS.

- [ ] **Step 3: Build the shell components**
  - **TopBar:**
    - Fondo `#353434` con la marca "ALTORANCHO".
    - Pestañas: Resumen, Web, Locales, Producto, Pauta, Mayorista. "● Cyber" solo mientras el evento esté activo; el rango lo da `EVENTS` del backend, así que `NuevoApp` lo pide una vez con `getEventReport('cyber')` y lo muestra si `today <= current.end + 1`.
    - Hueco para el buscador (Task 8).
  - **PeriodBar:**
    - Segmentado Semana / Mes / Rango, con flechas ‹ › (`shiftPeriod`).
    - Dos inputs de fecha cuando es Rango.
    - Leyenda "Comparando con: período anterior · mismo período {año−1} (ajustado por inflación)".
  - Las pestañas sin construir muestran `ComingSoon`.

- [ ] **Step 4: Verify**
  - `cd frontend && npx vitest run` → todo pasa.
  - `npx vite build` → build OK.

- [ ] **Step 5: Commit** `feat(reportes): shell del reporte nuevo en ?v=nuevo`.

---

### Task 7: Pestaña Resumen (frontend)

**Files:**
- Create: `frontend/src/nuevo/resumen/Resumen.jsx`, `KpiStrip.jsx`, `Sparkline.jsx`, `AlertsCard.jsx`, `ChannelsCard.jsx`, `DailyStacked.jsx`, `frontend/src/nuevo/format.js`, `frontend/src/nuevo/format.test.js`

**Interfaces:**
- Consumes: `getResumen(periodParams(state))` (Task 6), con la respuesta de Task 5.
- Produces:
  - `format.js`:
    - `money(v) → '$412M' | '$321K' | '$9,8M' | '—'`: con una decimal y coma si es menor a 10M, sin decimales si es mayor.
    - `pct(v, { sign, decimals }) → '+6%' | '−3%' | '—'`. El signo menos es el carácter U+2212.
    - `pp(v) → '−0,08 pp'`.
    - `num(v) → '1.284'`.
  - `Resumen({ state, onNavigate(tab) })`. Las alertas llaman `onNavigate(alert.tab)`.

- [ ] **Step 1: Write the failing tests** (`format.test.js`)
  - `money(412_000_000)` === `'$412M'`
  - `money(9_800_000)` === `'$9,8M'`
  - `money(321_400)` === `'$321K'`
  - `money(null)` === `'—'`
  - `pct(-3.2, { sign: true })` === `'−3%'`
  - `pct(6, { sign: true })` === `'+6%'`
  - `pp(-0.08)` === `'−0,08 pp'`
  - `num(1284)` === `'1.284'`

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/nuevo/format.test.js`. Expected: FAIL. Implement. Run. Expected: PASS.

- [ ] **Step 3: Build the components**, siguiendo la maqueta aprobada `.superpowers/brainstorm/293-1794494381/content/resumen.html`.
  - **KpiStrip:** 5 tarjetas. Cada una con el valor, una pastilla contra el período anterior y otra contra el año (con el sufijo "real" o "nominal" según `vsYearKind`), y la tendencia en un `Sparkline` SVG de ancho fluido. Pauta muestra además el ROAS.
  - **AlertsCard:** etiqueta de color según `tone`, título, detalle y "Ver {pestaña} ›". Si no hay alertas: "Nada fuera de lo normal esta semana".
  - **ChannelsCard:** dot y barra con el color del canal (`channels.js`; Mayorista usa el color de `mayorista`), monto, variación y %. Nota: "Mayorista incluye ferias. Web sin IVA ni envío; locales con IVA."
  - **DailyStacked:** barras CSS apiladas por canal, con una marca punteada en `prevYearAdj` y tooltip nativo (`title`) con el detalle. Leyenda abajo. Si `bucket === 'week'`, el título dice "por semana".
  - **Estados:**
    - Cargando: esqueleto gris.
    - Error: tarjeta con el mensaje y un botón "Reintentar".
    - `sources.ga4 === false`: nota "GA4 no respondió: sin conversión ni alertas web".
    - `sources.clarityDays === 0`: sin nota.
  - **Responsive:** KPIs en 5 columnas, 3 por debajo de 1000px y 2 por debajo de 720px; `grid2` pasa a una columna por debajo de 1000px.

- [ ] **Step 4: Verify** `npx vitest run` y `npx vite build`. Expected: PASS / built.

- [ ] **Step 5: Commit** `feat(reportes): pestaña Resumen del reporte nuevo`.

---

### Task 8: Buscador de producto y ficha

**Files:**
- Create: `frontend/src/nuevo/search/ProductSearch.jsx`, `frontend/src/nuevo/search/ProductSheet.jsx`
- Modify: `frontend/src/nuevo/TopBar.jsx` (monta `ProductSearch`), `frontend/src/nuevo/NuevoApp.jsx` (estado del producto abierto: `?…&sku=XXX` en la URL)

**Interfaces:**
- Consumes: `searchProducts(q)` y `getProductSheet(sku, params)` (Task 6), con las respuestas de Task 5.
- Produces:
  - `ProductSearch`: input con debounce de 250 ms y mínimo 2 caracteres. Lista de hasta 10 resultados, navegable con ↑ ↓ Enter, Esc cierra. Al elegir uno, agrega `sku` a la URL.
  - `ProductSheet({ sku, state, onClose })`: panel lateral derecho (en celular, pantalla completa) con:
    - nombre, SKU, categoría y origen (clase y país);
    - stock web a hoy y stock por depósito;
    - unidades y facturación del período por canal;
    - barras por día.
    - Se cierra con Esc o con la ✕.

- [ ] **Step 1: Implement** los dos componentes y su CSS (bajo `.nv`).

- [ ] **Step 2: Verify** `npx vite build`. Expected: built. La prueba funcional va en Task 9.

- [ ] **Step 3: Commit** `feat(reportes): buscador y ficha de producto`.

---

### Task 9: Verificación de punta a punta y entrega

**Files:** ninguno nuevo. Solo un script temporal de servidor local, que se borra al terminar.

- [ ] **Step 1:** Levantar el backend local sin crons ni Clarity (como en Task 5, Step 4) y `cd frontend && npx vite --port 5173`.

- [ ] **Step 2: Browser pass** en `http://localhost:5173/?v=nuevo`. Avisarle a Joaquín antes de tomar control de Chrome.
  - El Resumen de la semana `2026-11-02` muestra los mismos totales que el reporte actual (`/`, misma semana, Consolidado).
  - Navegación:
    - Cambiar a Mes y a un Rango de 60 días: el gráfico pasa a "por semana".
    - Las flechas ‹ › mueven el período y la URL cambia.
    - Recargar mantiene la vista.
    - El botón atrás vuelve a la pestaña anterior.
  - Alertas y pestañas: hacer clic en una alerta lleva a su pestaña ("Próximamente" con link al reporte actual).
  - Buscador:
    - "silla chicago" abre la ficha.
    - Los números de la ficha para la semana coinciden con lo vendido de ese SKU en el reporte actual (Top productos, si aparece).
  - Ancho de 390 px: sin scroll horizontal, KPIs en 2 columnas.
  - `/` sin `v=nuevo` sigue mostrando el reporte actual, sin cambios.

- [ ] **Step 3:** Corregir lo que aparezca, con un commit por arreglo.

- [ ] **Step 4: Build de producción**
  - `cd frontend && npx vite build`.
  - `grep -o 'https\?://[a-z0-9.-]*\(railway\|localhost\)[a-z0-9.:-]*' dist/assets/*.js | sort -u` tiene que devolver solo `https://reportes-altorancho-production.up.railway.app`.
  - Borrar `backend/_serve_local.mjs` y `frontend/vite.config.js.timestamp-*`.

- [ ] **Step 5: Push**
  - `git push origin main`.
  - Esperar el deploy en Railway: `railway deployment list` muestra un SUCCESS posterior al push, y `railway logs` muestra `listening` sin errores.
  - Confirmar que `GET /api/v2/resumen` sin token responde 401.

- [ ] **Step 6: Verificar los crons al día siguiente**
  - `railway logs` muestra la corrida de 00:05.
  - Firestore tiene `altorancho_reportes_clarity_daily/{fecha}` y `altorancho_reportes_web_stock_daily/{fecha}`.
  - Se lee con un script local de solo lectura (`getDailySnapshot`).

- [ ] **Step 7: Entrega** a Joaquín: subir `frontend/dist/` a Hostinger y entrar a `reportes.techdi.com.ar/?v=nuevo`.
