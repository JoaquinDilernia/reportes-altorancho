# Backend Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node/Express backend that syncs sales data from Odoo (locales + mayorista) and Tienda Nube (ecommerce) into Firestore, and exposes a single authenticated report endpoint the future React dashboard will consume.

**Architecture:** Odoo (JSON-RPC) and Tienda Nube (REST) connectors feed per-channel sync jobs that normalize orders into a common shape and write them to Firestore. A cron runs the syncs periodically; an Express API reads back from Firestore and computes report bundles (totals, comparisons, top products, categories, payment methods, provinces) on demand behind a simple password-based auth.

**Tech Stack:** Node.js (ESM, `.mjs`), Express, `firebase-admin`, `node-cron`, Node's built-in test runner (`node --test`) — same stack as the existing `odoo-sync-server` project, no new test framework introduced.

## Global Constraints

- Project lives at `Reportes/backend/` in this repo (independent from `odoo-sync-server`).
- Reuses the same Firebase project as `odoo-sync-server`, but all collections are prefixed `altorancho_reportes_` to avoid colliding with existing collections (`pickalto_products`, `sync_metadata`).
- Odoo connection: JSON-RPC, session-cookie auth, same pattern as `odoo-sync-server/odoo.mjs` (verified working against `https://lett.exemax.ar`).
- Tiendanube connection: REST API v1, `Authentication: bearer {token}` header + required `User-Agent` header, base URL `https://api.tiendanube.com/v1/{store_id}` (verified working against store id `2547699`).
- Locales: `pos.order` filtered by `config_id` — Lomas=2, Belgrano=5, Alcorta=7 (verified live; Nordelta=3 and "Prueba"=4/6 have no real traffic and are excluded).
- Mayorista: `sale.order` filtered by `team_id`/`crm_team_id` = 8 ("Mayorista") — verified live, 509 orders in the last 60 days.
- No automated tests against live Odoo/Tiendanube/Firestore — only pure logic (normalizers, period math, category helpers, aggregation, auth token) gets `node --test` unit tests, matching the existing `odoo-sync-server` convention (see `test/format.test.mjs`). Connector and sync code is verified manually by running the script and inspecting output.
- Single user, no roles: auth is one shared password + signed token, no user accounts table.

---

### Task 1: Project scaffolding + health check

**Files:**
- Create: `backend/package.json`
- Create: `backend/.env.example`
- Create: `backend/index.mjs`

**Interfaces:**
- Produces: `app` (Express instance) exported from `index.mjs` for later tasks to attach routes to; server only calls `app.listen` when run directly.

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "altorancho-reportes-backend",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node index.mjs",
    "dev": "node --watch index.mjs",
    "test": "node --test test/**/*.test.mjs",
    "backfill": "node backfill.mjs"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.18.2",
    "firebase-admin": "^12.0.0",
    "node-cron": "^3.0.3"
  }
}
```

- [ ] **Step 2: Create `backend/.env.example`**

```
ODOO_URL=https://lett.exemax.ar
ODOO_DB=odoo
ODOO_LOGIN=dashboard.api@lettcomercial.com
ODOO_PASSWORD=

TN_STORE_ID=2547699
TN_ACCESS_TOKEN=
TN_USER_AGENT=AltoranchoReportes (jdilernia99@gmail.com)

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"

DASHBOARD_PASSWORD=change-this
AUTH_SECRET=change-this-to-a-random-32-char-string

PORT=3000
SYNC_INTERVAL_HOURS=4
ALLOWED_ORIGIN=*
```

- [ ] **Step 3: Create `backend/index.mjs`**

```js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

export const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
}
```

- [ ] **Step 4: Install dependencies and verify manually**

Run: `cd backend && npm install`
Run: `npm run dev` (leave running)
Run in another terminal: `curl http://localhost:3000/health`
Expected: `{"ok":true}`

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/.env.example backend/index.mjs
git commit -m "feat(backend): scaffold Express project with health check"
```

---

### Task 2: Odoo connector

**Files:**
- Create: `backend/odoo.mjs`

**Interfaces:**
- Produces: `authenticate()`, `callKw(model, method, args, kwargs)`, `fetchAll(model, domain, fields, pageSize)` — used by every Odoo-facing sync task.

- [ ] **Step 1: Create `backend/odoo.mjs`** (ported verbatim from `odoo-sync-server/odoo.mjs`, already proven in production)

```js
import 'dotenv/config';

const BASE_URL = process.env.ODOO_URL;
const DB       = process.env.ODOO_DB;
const LOGIN    = process.env.ODOO_LOGIN;
const PASSWORD = process.env.ODOO_PASSWORD;

let sessionCookie = '';

