# Ecommerce Net Revenue + Shipping Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the ecommerce channel's data source from the Tiendanube REST API to Odoo's already-synced "Tienda Nube" sales team, so ecommerce revenue is net of IVA and shipping charges are split out into their own KPI instead of inflating "Facturación".

**Architecture:** `backend/sync/ecommerce.mjs` is rewritten to query Odoo (`sale.order` where `team_id=1` and `tiendanube_order_id` is set) instead of the Tiendanube REST API, following the exact same JSON-RPC pattern already used by `sync/mayorista.mjs`. A new normalizer (`normalizeOdooEcommerceOrder`) computes `total` as `amount_untaxed` minus the net shipping-line amount, and carries a new `shippingRevenue` field. `computeTotals` in `aggregate.mjs` sums that field the same way it already sums `revenue`, so it gets a KPI card and 3-period comparisons for free through the existing generic `KpiCards.jsx` — no new component needed. Historical ecommerce documents in Firestore get overwritten in place by re-running the existing backfill script, because the new sync reuses the same document-id scheme (`ecommerce_<tiendanube_order_id>`) as the old Tiendanube-API-based sync.

**Tech Stack:** Node.js (ESM, `.mjs`), Node's built-in test runner (`node --test`), Odoo JSON-RPC, Firebase Admin/Firestore, React (no new frontend deps).

## Global Constraints

- Only the **ecommerce** channel changes to net-of-IVA. Locales and Mayorista keep using `amount_total` (bruto) — do not touch `sync/locales.mjs`, `sync/mayorista.mjs`, or `normalizeOdooPosOrder`/`normalizeOdooSaleOrder`.
- Only orders with `tiendanube_order_id` set (truthy) count as ecommerce — the ~1,676 manually-created Odoo orders under the same sales team must be excluded by the Odoo domain filter, not filtered client-side.
- Shipping is identified by the fixed Odoo product `default_code = 'Delivery_007'` (product id 4) — this is the only shipping product Tiendanube's Odoo connector uses; don't try to match by line text.
- Pure logic (`normalize.mjs`, `aggregate.mjs`) gets unit tests. Network/sync code (`sync/ecommerce.mjs`) is verified manually against live Odoo, matching this project's existing convention — do not attempt to mock Odoo's JSON-RPC API in a unit test.
- Frontend components have no unit tests in this codebase (only `lib/*.js` pure functions do) — verify the new KPI card manually in the browser.

---

### Task 1: `shippingRevenue` in `computeTotals` + report bundle

**Files:**
- Modify: `backend/aggregate.mjs:12-32` (`computeTotals`)
- Modify: `backend/index.mjs:87-96` (`diffTotals`)
- Test: `backend/test/aggregate.test.mjs`

