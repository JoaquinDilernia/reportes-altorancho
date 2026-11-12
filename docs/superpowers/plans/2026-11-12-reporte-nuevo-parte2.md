# Reporte nuevo, parte 2: Producto y stock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La pestaña Producto del reporte nuevo: categorías, origen, más vendidos, "Pasar a la web", "Mucho stock, poca venta" y stock por depósito, con el stock de Odoo leído completo (Exhibición y Alcorta en Rolón incluidos) y limpio.

**Architecture:** El sync de productos agrega un campo nuevo `stockByLoc` con claves claras por ubicación física (el viejo `stockByLocation` queda igual hasta la parte 5, porque lo usa el reporte anterior). La lógica de la pestaña son funciones puras en `backend/productTab.mjs` que reutilizan `summarizeCategories`, `compareTopProducts` y `summarizeOrigins`; un endpoint `/api/v2/producto` las arma. El frontend suma `frontend/src/nuevo/producto/` y un filtro de canal en la URL.

**Tech Stack:** Node ESM + `node --test`, Firestore, Odoo JSON-RPC; React 18 + Vite + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-reporte-normal-rediseno-design.md` (secciones "Depósitos en Odoo", "Producto (incluye stock)", "Stock: siempre a hoy", "Datos nuevos a guardar").

## Global Constraints

- Todas las de la parte 1 (`docs/superpowers/plans/2026-11-12-reporte-nuevo-parte1.md`): paleta, `.nv`, montos como `computeTotals`, inflación como `/api/report`, corridas locales sin crons ni Clarity, commits a `main` con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ubicaciones Odoo → claves de `stockByLoc`:** 150 `web_odoo` · 168 `mayorista` · 174 `rolon` · 407 `alcorta_en_rolon` · 8 `lomas_stock` · 324 `lomas_exhibicion` · 372 `belgrano_stock` · 379 `belgrano_exhibicion` · 397 `alcorta_stock` · 415 `alcorta_exhibicion`. Ninguna otra.
- **Grupos de "Pasar a la web":** `rolon` = rolon + mayorista + alcorta_en_rolon (`web_odoo` no cuenta: es la propia web); `local` = cualquier `*_stock` o `*_exhibicion` de un local (con marca `onlyExhibition` si solo hay exhibición); `none` = nada. Orden rolon → local → none, y dentro por venta perdida diaria.
- Cobertura web: venta web de los últimos 28 días hacia atrás desde hoy, stock de Tienda Nube. "Mucho stock, poca venta": venta (todos los canales) de las últimas 8 semanas, cobertura > 180 días o sin ventas.
- Basura: `isJunkSku` (gift cards, envíos) nunca aparece; negativos cuentan 0.
- Todo lo de stock se rotula "stock a hoy".
- Filtro de canal de la pestaña: `all | web | locales | mayorista` (mayorista incluye feria), en la URL como `ch`.

## Review Focus

- **Productos sin `stockByLoc` todavía** (antes del primer sync con el campo nuevo, o SKUs que Odoo no tiene): todo sigue funcionando con el `stockByLocation` viejo o sin stock, sin romper. Test en Task 2.
- **Solo exhibición:** un producto con unidades solo en `*_exhibicion` va a `local` con `onlyExhibition: true`, nunca a `none`. Test en Task 2.
- **Filtro de canal + período sin ventas en ese canal:** tablas vacías con mensaje, no error. Test en Task 3.
- **Mucho stock con 100 M de gift cards o negativos:** fuera. Test en Task 3.
- **`ch` inválido en la URL:** cae a `all`. Test en Task 5.

---

### Task 1: Stock por ubicación completo en el sync

**Files:** Modify `backend/sync/products.mjs`; Create `backend/stockLocations.mjs`; Test `backend/test/stockLocations.test.mjs`

**Interfaces:**
- Produces: `STOCK_LOCATIONS` (id → clave, de Global Constraints); `stockByLocFromQuants(quants) → Map<sku, {clave: unidades}>` (suma por SKU, ignora ubicaciones fuera de la lista, salta `isJunkSku`, descarta cantidades ≤ 0); `LOC_GROUPS = { rolon: ['rolon','mayorista','alcorta_en_rolon'], localStock: [...'_stock'], localExhibition: [...'_exhibicion'] }`.
- `syncProducts` agrega `doc.stockByLoc` (o `null`) además del `stockByLocation` actual, con una sola consulta a `stock.quant` sobre la unión de ubicaciones.

- [ ] Step 1: tests de `stockByLocFromQuants`: quants de 174 y 324 del mismo SKU → `{ rolon, lomas_exhibicion }`; quant de 330 (Producto) ignorado; `GFT001AR` y `EnvioParticular` fuera; cantidad −3 fuera. Run → FAIL.
- [ ] Step 2: implementar; Run → PASS; suite completa verde.
- [ ] Step 3: verificación en vivo de solo lectura (script local que llama `fetchAll('stock.quant', …)` con las 10 ubicaciones y `stockByLocFromQuants`, sin escribir Firestore): imprimir totales por clave y comparar con la tabla del spec (Rolón ~9.150 u., Mayorista ~14.280, exhibición de los locales ~800). Anotar los números en el ledger.
- [ ] Step 4: commit `feat(reportes): stock por ubicación completo (exhibición y Alcorta en Rolón)`.

### Task 2: Cobertura web con las ubicaciones nuevas

**Files:** Modify `backend/stockCoverage.mjs`, `backend/test/stockCoverage.test.mjs`

**Interfaces:**
- Consumes: `LOC_GROUPS`, `stockByLoc`.
- Produces: `webCoverage` igual que hoy, pero `where` sale de `stockByLoc` (todas las claves > 0 menos `web_odoo`), `group` según Global Constraints y cada fila suma `onlyExhibition: boolean` y `lostPerDay` (= `dailyRevenue`). Si el producto no tiene `stockByLoc`, usa el `stockByLocation` viejo con el mapeo `deposito→rolon`, `mayorista→mayorista`, `local_X→X_stock`.

- [ ] Step 1: tests nuevos: solo `belgrano_exhibicion: 2` → `group 'local'`, `onlyExhibition true`; `alcorta_en_rolon: 1` → `'rolon'`; `web_odoo: 20` solo → `'none'`; producto con solo `stockByLocation: { deposito: 3 }` → `'rolon'` y `where { rolon: 3 }`. Los tests existentes se adaptan a las claves nuevas. Run → FAIL.
- [ ] Step 2: implementar; Run → PASS; suite verde (alerts y resumen siguen pasando).
- [ ] Step 3: commit `feat(reportes): cobertura web con exhibición y Alcorta en Rolón`.

### Task 3: Lógica de la pestaña Producto

**Files:** Create `backend/productTab.mjs`; Test `backend/test/productTab.test.mjs`

**Interfaces:**
- Consumes: `summarizeCategories`, `compareTopProducts`, `skuModel` (`eventCategories.mjs`), `summarizeOrigins` (`eventOrigins.mjs`), `isJunkSku`, `LOC_GROUPS`.
- Produces:
  - `CHANNEL_FILTERS = { all: null, web: ['ecommerce'], locales: ['local_lomas','local_belgrano','local_alcorta'], mayorista: ['mayorista','feria'] }`; `filterDocs(docs, ch)`.
  - `overstock({ salesDocs8w, productsBySku, minDays = 180, limit = 30 }) → Array<{ sku, name, stockTotal, weeklyUnits, coverageDays | null }>`: stock total = suma de `stockByLoc` (sin `web_odoo` duplicado: se usa `max(currentStock, web_odoo)` para la web) ; incluye cobertura > `minDays` o sin ventas; ordena por unidades; excluye basura y stock total < 10.
  - `warehouses(productsBySku) → Array<{ key, label, units, products }>` por cada clave de `STOCK_LOCATIONS`, sin basura, negativos en 0.
- [ ] Step 1: tests: `filterDocs` con `locales` deja solo los 3 locales; `overstock` lista un SKU con 200 u. y 1 venta en 8 semanas (cobertura 1600 días) y uno con 50 u. sin ventas (`coverageDays null`), y no lista la gift card ni uno con 5 u.; `warehouses` suma `lomas_exhibicion` de dos SKU y cuenta 2 productos; período sin ventas del canal → `summarizeCategories` devuelve vacío sin tirar. Run → FAIL.
- [ ] Step 2: implementar; Run → PASS.
- [ ] Step 3: commit `feat(reportes): lógica de la pestaña Producto`.

### Task 4: Endpoint `/api/v2/producto`

**Files:** Create `backend/productoReport.mjs`; Modify `backend/index.mjs`

**Interfaces:**
- `GET /api/v2/producto?period&date[&start&end]&ch=all|web|locales|mayorista` (requireAuth, mismo manejo de errores) → `{ ok, range, ch, categories, origins, topModels, coverage, overstock, warehouses, stockAsOf, prevYear }`.
  - `categories`: `summarizeCategories` sobre docs del período filtrados vs. año anterior ajustado (factor como el Resumen).
  - `origins`: `summarizeOrigins` (null si Odoo falla).
  - `topModels`: `compareTopProducts(..., limit: 30)` con stock total y `stockByLoc` sumado por modelo.
  - `coverage`: `webCoverage` completo (no filtrado por canal: es de la web).
  - Cache 5 min por clave de rango resuelto + `ch`; ventas pasadas reusan el cache de Firestore.
- [ ] Step 1: implementar y servir local (script `{ app }`, `TZ=UTC`, sin Clarity).
- [ ] Step 2: verificación en vivo: para `week 2026-11-02, ch=all`, la suma de `categories[].revenue` ≈ suma de líneas de ítem del período (mismo cálculo que `topProductsByRevenue` del reporte anterior) y `topModels` de Silla Chicago coincide con la suma de sus SKUs en `/api/report`; `ch=web` da revenue de categorías ≤ revenue web. Anotar números. Borrar el script.
- [ ] Step 3: commit `feat(reportes): endpoint de la pestaña Producto`.

### Task 5: Pestaña Producto (frontend)

**Files:** Create `frontend/src/nuevo/producto/Producto.jsx`, `CategoriesCard.jsx`, `OriginsCard.jsx`, `TopModelsCard.jsx`, `PasarALaWeb.jsx`, `OverstockCard.jsx`, `WarehousesCard.jsx`, `frontend/src/nuevo/stockLabels.js`; Modify `urlState.js` (+ `ch`), `urlState.test.js`, `NuevoApp.jsx`, `api/client.js` (`getProducto`), `search/ProductSheet.jsx` (usa `stockByLoc` con `stockLabels`, fallback al viejo), `nuevo.css`.

- [ ] Step 1: tests de `urlState`: `ch=web` se lee y round-trip; `ch=xx` → `'all'`; `ch` solo se serializa si no es `all`. Run → FAIL; implementar; PASS.
- [ ] Step 2: componentes, con el estilo de la parte 1:
  - Filtro segmentado Todos / Web / Locales / Mayorista arriba (cambia `ch` con `replaceState`).
  - **Pasar a la web** primero (es lo accionable): tabla con encabezados de grupo "Se pasa desde Rolón (N)", "Solo en locales (N)", "No hay en ningún lado — recomprar (N)"; columnas producto, venta web/semana, stock web, días de cobertura (rojo si 0), dónde hay (chips por ubicación, "solo exhibición" marcado), venta perdida/día. Mostrar 15 por grupo con "ver todos". Rótulo "stock a hoy · venta de las últimas 4 semanas".
  - Categorías (barras horizontales con facturación, unidades, variación vs año anterior y stock), Origen (tabla de la parte Cyber rehecha en `.nv`, importado abierto por país), Más vendidos por modelo (con stock total y por depósito), Mucho stock poca venta, Stock por depósito (agrupado Rolón / Locales).
  - Las alertas del Resumen con `tab: 'producto'` ya llevan acá.
- [ ] Step 3: `npx vitest run` y `npx vite build` → PASS / built. Commit `feat(reportes): pestaña Producto del reporte nuevo`.

### Task 6: Verificación y entrega

- [ ] Backend + Vite local, pasada en el navegador: filtro de canal, grupos de "Pasar a la web" coherentes con la ficha de producto de 3 SKUs elegidos, 390 px sin scroll horizontal.
- [ ] Build de producción (solo URL de Railway), push, deploy SUCCESS, 401 sin token.
- [ ] Después del primer sync en Railway (≤ 4 h), confirmar que los productos tienen `stockByLoc` (script de solo lectura sobre 3 SKUs).
- [ ] Revisión final de toda la rama con un revisor nuevo (modelo más capaz) y una pasada de arreglos.