async function rpc(endpoint, params) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionCookie) headers['Cookie'] = sessionCookie;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers,
    signal:  AbortSignal.timeout(30_000),
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 1, params }),
  });

  const sc = res.headers.get('set-cookie');
  if (sc) {
    const m = sc.match(/session_id=([^;]+)/);
    if (m) sessionCookie = `session_id=${m[1]}`;
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Odoo RPC error: ${json.error.data?.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

export async function authenticate() {
  sessionCookie = '';
  const result = await rpc('/web/session/authenticate', { db: DB, login: LOGIN, password: PASSWORD });
  if (!result?.uid) throw new Error('Odoo authentication failed — check credentials');
  console.log(`[odoo] authenticated uid=${result.uid}`);
}

export async function callKw(model, method, args = [], kwargs = {}) {
  return rpc('/web/dataset/call_kw', {
    model, method, args,
    kwargs: { context: { lang: 'es_AR' }, ...kwargs },
  });
}

export async function fetchAll(model, domain, fields, pageSize = 1000) {
  const results = [];
  let offset = 0;
  while (true) {
    const page = await callKw(model, 'search_read', [domain], { fields, limit: pageSize, offset });
    results.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}
```

- [ ] **Step 2: Verify manually against the real Odoo instance**

Create a throwaway file `backend/tmp-check.mjs`:

```js
import { authenticate, fetchAll } from './odoo.mjs';
await authenticate();
const configs = await fetchAll('pos.config', [], ['id', 'name']);
console.log(configs);
```

Run: `node backend/tmp-check.mjs`
Expected output includes the 3 known stores: `{ id: 2, name: 'Las Lomas de San Isidro' }`, `{ id: 5, name: 'Belgrano' }`, `{ id: 7, name: 'Alcorta' }`.

Delete `backend/tmp-check.mjs` after confirming.

- [ ] **Step 3: Commit**

```bash
git add backend/odoo.mjs
git commit -m "feat(backend): add Odoo JSON-RPC connector"
```

---

### Task 3: Tiendanube connector

**Files:**
- Create: `backend/tiendanube.mjs`

**Interfaces:**
- Produces: `fetchOrdersSince(sinceISO)`, `fetchAllProducts()` — used by the ecommerce and products sync tasks.

- [ ] **Step 1: Create `backend/tiendanube.mjs`**

```js
import 'dotenv/config';

const BASE_URL   = 'https://api.tiendanube.com/v1';
const STORE_ID   = process.env.TN_STORE_ID;
const TOKEN      = process.env.TN_ACCESS_TOKEN;
const USER_AGENT = process.env.TN_USER_AGENT || 'AltoranchoReportes';

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const nextPart = linkHeader.split(',').find(part => part.includes('rel="next"'));
  if (!nextPart) return null;
  const match = nextPart.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function request(url) {
  const res = await fetch(url, {
    headers: {
      'Authentication': `bearer ${TOKEN}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get('retry-after') || 2);
    console.log(`[tiendanube] rate limited, waiting ${retryAfterSec}s`);
    await new Promise(r => setTimeout(r, retryAfterSec * 1000));
    return request(url);
  }

  if (!res.ok) {
    throw new Error(`Tiendanube API error ${res.status}: ${await res.text()}`);
  }

  return { data: await res.json(), next: parseNextLink(res.headers.get('link')) };
}

export async function fetchAllPages(resource, params = {}) {
  const query = new URLSearchParams({ per_page: '200', ...params }).toString();
  let url = `${BASE_URL}/${STORE_ID}/${resource}?${query}`;
  const results = [];

  while (url) {
    const { data, next } = await request(url);
    results.push(...data);
    url = next;
  }

  return results;
}

export async function fetchOrdersSince(sinceISO) {
  const params = sinceISO ? { updated_at_min: sinceISO } : {};
  return fetchAllPages('orders', params);
}

export async function fetchAllProducts() {
  return fetchAllPages('products');
}
```

- [ ] **Step 2: Verify manually against the real Tiendanube API**

Create a throwaway file `backend/tmp-check.mjs`:

```js
import { fetchAllPages, fetchOrdersSince } from './tiendanube.mjs';

const recent = await fetchAllPages('orders', { per_page: '5' });
console.log('sample order fields:', Object.keys(recent[0]));
console.log('sample sku:', recent[0].products[0]?.sku);

// Confirm the updated_at_min filter actually narrows results (it must return
// fewer orders than the full unfiltered set for a recent-enough timestamp).
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const filtered = await fetchOrdersSince(since);
console.log(`orders updated in the last 24h: ${filtered.length}`);
```

Run: `node backend/tmp-check.mjs`
Expected: sample order fields include `id`, `status`, `payment_status`, `products`, `shipping_address`, `gateway_name`; the 24h-filtered count is a small, plausible number (tens, not tens of thousands). If `updated_at_min` is not respected (filtered count equals the full store total), stop and re-check Tiendanube's documented order filters before continuing to Task 9.

Delete `backend/tmp-check.mjs` after confirming.

- [ ] **Step 3: Commit**

```bash
git add backend/tiendanube.mjs
git commit -m "feat(backend): add Tiendanube REST connector"
```

---

### Task 4: Period range math

**Files:**
- Create: `backend/periods.mjs`
- Test: `backend/test/periods.test.mjs`

**Interfaces:**
- Produces: `getPeriodRanges(dateStr, period)` → `{ current, prevPeriod, prevMonth, prevYear }`, each `{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }`. Consumed by the report endpoint (Task 14) to know which Firestore date ranges to query.

- [ ] **Step 1: Write the failing tests**

```js
// backend/test/periods.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPeriodRanges } from '../periods.mjs';

// 2024-01-01 was a Monday (verified calendar fact) — used as a safe anchor.
test('week period: anchor mid-week resolves to Monday-Sunday', () => {
  const { current } = getPeriodRanges('2024-01-03', 'week'); // Wednesday
  assert.deepEqual(current, { start: '2024-01-01', end: '2024-01-07' });
});

test('week period: prevPeriod is the 7 days before', () => {
  const { prevPeriod } = getPeriodRanges('2024-01-03', 'week');
  assert.deepEqual(prevPeriod, { start: '2023-12-25', end: '2023-12-31' });
});

test('week period: prevMonth shifts the same range back one calendar month', () => {
  const { prevMonth } = getPeriodRanges('2024-01-03', 'week');
  assert.deepEqual(prevMonth, { start: '2023-12-01', end: '2023-12-07' });
});

test('week period: prevYear shifts the same range back one year', () => {
  const { prevYear } = getPeriodRanges('2024-01-03', 'week');
  assert.deepEqual(prevYear, { start: '2023-01-01', end: '2023-01-07' });
});

test('month period: current spans the full calendar month', () => {
  const { current } = getPeriodRanges('2024-01-15', 'month');
  assert.deepEqual(current, { start: '2024-01-01', end: '2024-01-31' });
});

test('month period: prevPeriod is the previous calendar month', () => {
  const { prevPeriod } = getPeriodRanges('2024-01-15', 'month');
  assert.deepEqual(prevPeriod, { start: '2023-12-01', end: '2023-12-31' });
});

test('month period: prevYear is the same month one year back', () => {
  const { prevYear } = getPeriodRanges('2024-01-15', 'month');
  assert.deepEqual(prevYear, { start: '2023-01-01', end: '2023-01-31' });
});

test('unknown period throws', () => {
  assert.throws(() => getPeriodRanges('2024-01-15', 'day'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/periods.test.mjs`
Expected: FAIL with "Cannot find module '../periods.mjs'"

- [ ] **Step 3: Create `backend/periods.mjs`**

```js
function pad(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }

function mondayOf(d) {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday;
}

function firstDayOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function lastDayOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function shiftMonths(d, delta) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, d.getUTCDate()));
}

function shiftYears(d, delta) {
  return new Date(Date.UTC(d.getUTCFullYear() + delta, d.getUTCMonth(), d.getUTCDate()));
}

export function getPeriodRanges(dateStr, period) {
  const date = new Date(`${dateStr}T00:00:00Z`);

  let start, end;
  if (period === 'week') {
    start = mondayOf(date);
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
  } else if (period === 'month') {
    start = firstDayOfMonth(date);
    end = lastDayOfMonth(date);
  } else {
    throw new Error(`Unknown period: ${period}`);
  }

  const current = { start: toISODate(start), end: toISODate(end) };

  let prevPeriod;
  if (period === 'week') {
    const ps = new Date(start); ps.setUTCDate(start.getUTCDate() - 7);
    const pe = new Date(end);   pe.setUTCDate(end.getUTCDate() - 7);
    prevPeriod = { start: toISODate(ps), end: toISODate(pe) };
  } else {
    const prevMonthAnchor = shiftMonths(start, -1);
    prevPeriod = {
      start: toISODate(firstDayOfMonth(prevMonthAnchor)),
      end: toISODate(lastDayOfMonth(prevMonthAnchor)),
    };
  }

  const prevMonth = {
    start: toISODate(shiftMonths(start, -1)),
    end: toISODate(shiftMonths(end, -1)),
  };

  const prevYear = {
    start: toISODate(shiftYears(start, -1)),
    end: toISODate(shiftYears(end, -1)),
  };

  return { current, prevPeriod, prevMonth, prevYear };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/periods.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/periods.mjs backend/test/periods.test.mjs
git commit -m "feat(backend): add period range calculation with comparison windows"
```

---

### Task 5: Category helpers

**Files:**
- Create: `backend/categories.mjs`
- Test: `backend/test/categories.test.mjs`

**Interfaces:**
- Produces: `leafOdooCategoryName(categPath)`, `primaryTiendanubeCategory(categories)`. Consumed by Task 6 (normalizers) and Task 8 (products sync).

- [ ] **Step 1: Write the failing tests**

```js
// backend/test/categories.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leafOdooCategoryName, primaryTiendanubeCategory } from '../categories.mjs';

test('leafOdooCategoryName extracts the last path segment', () => {
  assert.equal(
    leafOdooCategoryName('All / Biblia/ BAZAR / COMEDOR / TEXTILES DE MESA Y ACCESORIOS / MANTEL / CARDON'),
    'CARDON'
  );
});

test('leafOdooCategoryName trims whitespace', () => {
  assert.equal(leafOdooCategoryName('All /  Sillas '), 'Sillas');
});

test('leafOdooCategoryName returns null for missing path', () => {
  assert.equal(leafOdooCategoryName(null), null);
  assert.equal(leafOdooCategoryName(undefined), null);
});

test('primaryTiendanubeCategory picks the first category name in Spanish', () => {
  const categories = [
    { name: { es: 'Iluminación' } },
    { name: { es: 'Lámparas colgantes' } },
  ];
  assert.equal(primaryTiendanubeCategory(categories), 'Iluminación');
});

test('primaryTiendanubeCategory returns null for empty or missing list', () => {
  assert.equal(primaryTiendanubeCategory([]), null);
  assert.equal(primaryTiendanubeCategory(undefined), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/categories.test.mjs`
Expected: FAIL with "Cannot find module '../categories.mjs'"

- [ ] **Step 3: Create `backend/categories.mjs`**

```js
export function leafOdooCategoryName(categPath) {
  if (!categPath) return null;
  const parts = categPath.split('/').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function primaryTiendanubeCategory(categories) {
  if (!categories || categories.length === 0) return null;
  return categories[0].name?.es || null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/categories.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/categories.mjs backend/test/categories.test.mjs
git commit -m "feat(backend): add category normalization helpers"
```

---

### Task 6: Order normalizers

**Files:**
- Create: `backend/normalize.mjs`
- Test: `backend/test/normalize.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (pure functions), but callers will pass in a `categoryBySku` (`Map<string,string|null>`) built by Task 8.
- Produces: `normalizeTiendanubeOrder(order, categoryBySku)`, `normalizeOdooPosOrder(order, lines, channel, categoryBySku, paymentMethodName)`, `normalizeOdooSaleOrder(order, lines, categoryBySku)`, `extractSkuFromDisplayName(displayName)`, `stripSkuFromDisplayName(displayName)`. Each returns the common `sales` doc shape:
  ```js
  {
    id, channel, sourceId, date, status, total,
    paymentMethod, shippingProvince,
    items: [{ sku, name, category, qty, unitPrice }]
  }
  ```
  Consumed by Task 7 (`saveSalesDocs`) and Tasks 9-11 (sync jobs).

- [ ] **Step 1: Write the failing tests**

```js
// backend/test/normalize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTiendanubeOrder,
  normalizeOdooPosOrder,
  normalizeOdooSaleOrder,
  extractSkuFromDisplayName,
  stripSkuFromDisplayName,
} from '../normalize.mjs';

const categoryBySku = new Map([
  ['MSI018GR', 'Sillas'],
  ['BTE249MB', 'Textiles'],
]);

test('normalizeTiendanubeOrder maps a paid order to completed', () => {
  const order = {
    id: 2013996982,
    status: 'open',
    payment_status: 'paid',
    created_at: '2026-07-08T14:33:14+0000',
    total: '395960.00',
    gateway_name: 'Mercado Pago',
    shipping_address: { province: 'Capital Federal' },
    products: [{ sku: 'MSI018GR', name: 'Silla Chicago Gris', quantity: 4, price: '89990.00' }],
  };

  const doc = normalizeTiendanubeOrder(order, categoryBySku);

  assert.equal(doc.id, 'ecommerce_2013996982');
  assert.equal(doc.channel, 'ecommerce');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.total, 395960);
  assert.equal(doc.paymentMethod, 'Mercado Pago');
  assert.equal(doc.shippingProvince, 'Capital Federal');
  assert.deepEqual(doc.items, [
    { sku: 'MSI018GR', name: 'Silla Chicago Gris', category: 'Sillas', qty: 4, unitPrice: 89990 },
  ]);
});

test('normalizeTiendanubeOrder maps a cancelled order regardless of payment_status', () => {
  const order = {
    id: 1, status: 'cancelled', payment_status: 'paid', created_at: '2026-01-01T00:00:00Z',
    total: '100.00', gateway_name: null, shipping_address: null, products: [],
  };
  assert.equal(normalizeTiendanubeOrder(order, categoryBySku).status, 'cancelled');
});

test('normalizeTiendanubeOrder maps a pending payment to pending', () => {
  const order = {
    id: 2, status: 'open', payment_status: 'pending', created_at: '2026-01-01T00:00:00Z',
    total: '100.00', gateway_name: null, shipping_address: null, products: [],
  };
  assert.equal(normalizeTiendanubeOrder(order, categoryBySku).status, 'pending');
});

test('extractSkuFromDisplayName reads the bracketed SKU', () => {
  assert.equal(extractSkuFromDisplayName('[MSI018GR] SILLA CHICAGO GRIS'), 'MSI018GR');
});

test('stripSkuFromDisplayName removes the bracketed SKU', () => {
  assert.equal(stripSkuFromDisplayName('[MSI018GR] SILLA CHICAGO GRIS'), 'SILLA CHICAGO GRIS');
});

test('normalizeOdooPosOrder maps paid/done/invoiced to completed', () => {
  const order = { id: 39875, date_order: '2026-07-08 14:18:45', amount_total: 16990, state: 'invoiced' };
  const lines = [{ product_id: [1, '[MSI018GR] SILLA CHICAGO GRIS'], qty: 1, price_unit: 16990 }];

  const doc = normalizeOdooPosOrder(order, lines, 'local_lomas', categoryBySku, 'Mercado Pago');

  assert.equal(doc.id, 'local_lomas_39875');
  assert.equal(doc.channel, 'local_lomas');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.paymentMethod, 'Mercado Pago');
  assert.equal(doc.shippingProvince, null);
  assert.deepEqual(doc.items, [
    { sku: 'MSI018GR', name: 'SILLA CHICAGO GRIS', category: 'Sillas', qty: 1, unitPrice: 16990 },
  ]);
});

test('normalizeOdooPosOrder maps cancel state to cancelled', () => {
  const order = { id: 1, date_order: '2026-01-01 00:00:00', amount_total: 0, state: 'cancel' };
  assert.equal(normalizeOdooPosOrder(order, [], 'local_belgrano', categoryBySku, null).status, 'cancelled');
});

test('normalizeOdooPosOrder maps draft state to pending', () => {
  const order = { id: 1, date_order: '2026-01-01 00:00:00', amount_total: 0, state: 'draft' };
  assert.equal(normalizeOdooPosOrder(order, [], 'local_belgrano', categoryBySku, null).status, 'pending');
});

test('normalizeOdooSaleOrder maps sale/done to completed and uses product_uom_qty', () => {
  const order = { id: 51269, date_order: '2026-07-08 14:52:14', amount_total: 849746.7, state: 'sale' };
  const lines = [{ product_id: [1, '[BTE249MB] MANTEL RAYADO'], product_uom_qty: 3, price_unit: 283248.9 }];

  const doc = normalizeOdooSaleOrder(order, lines, categoryBySku);

  assert.equal(doc.id, 'mayorista_51269');
  assert.equal(doc.channel, 'mayorista');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.paymentMethod, null);
  assert.deepEqual(doc.items, [
    { sku: 'BTE249MB', name: 'MANTEL RAYADO', category: 'Textiles', qty: 3, unitPrice: 283248.9 },
  ]);
});

test('normalizeOdooSaleOrder maps draft state to pending', () => {
  const order = { id: 1, date_order: '2026-01-01 00:00:00', amount_total: 0, state: 'draft' };
  assert.equal(normalizeOdooSaleOrder(order, [], categoryBySku).status, 'pending');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/normalize.test.mjs`
Expected: FAIL with "Cannot find module '../normalize.mjs'"

- [ ] **Step 3: Create `backend/normalize.mjs`**

```js
export function extractSkuFromDisplayName(displayName) {
  const m = displayName.match(/^\[(.+?)\]/);
  return m ? m[1] : displayName;
}

export function stripSkuFromDisplayName(displayName) {
  return displayName.replace(/^\[.+?\]\s*/, '');
}

export function normalizeTiendanubeOrder(order, categoryBySku) {
  const status =
    order.status === 'cancelled' ? 'cancelled' :
    order.payment_status === 'paid' ? 'completed' :
    'pending';

  return {
    id: `ecommerce_${order.id}`,
    channel: 'ecommerce',
    sourceId: String(order.id),
    date: order.created_at,
    status,
    total: Number(order.total),
    paymentMethod: order.gateway_name || null,
    shippingProvince: order.shipping_address?.province || null,
    items: (order.products || []).map(p => ({
      sku: p.sku,
      name: p.name,
      category: categoryBySku.get(p.sku) || null,
      qty: p.quantity,
      unitPrice: Number(p.price),
    })),
  };
}

export function normalizeOdooPosOrder(order, lines, channel, categoryBySku, paymentMethodName) {
  const status =
    order.state === 'cancel' ? 'cancelled' :
    ['paid', 'done', 'invoiced'].includes(order.state) ? 'completed' :
    'pending';

  return {
    id: `${channel}_${order.id}`,
    channel,
    sourceId: String(order.id),
    date: order.date_order,
    status,
    total: Number(order.amount_total),
    paymentMethod: paymentMethodName || null,
    shippingProvince: null,
    items: lines.map(l => {
      const sku = extractSkuFromDisplayName(l.product_id[1]);
      return {
        sku,
        name: stripSkuFromDisplayName(l.product_id[1]),
        category: categoryBySku.get(sku) || null,
        qty: l.qty,
        unitPrice: l.price_unit,
      };
    }),
  };
}

export function normalizeOdooSaleOrder(order, lines, categoryBySku) {
  const status =
    order.state === 'cancel' ? 'cancelled' :
    ['sale', 'done'].includes(order.state) ? 'completed' :
    'pending';

  return {
    id: `mayorista_${order.id}`,
    channel: 'mayorista',
    sourceId: String(order.id),
    date: order.date_order,
    status,
    total: Number(order.amount_total),
    paymentMethod: null,
    shippingProvince: null,
    items: lines.map(l => {
      const sku = extractSkuFromDisplayName(l.product_id[1]);
      return {
        sku,
        name: stripSkuFromDisplayName(l.product_id[1]),
        category: categoryBySku.get(sku) || null,
        qty: l.product_uom_qty,
        unitPrice: l.price_unit,
      };
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/normalize.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/normalize.mjs backend/test/normalize.test.mjs
git commit -m "feat(backend): add order normalizers for Tiendanube and Odoo sources"
```

---

### Task 7: Firestore module

**Files:**
- Create: `backend/firestore.mjs`

**Interfaces:**
- Consumes: `sales` doc shape from Task 6.
- Produces: `saveSalesDocs(docs)`, `querySalesByRange(channels, startDate, endDate)`, `saveProducts(docs)`, `getProductsBySku()`, `getSyncMetadata(channel)`, `setSyncMetadata(channel, data)`. Consumed by Tasks 8-11 and Task 14.

- [ ] **Step 1: Create `backend/firestore.mjs`**

```js
import 'dotenv/config';
import admin from 'firebase-admin';

let db;

function getDb() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }
    db = admin.firestore();
  }
  return db;
}

const SALES_COL    = 'altorancho_reportes_sales';
const PRODUCTS_COL = 'altorancho_reportes_products';
const METADATA_COL = 'altorancho_reportes_sync_metadata';
const BATCH_SIZE   = 500;

export async function saveSalesDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(SALES_COL).doc(doc.id), {
        ...doc,
        date: admin.firestore.Timestamp.fromDate(new Date(doc.date)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  return { written: docs.length };
}

export async function querySalesByRange(channels, startDate, endDate) {
  const firestore = getDb();
  const start = admin.firestore.Timestamp.fromDate(new Date(`${startDate}T00:00:00Z`));
  const end = admin.firestore.Timestamp.fromDate(new Date(`${endDate}T23:59:59Z`));

  const snap = await firestore.collection(SALES_COL)
    .where('channel', 'in', channels)
    .where('date', '>=', start)
    .where('date', '<=', end)
    .get();

  return snap.docs.map(d => {
    const data = d.data();
    return { ...data, date: data.date.toDate().toISOString() };
  });
}

export async function saveProducts(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(PRODUCTS_COL).doc(doc.sku), doc);
    }
    await batch.commit();
  }
  return { written: docs.length };
}

export async function getProductsBySku() {
  const firestore = getDb();
  const snap = await firestore.collection(PRODUCTS_COL).get();
  const map = new Map();
  for (const doc of snap.docs) map.set(doc.id, doc.data());
  return map;
}

export async function getSyncMetadata(channel) {
  const firestore = getDb();
  const snap = await firestore.collection(METADATA_COL).doc(channel).get();
  return snap.exists ? snap.data() : null;
}

export async function setSyncMetadata(channel, data) {
  const firestore = getDb();
  await firestore.collection(METADATA_COL).doc(channel).set({
    ...data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
```

Note: Firestore's `in` operator on `channel` supports up to 10 values, well within our 5 channels, and combining it with a range filter on `date` requires a composite index — Firestore will return an error on first use with a direct link to create it; follow that link when it appears during Task 14's manual verification.

- [ ] **Step 2: Verify manually**

Create `backend/tmp-check.mjs`:

```js
import { saveSalesDocs, querySalesByRange, setSyncMetadata, getSyncMetadata } from './firestore.mjs';

await saveSalesDocs([{
  id: 'ecommerce_test1', channel: 'ecommerce', sourceId: 'test1',
  date: '2026-07-01T12:00:00Z', status: 'completed', total: 1000,
  paymentMethod: 'Mercado Pago', shippingProvince: 'Capital Federal',
  items: [{ sku: 'TEST', name: 'Test product', category: 'Test', qty: 1, unitPrice: 1000 }],
}]);

const results = await querySalesByRange(['ecommerce'], '2026-07-01', '2026-07-01');
console.log('queried back:', results);

await setSyncMetadata('ecommerce', { lastSyncedAt: new Date().toISOString(), count: 1 });
console.log('metadata:', await getSyncMetadata('ecommerce'));
```

Run: `node backend/tmp-check.mjs`
Expected: the query returns the one test document with `date` as an ISO string; metadata round-trips.

Then manually delete the test doc via the Firebase console (`altorancho_reportes_sales/ecommerce_test1`) so it doesn't pollute the report later. Delete `backend/tmp-check.mjs`.

- [ ] **Step 3: Commit**

```bash
git add backend/firestore.mjs
git commit -m "feat(backend): add Firestore read/write layer for sales, products, sync metadata"
```

---

### Task 8: Products sync

**Files:**
- Create: `backend/sync/products.mjs`

**Interfaces:**
- Consumes: `fetchAllProducts` (Task 3), `authenticate`/`fetchAll` (Task 2), `primaryTiendanubeCategory`/`leafOdooCategoryName` (Task 5), `saveProducts` (Task 7).
- Produces: `syncProducts()` → `Promise<{ categoryBySku: Map<string,string|null>, count: number }>`. Consumed by Tasks 9-11 (each order sync needs `categoryBySku`) and Task 15 (cron wiring).

- [ ] **Step 1: Create `backend/sync/products.mjs`**

```js
import { fetchAllProducts } from '../tiendanube.mjs';
import { authenticate, fetchAll } from '../odoo.mjs';
import { primaryTiendanubeCategory, leafOdooCategoryName } from '../categories.mjs';
import { saveProducts } from '../firestore.mjs';

export async function syncProducts() {
  const categoryBySku = new Map();
  const productDocs = [];

  const tnProducts = await fetchAllProducts();
  for (const product of tnProducts) {
    const category = primaryTiendanubeCategory(product.categories);
    for (const variant of product.variants) {
      if (!variant.sku) continue;
      categoryBySku.set(variant.sku, category);
      productDocs.push({
        sku: variant.sku,
        name: product.name?.es || '',
        category,
        currentStock: variant.stock ?? 0,
      });
    }
  }

  await authenticate();
  const odooProducts = await fetchAll(
    'product.template',
    [['default_code', '!=', false]],
    ['default_code', 'name', 'categ_id'],
  );

  const knownSkus = new Set(productDocs.map(d => d.sku));
  for (const p of odooProducts) {
    const sku = p.default_code.trim();
    if (knownSkus.has(sku)) continue; // ya cargado desde Tienda Nube, con su stock real
    const category = leafOdooCategoryName(p.categ_id?.[1]);
    categoryBySku.set(sku, category);
    productDocs.push({ sku, name: p.name.trim(), category, currentStock: null });
  }

  console.log(`[sync:products] ${productDocs.length} productos (${knownSkus.size} desde Tienda Nube)`);
  await saveProducts(productDocs);
  return { categoryBySku, count: productDocs.length };
}
```

Note: products that only exist in Odoo (not sold through Tienda Nube — e.g. exclusive wholesale items) get `currentStock: null` in this v1. The frontend's top-products table should render `—` for a null stock rather than `0`, so it isn't confused with "out of stock". This is a deliberate scope cut, not an oversight — most catalog items are also listed on Tienda Nube.

- [ ] **Step 2: Verify manually**

Run: `node -e "import('./backend/sync/products.mjs').then(m => m.syncProducts()).then(r => console.log(r.count, 'products synced'))"`
Expected: a plausible product count (likely several thousand), no errors. Spot-check a few SKUs in the Firebase console under `altorancho_reportes_products` to confirm `name`/`category`/`currentStock` look sane.

- [ ] **Step 3: Commit**

```bash
git add backend/sync/products.mjs
git commit -m "feat(backend): sync product catalog (category + stock) from Tiendanube and Odoo"
```

---

### Task 9: Ecommerce sync

**Files:**
- Create: `backend/sync/ecommerce.mjs`

**Interfaces:**
- Consumes: `fetchOrdersSince` (Task 3), `normalizeTiendanubeOrder` (Task 6), `saveSalesDocs`/`getSyncMetadata`/`setSyncMetadata` (Task 7).
- Produces: `syncEcommerce(categoryBySku)` → `Promise<{ count: number }>`. Consumed by Task 15 (cron) and Task 16 (backfill).

- [ ] **Step 1: Create `backend/sync/ecommerce.mjs`**

```js
import { fetchOrdersSince } from '../tiendanube.mjs';
import { normalizeTiendanubeOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

export async function syncEcommerce(categoryBySku, sinceOverride) {
  const meta = await getSyncMetadata('ecommerce');
  const since = sinceOverride || meta?.lastSyncedAt || null;

  const orders = await fetchOrdersSince(since);
  const docs = orders.map(order => normalizeTiendanubeOrder(order, categoryBySku));

  await saveSalesDocs(docs);
  await setSyncMetadata('ecommerce', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:ecommerce] ${docs.length} órdenes sincronizadas (desde ${since || 'el origen'})`);
  return { count: docs.length };
}
```

- [ ] **Step 2: Verify manually**

Run: `node -e "import('./backend/sync/products.mjs').then(m => m.syncProducts()).then(({categoryBySku}) => import('./backend/sync/ecommerce.mjs').then(e => e.syncEcommerce(categoryBySku, '2026-07-01T00:00:00Z')))"`
Expected: a plausible order count synced for the last week. Spot-check a document in `altorancho_reportes_sales` in the Firebase console — `channel` should be `ecommerce`, `items[].category` should be populated for most items (not all `null`).

- [ ] **Step 3: Commit**

```bash
git add backend/sync/ecommerce.mjs
git commit -m "feat(backend): sync ecommerce orders from Tiendanube into Firestore"
```

---

### Task 10: Locales sync

**Files:**
- Create: `backend/sync/locales.mjs`

**Interfaces:**
- Consumes: `authenticate`/`callKw`/`fetchAll` (Task 2), `normalizeOdooPosOrder` (Task 6), `saveSalesDocs`/`getSyncMetadata`/`setSyncMetadata` (Task 7).
- Produces: `syncLocales(categoryBySku)` → `Promise<Record<string, number>>` (count per store channel). Consumed by Task 15 (cron) and Task 16 (backfill).

- [ ] **Step 1: Create `backend/sync/locales.mjs`**

```js
import { authenticate, callKw, fetchAll } from '../odoo.mjs';
import { normalizeOdooPosOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const STORES = [
  { configId: 2, channel: 'local_lomas' },
  { configId: 5, channel: 'local_belgrano' },
  { configId: 7, channel: 'local_alcorta' },
];

async function fetchPaymentMethodByOrderId(orderIds) {
  const methodByOrderId = new Map();
  if (!orderIds.length) return methodByOrderId;

  const payments = await callKw('pos.payment', 'search_read', [[['pos_order_id', 'in', orderIds]]], {
    fields: ['pos_order_id', 'payment_method_id'],
  });
  for (const p of payments) {
    if (!methodByOrderId.has(p.pos_order_id[0])) {
      methodByOrderId.set(p.pos_order_id[0], p.payment_method_id[1]);
    }
  }
  return methodByOrderId;
}

async function fetchLinesByOrderId(lineIds) {
  const linesByOrderId = new Map();
  if (!lineIds.length) return linesByOrderId;

  const lines = await callKw('pos.order.line', 'read', [lineIds], {
    fields: ['order_id', 'product_id', 'qty', 'price_unit'],
  });
  for (const line of lines) {
    const orderId = line.order_id[0];
    if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
    linesByOrderId.get(orderId).push(line);
  }
  return linesByOrderId;
}

export async function syncLocales(categoryBySku, sinceOverride) {
  await authenticate();
  const results = {};

  for (const store of STORES) {
    const meta = await getSyncMetadata(store.channel);
    const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

    const domain = [['config_id', '=', store.configId], ['date_order', '>=', since]];
    const orders = await fetchAll('pos.order', domain, ['id', 'date_order', 'amount_total', 'state', 'lines']);

    const [paymentByOrderId, linesByOrderId] = await Promise.all([
      fetchPaymentMethodByOrderId(orders.map(o => o.id)),
      fetchLinesByOrderId(orders.flatMap(o => o.lines)),
    ]);

    const docs = orders.map(order => normalizeOdooPosOrder(
      order,
      linesByOrderId.get(order.id) || [],
      store.channel,
      categoryBySku,
      paymentByOrderId.get(order.id) || null,
    ));

    await saveSalesDocs(docs);
    await setSyncMetadata(store.channel, { lastSyncedAt: new Date().toISOString(), count: docs.length });
    results[store.channel] = docs.length;
    console.log(`[sync:locales] ${store.channel}: ${docs.length} órdenes`);
  }

  return results;
}
```

- [ ] **Step 2: Verify manually — including the two unverified field names**

Run: `node -e "import('./backend/sync/products.mjs').then(m => m.syncProducts()).then(({categoryBySku}) => import('./backend/sync/locales.mjs').then(l => l.syncLocales(categoryBySku, '2026-07-01 00:00:00')))"`

This exercises two field names that were not directly confirmed during design (`pos.order.line.order_id` and `pos.payment.pos_order_id`, both standard Odoo POS fields but unverified against this specific instance). Expected: non-zero counts printed for `local_lomas`, `local_belgrano`, `local_alcorta`. If either query throws a "field does not exist" error, inspect `callKw('pos.order.line', 'fields_get', [], { attributes: ['string','type'] })` and `callKw('pos.payment', 'fields_get', ...)` to find the correct field names and adjust `fetchPaymentMethodByOrderId`/`fetchLinesByOrderId` accordingly before proceeding.

Spot-check a synced document in `altorancho_reportes_sales` for `local_belgrano` — `paymentMethod` should be populated (e.g. "Mercado Pago" or similar), not always `null`.

- [ ] **Step 3: Commit**

```bash
git add backend/sync/locales.mjs
git commit -m "feat(backend): sync local store POS orders from Odoo into Firestore"
```

---

### Task 11: Mayorista sync

**Files:**
- Create: `backend/sync/mayorista.mjs`

**Interfaces:**
- Consumes: `authenticate`/`callKw`/`fetchAll` (Task 2), `normalizeOdooSaleOrder` (Task 6), `saveSalesDocs`/`getSyncMetadata`/`setSyncMetadata` (Task 7).
- Produces: `syncMayorista(categoryBySku)` → `Promise<{ count: number }>`. Consumed by Task 15 (cron) and Task 16 (backfill).

- [ ] **Step 1: Create `backend/sync/mayorista.mjs`**

```js
import { authenticate, callKw, fetchAll } from '../odoo.mjs';
import { normalizeOdooSaleOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const MAYORISTA_TEAM_ID = 8;

export async function syncMayorista(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('mayorista');
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  const domain = [['team_id', '=', MAYORISTA_TEAM_ID], ['date_order', '>=', since]];
  const orders = await fetchAll('sale.order', domain, ['id', 'date_order', 'amount_total', 'state', 'order_line']);

  const allLineIds = orders.flatMap(o => o.order_line);
  const lines = allLineIds.length
    ? await callKw('sale.order.line', 'read', [allLineIds], {
        fields: ['order_id', 'product_id', 'product_uom_qty', 'price_unit'],
      })
    : [];
  const linesByOrderId = new Map();
  for (const line of lines) {
    const orderId = line.order_id[0];
    if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
    linesByOrderId.get(orderId).push(line);
  }

  const docs = orders.map(order => normalizeOdooSaleOrder(
    order,
    linesByOrderId.get(order.id) || [],
    categoryBySku,
  ));

  await saveSalesDocs(docs);
  await setSyncMetadata('mayorista', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:mayorista] ${docs.length} órdenes sincronizadas`);
  return { count: docs.length };
}
```

Note: this assumes `sale.order.line` has an `order_id` field pointing back to `sale.order` (standard Odoo field, not directly verified against this instance). If the manual verification step below throws a "field does not exist" error, run `callKw('sale.order.line', 'fields_get', [], { attributes: ['string','type'] })` to find the correct back-reference field name and adjust.

- [ ] **Step 2: Verify manually**

Run: `node -e "import('./backend/sync/products.mjs').then(m => m.syncProducts()).then(({categoryBySku}) => import('./backend/sync/mayorista.mjs').then(w => w.syncMayorista(categoryBySku, '2026-06-01 00:00:00')))"`
Expected: a plausible order count (tens to low hundreds for a month, based on the 509-in-60-days figure seen during exploration). Spot-check a document in `altorancho_reportes_sales` for `mayorista` — `channel` should be `mayorista`, `paymentMethod` will be `null` (expected, per design).

- [ ] **Step 3: Commit**

```bash
git add backend/sync/mayorista.mjs
git commit -m "feat(backend): sync wholesale sale orders from Odoo into Firestore"
```

---

### Task 12: Aggregation functions

**Files:**
- Create: `backend/aggregate.mjs`
- Test: `backend/test/aggregate.test.mjs`

**Interfaces:**
- Produces: `computeTotals(salesDocs)`, `computeTopProducts(salesDocs, productsBySku, options)`, `computeCategoryBreakdown(salesDocs)`, `computePaymentMethods(salesDocs)`, `computeProvinces(salesDocs)`, `computeDelta(current, previous)`. Consumed by Task 14 (report endpoint).
- All functions only consider docs with `status === 'completed'` (cancelled/pending orders are excluded from revenue figures) — this filtering happens inside each function so callers don't need to pre-filter.

- [ ] **Step 1: Write the failing tests**

```js
// backend/test/aggregate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTotals,
  computeTopProducts,
  computeCategoryBreakdown,
  computePaymentMethods,
  computeProvinces,
  computeDelta,
} from '../aggregate.mjs';

function makeSale(overrides) {
  return {
    id: 'x', channel: 'ecommerce', sourceId: '1', date: '2026-07-01T00:00:00Z',
    status: 'completed', total: 1000, paymentMethod: 'Mercado Pago', shippingProvince: 'Capital Federal',
    items: [{ sku: 'A', name: 'Producto A', category: 'Sillas', qty: 1, unitPrice: 1000 }],
    ...overrides,
  };
}

test('computeTotals sums revenue, units and orders, ignoring non-completed', () => {
  const sales = [
    makeSale({ total: 1000, items: [{ sku: 'A', name: 'A', category: 'Sillas', qty: 2, unitPrice: 500 }] }),
    makeSale({ total: 2000, date: '2026-07-02T00:00:00Z', items: [{ sku: 'B', name: 'B', category: 'Mesas', qty: 1, unitPrice: 2000 }] }),
    makeSale({ status: 'cancelled', total: 9999 }),
  ];

  const totals = computeTotals(sales);

  assert.equal(totals.revenue, 3000);
  assert.equal(totals.units, 3);
  assert.equal(totals.orders, 2);
  assert.equal(totals.avgTicket, 1500);
  assert.equal(totals.daysInRange, 2); // 2026-07-01 and 2026-07-02
  assert.equal(totals.avgDailyRevenue, 1500);
});

test('computeTotals handles an empty period without dividing by zero', () => {
  const totals = computeTotals([]);
  assert.equal(totals.revenue, 0);
  assert.equal(totals.orders, 0);
  assert.equal(totals.avgTicket, 0);
  assert.equal(totals.avgDailyRevenue, 0);
});

test('computeTopProducts ranks by units sold', () => {
  const sales = [
    makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 5, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'B', name: 'Mesa', category: 'Mesas', qty: 2, unitPrice: 500 }] }),
  ];
  const productsBySku = new Map([
    ['A', { currentStock: 10 }],
    ['B', { currentStock: 0 }],
  ]);

  const top = computeTopProducts(sales, productsBySku, { by: 'units', limit: 2 });

  assert.equal(top[0].sku, 'A');
  assert.equal(top[0].unitsSold, 5);
  assert.equal(top[0].revenue, 500);
  assert.equal(top[0].currentStock, 10);
  assert.equal(top[1].sku, 'B');
});

test('computeTopProducts ranks by revenue', () => {
  const sales = [
    makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 5, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'B', name: 'Mesa', category: 'Mesas', qty: 2, unitPrice: 500 }] }),
  ];
  const top = computeTopProducts(sales, new Map(), { by: 'revenue', limit: 1 });
  assert.equal(top.length, 1);
  assert.equal(top[0].sku, 'B');
  assert.equal(top[0].revenue, 1000);
});