**Interfaces:**
- Consumes: sales docs shaped `{ status, total, shippingRevenue?, items, date }` (the `shippingRevenue` field is new and optional — Locales/Mayorista docs won't have it).
- Produces: `computeTotals(salesDocs)` return value gains a `shippingRevenue` field (number, sum over completed docs, defaults missing values to 0). `diffTotals` includes a matching `shippingRevenue` delta so `/api/report`'s `comparisons.*.deltas` carries it.

- [ ] **Step 1: Write the failing test**

Add to `backend/test/aggregate.test.mjs` (after the existing `'computeTotals handles an empty period...'` test, around line 47):

```js
test('computeTotals sums shippingRevenue over completed sales, defaulting missing values to 0', () => {
  const sales = [
    makeSale({ shippingRevenue: 500 }),
    makeSale({ shippingRevenue: 300 }),
    makeSale({ status: 'cancelled', shippingRevenue: 9999 }),
    makeSale({}), // Locales/Mayorista-style doc with no shippingRevenue field at all
  ];

  const totals = computeTotals(sales);

  assert.equal(totals.shippingRevenue, 800);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/aggregate.test.mjs`
Expected: FAIL — `totals.shippingRevenue` is `undefined`, not `800`.

- [ ] **Step 3: Write minimal implementation**

In `backend/aggregate.mjs`, modify `computeTotals` (lines 12-32):

```js
export function computeTotals(salesDocs) {
  const completed = completedOnly(salesDocs);
  const cancelled = salesDocs.filter(s => s.status === 'cancelled');

  const revenue = completed.reduce((sum, s) => sum + s.total, 0);
  const shippingRevenue = completed.reduce((sum, s) => sum + (s.shippingRevenue || 0), 0);
  const units = completed.reduce((sum, s) => sum + s.items.reduce((u, i) => u + i.qty, 0), 0);
  const orders = completed.length;
  const avgTicket = orders ? revenue / orders : 0;

  const uniqueDays = new Set(completed.map(s => argDayBucket(s.date)));
  const daysInRange = uniqueDays.size;
  const avgDailyRevenue = daysInRange ? revenue / daysInRange : 0;

  // Rate is of orders that reached a final state (completed or cancelled) —
  // pending orders are still in flight and would just water down the signal.
  const finalized = orders + cancelled.length;
  const cancelledOrders = cancelled.length;
  const cancellationRate = finalized ? Math.round((cancelledOrders / finalized) * 10000) / 100 : 0;

  return { revenue, shippingRevenue, units, orders, avgTicket, daysInRange, avgDailyRevenue, cancelledOrders, cancellationRate };
}
```

In `backend/index.mjs`, modify `diffTotals` (lines 87-96) to add the delta:

```js
function diffTotals(current, previous) {
  return {
    revenue: computeDelta(current.revenue, previous.revenue),
    shippingRevenue: computeDelta(current.shippingRevenue, previous.shippingRevenue),
    units: computeDelta(current.units, previous.units),
    orders: computeDelta(current.orders, previous.orders),
    avgTicket: computeDelta(current.avgTicket, previous.avgTicket),
    avgDailyRevenue: computeDelta(current.avgDailyRevenue, previous.avgDailyRevenue),
    cancellationRate: computeDelta(current.cancellationRate, previous.cancellationRate),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/aggregate.test.mjs`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add backend/aggregate.mjs backend/index.mjs backend/test/aggregate.test.mjs
git commit -m "feat(backend): add shippingRevenue KPI to the report bundle"
```

---

### Task 2: `normalizeOdooEcommerceOrder` in `normalize.mjs`

**Files:**
- Modify: `backend/normalize.mjs` (add new export, after `normalizeOdooSaleOrder`)
- Test: `backend/test/normalize.test.mjs`

**Interfaces:**
- Consumes: `extractSkuFromDisplayName`, `stripSkuFromDisplayName` (already defined at the top of `normalize.mjs`).
- Produces: `normalizeOdooEcommerceOrder(order, lines, categoryBySku, provinceName)` where:
  - `order`: `{ tiendanube_order_id: string, date_order: string, amount_untaxed: number, state: string, tiendanube_order_payment_status: string|false, tiendanube_gateway_name: string|false }`
  - `lines`: array of `{ product_id: [id, displayName], product_uom_qty: number, price_subtotal: number }` — **caller must have already filtered out note/section lines with no `product_id`**, same contract as `normalizeOdooSaleOrder`/`normalizeOdooPosOrder` already have with their callers.
  - `provinceName`: `string|null` — resolved province name from Odoo (e.g. `"Ciudad Autonoma De Buenos Aires (AR)"`) or `null`.
  - Returns a sales doc shaped like the other Odoo normalizers, plus a new `shippingRevenue` field.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/normalize.test.mjs` (add `normalizeOdooEcommerceOrder` to the import list at the top, then add these tests after the existing `normalizeOdooSaleOrder` tests at the end of the file):

```js
test('normalizeOdooEcommerceOrder maps a paid order to completed and splits out net shipping', () => {
  const order = {
    tiendanube_order_id: '2024692415',
    date_order: '2026-07-08 14:33:14',
    amount_untaxed: 27100.82,
    state: 'sale',
    tiendanube_order_payment_status: 'paid',
    tiendanube_gateway_name: 'Mercado Pago',
  };
  const lines = [
    { product_id: [57353, '[BCV187BO] SET X4 BOWLS DE CERÁMICA APILABLES BORDO 14x7 CM'], product_uom_qty: 1, price_subtotal: 27100.82 },
    { product_id: [4, '[Delivery_007] Entrega gratuita'], product_uom_qty: 1, price_subtotal: 3000 },
  ];

  const doc = normalizeOdooEcommerceOrder(order, lines, categoryBySku, 'Ciudad Autonoma De Buenos Aires (AR)');

  assert.equal(doc.id, 'ecommerce_2024692415');
  assert.equal(doc.channel, 'ecommerce');
  assert.equal(doc.sourceId, '2024692415');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.total, 24100.82);
  assert.equal(doc.shippingRevenue, 3000);
  assert.equal(doc.paymentMethod, 'Mercado Pago');
  assert.equal(doc.shippingProvince, 'Ciudad Autonoma De Buenos Aires');
  assert.deepEqual(doc.items, [
    { sku: 'BCV187BO', name: 'SET X4 BOWLS DE CERÁMICA APILABLES BORDO 14x7 CM', category: null, qty: 1, unitPrice: 27100.82 },
  ]);
});

test('normalizeOdooEcommerceOrder maps cancel state to cancelled regardless of payment status', () => {
  const order = {
    tiendanube_order_id: '1', date_order: '2026-01-01 00:00:00', amount_untaxed: 100,
    state: 'cancel', tiendanube_order_payment_status: 'paid', tiendanube_gateway_name: null,
  };
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, null).status, 'cancelled');
});

test('normalizeOdooEcommerceOrder maps a pending payment status to pending', () => {
  const order = {
    tiendanube_order_id: '2', date_order: '2026-01-01 00:00:00', amount_untaxed: 100,
    state: 'sale', tiendanube_order_payment_status: 'pending', tiendanube_gateway_name: null,
  };
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, null).status, 'pending');
});

test('normalizeOdooEcommerceOrder defaults shippingRevenue to 0 when there is no shipping line', () => {
  const order = {
    tiendanube_order_id: '3', date_order: '2026-01-01 00:00:00', amount_untaxed: 500,
    state: 'sale', tiendanube_order_payment_status: 'paid', tiendanube_gateway_name: 'Pago Nube',
  };
  const lines = [{ product_id: [1, '[MSI018GR] SILLA CHICAGO GRIS'], product_uom_qty: 2, price_subtotal: 500 }];

  const doc = normalizeOdooEcommerceOrder(order, lines, categoryBySku, null);

  assert.equal(doc.shippingRevenue, 0);
  assert.equal(doc.total, 500);
  assert.deepEqual(doc.items, [
    { sku: 'MSI018GR', name: 'SILLA CHICAGO GRIS', category: 'Sillas', qty: 2, unitPrice: 250 },
  ]);
});

test('normalizeOdooEcommerceOrder strips the country-code suffix from the province name, and passes through null', () => {
  const order = {
    tiendanube_order_id: '4', date_order: '2026-01-01 00:00:00', amount_untaxed: 0,
    state: 'sale', tiendanube_order_payment_status: 'paid', tiendanube_gateway_name: null,
  };
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, 'Santa Fe (AR)').shippingProvince, 'Santa Fe');
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, null).shippingProvince, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/normalize.test.mjs`
Expected: FAIL with `normalizeOdooEcommerceOrder is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation**

Append to `backend/normalize.mjs` (after `normalizeOdooSaleOrder`, which ends at line 89):

```js
const SHIPPING_SKU = 'Delivery_007';

function stripCountrySuffix(name) {
  return name.replace(/\s*\([A-Z]{2}\)$/, '');
}

export function normalizeOdooEcommerceOrder(order, lines, categoryBySku, provinceName) {
  const status =
    order.state === 'cancel' ? 'cancelled' :
    order.tiendanube_order_payment_status === 'paid' ? 'completed' :
    'pending';

  const productLines = [];
  let shippingRevenue = 0;
  for (const l of lines) {
    const sku = extractSkuFromDisplayName(l.product_id[1]);
    if (sku === SHIPPING_SKU) {
      shippingRevenue += l.price_subtotal;
    } else {
      productLines.push(l);
    }
  }

  return {
    id: `ecommerce_${order.tiendanube_order_id}`,
    channel: 'ecommerce',
    sourceId: String(order.tiendanube_order_id),
    date: order.date_order,
    status,
    total: order.amount_untaxed - shippingRevenue,
    shippingRevenue,
    paymentMethod: order.tiendanube_gateway_name || null,
    shippingProvince: provinceName ? stripCountrySuffix(provinceName) : null,
    items: productLines.map(l => {
      const sku = extractSkuFromDisplayName(l.product_id[1]);
      return {
        sku,
        name: stripSkuFromDisplayName(l.product_id[1]),
        category: categoryBySku.get(sku) || null,
        qty: l.product_uom_qty,
        unitPrice: l.product_uom_qty ? l.price_subtotal / l.product_uom_qty : 0,
      };
    }),
  };
}
```

And add `normalizeOdooEcommerceOrder` to the import list at the top of `backend/test/normalize.test.mjs`:

```js
import {
  normalizeTiendanubeOrder,
  normalizeOdooPosOrder,
  normalizeOdooSaleOrder,
  normalizeOdooEcommerceOrder,
  extractSkuFromDisplayName,
  stripSkuFromDisplayName,
} from '../normalize.mjs';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test test/normalize.test.mjs`
Expected: PASS (all tests, including the 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add backend/normalize.mjs backend/test/normalize.test.mjs
git commit -m "feat(backend): add normalizeOdooEcommerceOrder with net revenue + shipping split"
```

---

### Task 3: Rewrite `sync/ecommerce.mjs` to source from Odoo, fix `backfill.mjs`

**Files:**
- Modify: `backend/sync/ecommerce.mjs` (full rewrite)
- Modify: `backend/backfill.mjs:25` (since-format for ecommerce)

**Interfaces:**
- Consumes: `normalizeOdooEcommerceOrder` from Task 2; `authenticate`, `callKw`, `fetchAll`, `chunk` from `backend/odoo.mjs` (all pre-existing, same as `sync/mayorista.mjs` uses); `saveSalesDocs`, `getSyncMetadata`, `setSyncMetadata` from `backend/firestore.mjs` (pre-existing).
- Produces: `syncEcommerce(categoryBySku, sinceOverride?)` — **same exported signature as before**, so `backend/index.mjs`'s `runFullSync` (line 108, unchanged) and `backend/backfill.mjs` keep working without touching their call sites (only the `since` format backfill passes changes, in this task's second file).

- [ ] **Step 1: Replace `backend/sync/ecommerce.mjs`**

```js
import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooEcommerceOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const TIENDANUBE_TEAM_ID = 1;

// Odoo RPC has a ~30s timeout and practical request-size limits, so id-list
// calls covering the full 14-month backfill (hundreds of thousands of ids)
// must be chunked into multiple sequential requests.
const CHUNK_SIZE = 2000;

async function fetchLinesByOrderId(lineIds) {
  const linesByOrderId = new Map();
  if (!lineIds.length) return linesByOrderId;

  for (const idChunk of chunk(lineIds, CHUNK_SIZE)) {
    const lines = await callKw('sale.order.line', 'read', [idChunk], {
      fields: ['order_id', 'product_id', 'product_uom_qty', 'price_subtotal'],
    });
    for (const line of lines) {
      if (!line.product_id) continue; // note/section lines (display_type set, no actual product)
      const orderId = line.order_id[0];
      if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
      linesByOrderId.get(orderId).push(line);
    }
  }
  return linesByOrderId;
}

async function fetchProvinceByPartnerId(partnerIds) {
  const provinceByPartnerId = new Map();
  const uniqueIds = [...new Set(partnerIds)];
  if (!uniqueIds.length) return provinceByPartnerId;

  for (const idChunk of chunk(uniqueIds, CHUNK_SIZE)) {
    const partners = await callKw('res.partner', 'read', [idChunk], { fields: ['state_id'] });
    for (const p of partners) {
      if (p.state_id) provinceByPartnerId.set(p.id, p.state_id[1]);
    }
  }
  return provinceByPartnerId;
}

export async function syncEcommerce(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('ecommerce');
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  // Only orders actually placed through Tiendanube (tiendanube_order_id set) count
  // as ecommerce — the same "Tienda Nube" sales team in Odoo also holds manually
  // created orders (exchanges, phone sales, etc.) that must not be counted here.
  // Filter on write_date (last-modified), not date_order, for the same reason
  // mayorista/locales do: an order confirmed/paid after this sync's window opened
  // must still be picked up even if it was originally placed earlier.
  const domain = [
    ['team_id', '=', TIENDANUBE_TEAM_ID],
    ['tiendanube_order_id', '!=', false],
    ['write_date', '>=', since],
  ];
  const orders = await fetchAll('sale.order', domain, [
    'id', 'date_order', 'amount_untaxed', 'state', 'order_line',
    'tiendanube_order_id', 'tiendanube_order_payment_status', 'tiendanube_gateway_name',
    'partner_shipping_id',
  ]);

  const [linesByOrderId, provinceByPartnerId] = await Promise.all([
    fetchLinesByOrderId(orders.flatMap(o => o.order_line)),
    fetchProvinceByPartnerId(orders.map(o => o.partner_shipping_id && o.partner_shipping_id[0]).filter(Boolean)),
  ]);

  const docs = orders.map(order => normalizeOdooEcommerceOrder(
    order,
    linesByOrderId.get(order.id) || [],
    categoryBySku,
    order.partner_shipping_id ? provinceByPartnerId.get(order.partner_shipping_id[0]) : null,
  ));

  await saveSalesDocs(docs);
  await setSyncMetadata('ecommerce', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:ecommerce] ${docs.length} órdenes sincronizadas`);
  return { count: docs.length };
}
```

- [ ] **Step 2: Fix the since-format `backfill.mjs` passes to `syncEcommerce`**

In `backend/backfill.mjs`, line 25 currently reads:

```js
  const ecommerceResult = await syncEcommerce(categoryBySku, monthsAgoISO(months));