test('computeCategoryBreakdown groups units by category', () => {
  const sales = [
    makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 3, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'B', name: 'Silla 2', category: 'Sillas', qty: 2, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'C', name: 'Mesa', category: 'Mesas', qty: 1, unitPrice: 500 }] }),
  ];
  const breakdown = computeCategoryBreakdown(sales);
  assert.deepEqual(breakdown.find(c => c.category === 'Sillas'), { category: 'Sillas', units: 5, revenue: 500 });
  assert.deepEqual(breakdown.find(c => c.category === 'Mesas'), { category: 'Mesas', units: 1, revenue: 500 });
});

test('computeCategoryBreakdown groups missing category as "Sin categoría"', () => {
  const sales = [makeSale({ items: [{ sku: 'A', name: 'A', category: null, qty: 1, unitPrice: 100 }] })];
  const breakdown = computeCategoryBreakdown(sales);
  assert.equal(breakdown[0].category, 'Sin categoría');
});

test('computePaymentMethods groups revenue by payment method', () => {
  const sales = [
    makeSale({ paymentMethod: 'Mercado Pago', total: 1000 }),
    makeSale({ paymentMethod: 'Mercado Pago', total: 500 }),
    makeSale({ paymentMethod: 'Pago Nube', total: 300 }),
  ];
  const methods = computePaymentMethods(sales);
  assert.deepEqual(methods.find(m => m.method === 'Mercado Pago'), { method: 'Mercado Pago', revenue: 1500 });
  assert.deepEqual(methods.find(m => m.method === 'Pago Nube'), { method: 'Pago Nube', revenue: 300 });
});