```

`syncEcommerce` now expects an Odoo-style `since` (`YYYY-MM-DD HH:MM:SS`), same as `syncLocales`/`syncMayorista` already receive. Change it to:

```js
  const ecommerceResult = await syncEcommerce(categoryBySku, monthsAgoOdoo(months));
```

(`monthsAgoOdoo` is already defined in this file, used by the two calls below it — no new helper needed.)

- [ ] **Step 3: Verify live against Odoo (manual — no unit test for sync code, per project convention)**

Run a short incremental sync manually to confirm it doesn't crash and produces sane data, using a throwaway script (delete it afterward):

```js
// backend/verify-tmp.mjs
import 'dotenv/config';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';

const { categoryBySku } = await syncProducts();
const result = await syncEcommerce(categoryBySku, '2026-07-01 00:00:00');
console.log('Result:', result);
```

Run: `cd backend && node verify-tmp.mjs`
Expected: no errors, `console.log('[sync:ecommerce] N órdenes sincronizadas')` with a plausible N (hundreds, not 36,758+ — the domain filters to `write_date >= since` and excludes the manual `S0xxxx` orders). Then delete the script: `rm backend/verify-tmp.mjs`.

- [ ] **Step 4: Run the full backend test suite**

Run: `cd backend && node --test`
Expected: PASS (all suites — this task didn't change any tested logic, just the untested sync layer, but running the full suite catches accidental import breakage)

- [ ] **Step 5: Commit**

```bash
git add backend/sync/ecommerce.mjs backend/backfill.mjs
git commit -m "feat(backend): source ecommerce sales from Odoo instead of the Tiendanube API"
```

---

### Task 4: "Envíos facturados" KPI card

**Files:**
- Modify: `frontend/src/components/KpiCards.jsx`

**Interfaces:**
- Consumes: `current.shippingRevenue` and `comparisons.<period>.deltas.shippingRevenue` — both already present in `/api/report`'s response after Task 1, with zero additional Dashboard.jsx wiring needed (`KpiCards` already receives `current={report.current.totals}` and `comparisons={report.comparisons}` generically).

- [ ] **Step 1: Add the metric to `KpiCards.jsx`**

In `frontend/src/components/KpiCards.jsx`, add one line to the `METRICS` array (right after the existing `revenue` entry):

```js
const METRICS = [
  { key: 'revenue', label: 'Facturación', format: formatCurrency },
  { key: 'shippingRevenue', label: 'Envíos facturados', format: formatCurrency },
  { key: 'avgDailyRevenue', label: 'Facturación promedio diaria', format: formatCurrency },
  { key: 'orders', label: 'Ventas', format: formatNumber },
  { key: 'units', label: 'Unidades', format: formatNumber },
  { key: 'avgTicket', label: 'Ticket promedio', format: formatCurrency },
  { key: 'cancellationRate', label: 'Tasa de cancelación', format: formatRate, invert: true },
];
```

No other change to this file — the component already maps over `METRICS` generically for both the value and the three comparison badges.

- [ ] **Step 2: Verify manually in the browser**

Start both servers (`cd backend && node index.mjs`, `cd frontend && npm run dev`), log in, and confirm a new "Envíos facturados" KPI card renders next to "Facturación" on every channel tab (showing $0 on Locales/Mayorista tabs, and — once Task 5's backfill has run — a real value on Ecommerce/Consolidado).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/KpiCards.jsx
git commit -m "feat(frontend): add Envíos facturados KPI card"
```

---

### Task 5: Re-run the ecommerce backfill from Odoo, verify end-to-end

**Files:**
- None (operational task — re-runs the already-updated `backend/backfill.mjs`)

**Interfaces:**
- Consumes: `syncEcommerce` (Task 3), `computeTotals`/`diffTotals` (Task 1), `KpiCards` (Task 4) — this task is the end-to-end check that all of them work together against real data.

- [ ] **Step 1: Confirm the existing ecommerce Firestore data doesn't predate the planned backfill window**

The old Tiendanube-API-sourced documents and the new Odoo-sourced ones share the same
document id (`ecommerce_<order id>`), so re-running the backfill overwrites every
existing ecommerce document **as long as the backfill window covers everything that's
already there** — otherwise older documents outside that window would keep their old
bruto shape forever, silently mixing formats in the same collection. Check the oldest
existing ecommerce doc with a throwaway script:

```js
// backend/verify-tmp.mjs
import 'dotenv/config';
import { querySalesByRange } from './firestore.mjs';

const docs = await querySalesByRange(['ecommerce'], '2000-01-01', '2026-07-21');
const oldest = docs.reduce((min, d) => d.date < min ? d.date : min, docs[0]?.date);
console.log(`Total ecommerce docs: ${docs.length}, oldest date: ${oldest}`);
```