test('computeProvinces groups orders by shipping province, ignoring nulls', () => {
  const sales = [
    makeSale({ shippingProvince: 'Capital Federal' }),
    makeSale({ shippingProvince: 'Capital Federal' }),
    makeSale({ shippingProvince: 'Córdoba' }),
    makeSale({ shippingProvince: null }),
  ];
  const provinces = computeProvinces(sales);
  assert.deepEqual(provinces.find(p => p.province === 'Capital Federal'), { province: 'Capital Federal', orders: 2 });
  assert.equal(provinces.find(p => p.province === 'Córdoba').orders, 1);
  assert.equal(provinces.length, 2);
});

test('computeDelta returns absolute and percent change', () => {
  assert.deepEqual(computeDelta(150, 100), { value: 50, pct: 50 });
});

test('computeDelta handles a zero baseline without dividing by zero', () => {
  assert.deepEqual(computeDelta(150, 0), { value: 150, pct: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/aggregate.test.mjs`
Expected: FAIL with "Cannot find module '../aggregate.mjs'"

- [ ] **Step 3: Create `backend/aggregate.mjs`**

```js
function completedOnly(salesDocs) {
  return salesDocs.filter(s => s.status === 'completed');
}

export function computeTotals(salesDocs) {
  const completed = completedOnly(salesDocs);

  const revenue = completed.reduce((sum, s) => sum + s.total, 0);
  const units = completed.reduce((sum, s) => sum + s.items.reduce((u, i) => u + i.qty, 0), 0);
  const orders = completed.length;
  const avgTicket = orders ? revenue / orders : 0;

  const uniqueDays = new Set(completed.map(s => s.date.slice(0, 10)));
  const daysInRange = uniqueDays.size;
  const avgDailyRevenue = daysInRange ? revenue / daysInRange : 0;

  return { revenue, units, orders, avgTicket, daysInRange, avgDailyRevenue };
}

export function computeTopProducts(salesDocs, productsBySku, { by = 'units', limit = 10 } = {}) {
  const completed = completedOnly(salesDocs);
  const bySku = new Map();

  for (const sale of completed) {
    for (const item of sale.items) {
      if (!bySku.has(item.sku)) {
        bySku.set(item.sku, { sku: item.sku, name: item.name, unitsSold: 0, revenue: 0 });
      }
      const entry = bySku.get(item.sku);
      entry.unitsSold += item.qty;
      entry.revenue += item.qty * item.unitPrice;
    }
  }

  const ranked = [...bySku.values()]
    .map(entry => ({ ...entry, currentStock: productsBySku.get(entry.sku)?.currentStock ?? null }))
    .sort((a, b) => (by === 'revenue' ? b.revenue - a.revenue : b.unitsSold - a.unitsSold));

  return ranked.slice(0, limit);
}

export function computeCategoryBreakdown(salesDocs) {
  const completed = completedOnly(salesDocs);
  const byCategory = new Map();

  for (const sale of completed) {
    for (const item of sale.items) {
      const category = item.category || 'Sin categoría';
      if (!byCategory.has(category)) byCategory.set(category, { category, units: 0, revenue: 0 });
      const entry = byCategory.get(category);
      entry.units += item.qty;
      entry.revenue += item.qty * item.unitPrice;
    }
  }

  return [...byCategory.values()].sort((a, b) => b.revenue - a.revenue);
}

export function computePaymentMethods(salesDocs) {
  const completed = completedOnly(salesDocs);
  const byMethod = new Map();

  for (const sale of completed) {
    if (!sale.paymentMethod) continue;
    if (!byMethod.has(sale.paymentMethod)) byMethod.set(sale.paymentMethod, { method: sale.paymentMethod, revenue: 0 });
    byMethod.get(sale.paymentMethod).revenue += sale.total;
  }

  return [...byMethod.values()].sort((a, b) => b.revenue - a.revenue);
}

export function computeProvinces(salesDocs) {
  const completed = completedOnly(salesDocs);
  const byProvince = new Map();

  for (const sale of completed) {
    if (!sale.shippingProvince) continue;
    if (!byProvince.has(sale.shippingProvince)) byProvince.set(sale.shippingProvince, { province: sale.shippingProvince, orders: 0 });
    byProvince.get(sale.shippingProvince).orders += 1;
  }

  return [...byProvince.values()].sort((a, b) => b.orders - a.orders);
}

export function computeDelta(current, previous) {
  const value = current - previous;
  const pct = previous === 0 ? null : Math.round((value / previous) * 10000) / 100;
  return { value, pct };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/aggregate.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/aggregate.mjs backend/test/aggregate.test.mjs
git commit -m "feat(backend): add report aggregation functions"
```

---

### Task 13: Auth module

**Files:**
- Create: `backend/auth.mjs`
- Test: `backend/test/auth.test.mjs`

**Interfaces:**
- Produces: `generateToken()`, `verifyToken(token)` (returns `boolean`), `requireAuth` (Express middleware). Consumed by Task 14 (protects `/api/report`) and the login route.

- [ ] **Step 1: Write the failing tests**

```js
// backend/test/auth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-for-unit-tests';
const { generateToken, verifyToken } = await import('../auth.mjs');

test('a freshly generated token verifies as valid', () => {
  const token = generateToken();
  assert.equal(verifyToken(token), true);
});

test('a tampered token fails verification', () => {
  const token = generateToken();
  const tampered = token.slice(0, -2) + 'xx';
  assert.equal(verifyToken(tampered), false);
});

test('an expired token fails verification', () => {
  const token = generateToken(-1); // expiresInSeconds negative => already expired
  assert.equal(verifyToken(token), false);
});

test('garbage input fails verification without throwing', () => {
  assert.equal(verifyToken('not-a-real-token'), false);
  assert.equal(verifyToken(''), false);
  assert.equal(verifyToken(undefined), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test test/auth.test.mjs`
Expected: FAIL with "Cannot find module '../auth.mjs'"

- [ ] **Step 3: Create `backend/auth.mjs`**

```js
import 'dotenv/config';
import crypto from 'node:crypto';

const SECRET = process.env.AUTH_SECRET;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días, dashboard de un solo usuario

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function generateToken(expiresInSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Date.now() + expiresInSeconds * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;

  const [payload, signature] = token.split('.');
  if (sign(payload) !== signature) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!verifyToken(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/auth.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auth.mjs backend/test/auth.test.mjs
git commit -m "feat(backend): add password-based auth with signed tokens"
```

---

### Task 14: Report endpoint

**Files:**
- Modify: `backend/index.mjs`

**Interfaces:**
- Consumes: `getPeriodRanges` (Task 4), `querySalesByRange`/`getProductsBySku` (Task 7), `computeTotals`/`computeTopProducts`/`computeCategoryBreakdown`/`computePaymentMethods`/`computeProvinces`/`computeDelta` (Task 12), `requireAuth`/`verifyToken`/`generateToken` (Task 13).
- Produces: `POST /api/auth/login`, `GET /api/report`. This is the contract the frontend (future plan) will call.

- [ ] **Step 1: Add auth and report routes to `backend/index.mjs`**

```js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { requireAuth, generateToken } from './auth.mjs';
import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, getProductsBySku } from './firestore.mjs';
import {
  computeTotals, computeTopProducts, computeCategoryBreakdown,
  computePaymentMethods, computeProvinces, computeDelta,
} from './aggregate.mjs';

export const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  }
  res.json({ ok: true, token: generateToken() });
});

const ALL_CHANNELS = ['ecommerce', 'local_lomas', 'local_belgrano', 'local_alcorta', 'mayorista'];

async function buildTotalsSection(channels, range, productsBySku) {
  const sales = await querySalesByRange(channels, range.start, range.end);
  return {
    totals: computeTotals(sales),
    topProductsByUnits: computeTopProducts(sales, productsBySku, { by: 'units', limit: 10 }),
    topProductsByRevenue: computeTopProducts(sales, productsBySku, { by: 'revenue', limit: 10 }),
    categories: computeCategoryBreakdown(sales),
    paymentMethods: computePaymentMethods(sales),
    provinces: computeProvinces(sales),
  };
}

app.get('/api/report', requireAuth, async (req, res) => {
  try {
    const { period = 'week', date, channels } = req.query;
    if (!date) return res.status(400).json({ ok: false, error: 'Missing date' });

    const requestedChannels = channels ? channels.split(',') : ALL_CHANNELS;
    const ranges = getPeriodRanges(date, period);
    const productsBySku = await getProductsBySku();

    const [current, prevPeriod, prevMonth, prevYear] = await Promise.all([
      buildTotalsSection(requestedChannels, ranges.current, productsBySku),
      buildTotalsSection(requestedChannels, ranges.prevPeriod, productsBySku),
      buildTotalsSection(requestedChannels, ranges.prevMonth, productsBySku),
      buildTotalsSection(requestedChannels, ranges.prevYear, productsBySku),
    ]);

    res.json({
      ok: true,
      range: ranges.current,
      current,
      comparisons: {
        prevPeriod: { range: ranges.prevPeriod, totals: prevPeriod.totals, deltas: diffTotals(current.totals, prevPeriod.totals) },
        prevMonth:  { range: ranges.prevMonth,  totals: prevMonth.totals,  deltas: diffTotals(current.totals, prevMonth.totals) },
        prevYear:   { range: ranges.prevYear,   totals: prevYear.totals,   deltas: diffTotals(current.totals, prevYear.totals) },
      },
    });
  } catch (err) {
    console.error('[server] report error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function diffTotals(current, previous) {
  return {
    revenue: computeDelta(current.revenue, previous.revenue),
    units: computeDelta(current.units, previous.units),
    orders: computeDelta(current.orders, previous.orders),
    avgTicket: computeDelta(current.avgTicket, previous.avgTicket),
    avgDailyRevenue: computeDelta(current.avgDailyRevenue, previous.avgDailyRevenue),
  };
}

const PORT = process.env.PORT || 3000;

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
}
```

- [ ] **Step 2: Verify manually end-to-end**

Run: `npm run dev` (with real sales data already synced from Tasks 9-11 for at least the current and previous week)

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"whatever-is-in-DASHBOARD_PASSWORD"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s "http://localhost:3000/api/report?period=week&date=2026-07-06" \
  -H "Authorization: Bearer $TOKEN" | head -c 2000
```

Expected: a JSON body with `current.totals.revenue` matching the rough order of magnitude of real sales for that week, and `comparisons.prevPeriod/prevMonth/prevYear` all present. If Firestore complains about a missing composite index (channel `in` + `date` range), open the link in the error message to create it, then retry.

- [ ] **Step 3: Commit**

```bash
git add backend/index.mjs
git commit -m "feat(backend): add authenticated report endpoint with period comparisons"
```

---

### Task 15: Cron wiring

**Files:**
- Modify: `backend/index.mjs`

**Interfaces:**
- Consumes: `syncProducts` (Task 8), `syncEcommerce` (Task 9), `syncLocales` (Task 10), `syncMayorista` (Task 11).

- [ ] **Step 1: Add the cron job to `backend/index.mjs`**

Add these imports near the top:

```js
import cron from 'node-cron';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';
```

Add before the `app.listen` call:

```js
const SYNC_HOURS = parseInt(process.env.SYNC_INTERVAL_HOURS || '4', 10);
let syncRunning = false;

async function runFullSync() {
  if (syncRunning) { console.log('[cron] sync already running, skipping'); return; }
  syncRunning = true;
  try {
    const { categoryBySku } = await syncProducts();
    await syncEcommerce(categoryBySku);
    await syncLocales(categoryBySku);
    await syncMayorista(categoryBySku);
    console.log('[cron] full sync complete');
  } catch (err) {
    console.error('[cron] sync error:', err.message);
  } finally {
    syncRunning = false;
  }
}

cron.schedule(`0 */${SYNC_HOURS} * * *`, runFullSync);
console.log(`[server] cron scheduled every ${SYNC_HOURS}h`);
```

- [ ] **Step 2: Verify manually**

Run: `node -e "import('./backend/index.mjs')"` and confirm the log line `[server] cron scheduled every 4h` appears without errors. Manually trigger one run to confirm the whole chain works together: `node -e "import('./backend/index.mjs').then(async () => { const {syncProducts} = await import('./backend/sync/products.mjs'); })"` — or more simply, temporarily change the cron expression to `* * * * *` (every minute), start the server, watch one full cycle complete in the logs, then revert to the `SYNC_INTERVAL_HOURS`-based schedule.

- [ ] **Step 3: Commit**

```bash
git add backend/index.mjs
git commit -m "feat(backend): wire up scheduled cron for all sync jobs"
```

---

### Task 16: Backfill script

**Files:**
- Create: `backend/backfill.mjs`

**Interfaces:**
- Consumes: `syncProducts`, `syncEcommerce`, `syncLocales`, `syncMayorista` (Tasks 8-11), each accepting a `sinceOverride` parameter to force a historical start date.

- [ ] **Step 1: Create `backend/backfill.mjs`**

```js
import 'dotenv/config';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';

function monthsAgoISO(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

function monthsAgoOdoo(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function backfill() {
  const months = parseInt(process.argv.find(a => a.startsWith('--months='))?.split('=')[1] || '14', 10);
  console.log(`[backfill] starting, ${months} months of history`);

  const { categoryBySku } = await syncProducts();

  const ecommerceResult = await syncEcommerce(categoryBySku, monthsAgoISO(months));
  console.log('[backfill] ecommerce:', ecommerceResult);

  const localesResult = await syncLocales(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] locales:', localesResult);

  const mayoristaResult = await syncMayorista(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] mayorista:', mayoristaResult);

  console.log('[backfill] done');
}

backfill().catch(err => { console.error('[backfill] fatal error:', err); process.exit(1); });
```

- [ ] **Step 2: Verify manually (this is the real 14-month historical load — run once)**

Run: `npm run backfill -- --months=14`
Expected: this will take a while (many paginated requests against both APIs). Watch the logs for each channel's final count; spot-check the earliest synced order's date in the Firebase console to confirm it's roughly 14 months back. If Tiendanube returns a 429 repeatedly, the connector's retry-after handling (Task 3) should absorb it automatically — just let it run.

- [ ] **Step 3: Commit**

```bash
git add backend/backfill.mjs
git commit -m "feat(backend): add standalone historical backfill script"
```

---

### Task 17: Railway deployment config

**Files:**
- Create: `backend/Procfile`
- Create: `backend/README.md`

**Interfaces:** none (deployment config only).

- [ ] **Step 1: Create `backend/Procfile`**

```
web: node index.mjs
```

- [ ] **Step 2: Create `backend/README.md`**

```markdown
# Altorancho Reportes — Backend

Sincroniza ventas de Odoo (locales + mayorista) y Tienda Nube (ecommerce) a
Firestore, y expone `/api/report` para el dashboard.

## Variables de entorno (configurar en Railway)

Ver `.env.example` para la lista completa: credenciales de Odoo, Tienda Nube,
Firebase, `DASHBOARD_PASSWORD`, `AUTH_SECRET`, `SYNC_INTERVAL_HOURS`,
`ALLOWED_ORIGIN` (poner el dominio del frontend en Hostinger/GoDaddy una vez
desplegado, en vez de `*`).

## Backfill inicial

Una sola vez, después del primer deploy, correr localmente (no como parte del
deploy de Railway):

    npm run backfill -- --months=14

## Desarrollo local

    npm install
    npm run dev
    npm test
```

- [ ] **Step 3: Commit**

```bash
git add backend/Procfile backend/README.md
git commit -m "docs(backend): add Railway deployment config and README"
```

---

## Not covered by this plan

- The React frontend that calls `/api/auth/login` and `/api/report` — a separate plan, written once this backend is deployed and its exact response shape is confirmed against real data.
- The Tienda Nube conversion funnel (carts created, checkout clicks) — confirmed during Task 3 exploration that the Orders/Products API does not expose it; out of scope for v1.