Run: `cd backend && node verify-tmp.mjs`, then `rm backend/verify-tmp.mjs`. Confirm the
oldest date is within the last 14 months (per project memory, the full 14-month backfill
was never actually run — only smoke-tested at 1 month — so this should hold). If it
doesn't, re-run Step 2 below with a larger `--months=` value covering the oldest date
found.

- [ ] **Step 2: Run the full backfill**

Run: `cd backend && node backfill.mjs --months=14`
Expected: completes without errors; `[backfill] ecommerce: { count: N }` with N in the
tens of thousands (this now covers real Tiendanube-origin orders across the full window,
not just the last sync's incremental slice).

- [ ] **Step 3: Verify in the browser**

Start both servers, log in, and check the **Ecommerce** tab:
- "Facturación" should be visibly lower than before this change (net of IVA and
  shipping) — compare against a note of the old value if available, or just confirm
  it's less than "Facturación" + "Envíos facturados" combined would have been under the
  old bruto total.
- "Envíos facturados" shows a nonzero value.
- "Top productos" and "Ventas por categoría" still populate (proves `items`/`unitPrice`
  wiring survived the switch).
- "Top provincias" still populates (province names will look different from before —
  e.g. "Ciudad Autonoma De Buenos Aires" instead of "Capital Federal" — that's expected,
  not a bug, per the design spec).
- Check the **Consolidado** tab still loads without errors (mixed net/bruto totals
  across channels is expected per the design spec, not a bug).

- [ ] **Step 4: Run both test suites one final time**

Run: `cd backend && node --test`
Run: `cd frontend && npm test -- --run`
Expected: PASS on both.

- [ ] **Step 5: Commit** (only if Step 1 required a `--months=` value different from 14, changing a tracked file — otherwise this task has nothing to commit, since the backfill only touches Firestore, not git-tracked files)

```bash
git status --short
```

If clean, nothing to commit — the feature is done as of Task 4's commit. If Step 1
required updating the default in `backend/backfill.mjs` (unlikely), commit that change
with a message like `fix(backend): widen default backfill window to cover full ecommerce history`.

---

## Self-Review Notes

- **Spec coverage:** Data source switch → Task 3. Net-sin-IVA + shipping split → Task 2 (normalizer) + Task 1 (KPI plumbing). Filter out manual `S0xxxx` orders → Task 3's domain filter. Shipping as separate KPI, excluded from Facturación → Task 1 + Task 4. Backfill re-run → Task 5. Locales/Mayorista untouched → stated as a Global Constraint, no task modifies those files.
- **Doc-id continuity risk flagged in the spec** (whether `tiendanube_order_id` matches the id scheme already used) was resolved during planning by querying both Odoo and Firestore live — confirmed matching string format (e.g. `"2024692415"` in both places) — so Task 3/5 don't need a fallback "what if it doesn't match" path.
