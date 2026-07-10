# Frontend Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React dashboard that logs into the backend API and shows the weekly/monthly sales report — KPIs with three period comparisons, a daily revenue chart, top products, category/payment/province breakdowns, and per-local/mayorista comparison panels — styled with Altorancho's brand identity.

**Architecture:** A Vite + React SPA with two pages (`Login`, `Dashboard`). No routing library (only two states: authenticated or not) and no state-management library (React hooks are enough for a single-user, low-frequency-use app). All data comes from the backend's single `GET /api/report` endpoint; `LocalesPanel`/`MayoristaPanel` make their own additional calls to that same endpoint filtered by channel, since the endpoint aggregates whatever channels it's given into one combined total rather than returning a per-channel breakdown.

**Tech Stack:** React 18, Vite, plain CSS (custom properties as design tokens, no CSS framework), Recharts for charts, Vitest for pure-logic unit tests (mirrors the backend's "pure logic gets tests, everything else gets manual/browser verification" convention).

## Global Constraints

- Project lives at `Reportes/frontend/`, sibling to `Reportes/backend/`.
- Backend must be running locally (`cd backend && npm run dev`, or `PORT=3055 node index.mjs` if port 3000 is taken by something else on the dev machine) for every manual verification step in this plan — confirm `curl http://localhost:<port>/health` returns `{"ok":true}` before starting a task's verification.
- Confirmed real `/api/report` response shape (verified against live data on 2026-07-08/10 — see `docs/superpowers/specs/2026-07-08-dashboard-reportes-design.md` § Frontend):
  ```js
  {
    ok: true,
    range: { start, end },
    current: {
      totals: { revenue, units, orders, avgTicket, daysInRange, avgDailyRevenue },
      dailyBreakdown: [{ date: 'YYYY-MM-DD', revenue, units, orders }],
      topProductsByUnits: [{ sku, name, unitsSold, revenue, currentStock }],
      topProductsByRevenue: [{ sku, name, unitsSold, revenue, currentStock }],
      categories: [{ category, units, revenue }],
      paymentMethods: [{ method, revenue }],
      provinces: [{ province, orders }],
    },
    comparisons: {
      prevPeriod: { range, totals, deltas: { revenue: {value,pct}, units, orders, avgTicket, avgDailyRevenue } },
      prevMonth:  { range, totals, deltas },
      prevYear:   { range, totals, deltas },
    },
  }
  ```
  `deltas.*.pct` is `null` when the comparison period had 0 — every place that renders a delta must handle that (render `—`, never crash on `null.toFixed`).
- Channels: `ecommerce`, `local_lomas`, `local_belgrano`, `local_alcorta`, `mayorista`. Omitting the `channels` query param on `/api/report` means "all five, combined" (= the "Consolidado" tab).
- Design tokens (all colors validated for contrast/colorblind-safety with the `dataviz` skill — do not change hex values without re-running `node scripts/validate_palette.js` from that skill):

  | Token | Hex |
  |---|---|
  | `--surface-page` | `#FFFFFF` |
  | `--surface-card` | `#F0E6D8` |
  | `--ink-primary` | `#353434` |
  | `--ink-secondary` | `#6B6968` |
  | `--delta-positive` | `#0CA30C` |
  | `--delta-negative` | `#D03B3B` |
  | `--channel-mayorista` | `#2A78D6` |
  | `--channel-ecommerce` | `#1BAF7A` |
  | `--channel-lomas` | `#008300` |
  | `--channel-belgrano` | `#4A3AA7` |
  | `--channel-alcorta` | `#EB6834` |

  Typography: Poppins everywhere (weights 600/700 for titles and big numbers, 400/500 for the rest).
- `--channel-ecommerce` and `--channel-alcorta` fall below 3:1 contrast on the beige card surface — every place a channel color is used as an identifying mark (tabs, panel accents, chart bars/legend) must also show the channel's text label, never rely on the color alone.
- No automated tests for React components — verified by actually running the dev server and looking at it in a browser (per this session's UI-verification convention), using the `claude-in-chrome` tools. Only pure `.js` logic modules (`lib/format.js`, `lib/periods.js`, `lib/channels.js`) get Vitest unit tests.

---

### Task 1: Project scaffolding, design tokens, and global styles

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.js`
- Create: `frontend/index.html`
- Create: `frontend/.env.example`
- Create: `frontend/src/main.jsx`
- Create: `frontend/src/App.jsx`
- Create: `frontend/src/styles/tokens.css`
- Create: `frontend/src/styles/global.css`

**Interfaces:**
- Produces: the CSS class vocabulary every later component uses (`.kpi-card`, `.chart-card`, `.table-card`, `.list-card`, `.panel-card`, `.delta-badge`/`.delta-positive`/`.delta-negative`/`.delta-neutral`, `.channel-tab`/`.channel-tab.active`, `.period-toggle`, `.data-table`, `.bar-list*`, `.panel-grid`/`.panel-item*`, `.login-page`/`.login-card`, `.dashboard-header`/`.dashboard-body`/`.dashboard-grid`, `.status-text`/`.status-error`) — don't rename these, later tasks reference them by name.

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "altorancho-reportes-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.12.7"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.0",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create `frontend/vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 3: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Altorancho — Reportes</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `frontend/.env.example`**

```
VITE_API_URL=http://localhost:3055
```

- [ ] **Step 5: Create `frontend/src/styles/tokens.css`**

```css
:root {
  --surface-page: #FFFFFF;
  --surface-card: #F0E6D8;
  --ink-primary: #353434;
  --ink-secondary: #6B6968;
  --delta-positive: #0CA30C;
  --delta-negative: #D03B3B;
  --channel-mayorista: #2A78D6;
  --channel-ecommerce: #1BAF7A;
  --channel-lomas: #008300;
  --channel-belgrano: #4A3AA7;
  --channel-alcorta: #EB6834;
  --border-subtle: rgba(53, 52, 52, 0.12);
  --font-family: 'Poppins', sans-serif;
  --radius: 12px;
}
```

- [ ] **Step 6: Create `frontend/src/styles/global.css`**

```css
* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-family);
  background: var(--surface-page);
  color: var(--ink-primary);
}

button {
  font-family: inherit;
  cursor: pointer;
}

.dashboard-header {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-wrap: wrap;
}
.logo { font-weight: 700; font-size: 20px; }

.dashboard-body {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
}

.kpi-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.kpi-card, .chart-card, .table-card, .list-card, .panel-card {
  background: var(--surface-card);
  border-radius: var(--radius);
  padding: 16px 20px;
  border: 1px solid var(--border-subtle);
}

.kpi-label { font-size: 13px; color: var(--ink-secondary); margin-bottom: 4px; }
.kpi-value { font-size: 26px; font-weight: 700; margin-bottom: 10px; }
.kpi-deltas { display: flex; flex-direction: column; gap: 4px; }
.kpi-delta-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.kpi-delta-label { color: var(--ink-secondary); }

.delta-badge { font-weight: 600; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.delta-positive { color: var(--delta-positive); background: rgba(12, 163, 12, 0.12); }
.delta-negative { color: var(--delta-negative); background: rgba(208, 59, 59, 0.12); }
.delta-neutral { color: var(--ink-secondary); background: rgba(107, 105, 104, 0.12); }

.period-selector { display: flex; align-items: center; gap: 16px; }
.period-toggle button, .table-toggle button {
  border: 1px solid var(--border-subtle);
  background: none;
  color: var(--ink-primary);
  padding: 6px 14px;
  font-size: 13px;
}
.period-toggle button:first-child, .table-toggle button:first-child { border-radius: 999px 0 0 999px; }
.period-toggle button:last-child, .table-toggle button:last-child { border-radius: 0 999px 999px 0; }
.period-toggle button.active, .table-toggle button.active { background: var(--ink-primary); color: var(--surface-page); }
.period-nav { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.period-nav button { border: none; background: none; font-size: 18px; color: var(--ink-primary); }

.channel-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.channel-tab {
  border: none;
  background: none;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--ink-secondary);
  border-bottom: 3px solid transparent;
}
.channel-tab.active {
  color: var(--ink-primary);
  font-weight: 600;
  border-bottom-color: var(--tab-color, var(--ink-primary));
}

.chart-title { margin: 0 0 12px; font-size: 15px; font-weight: 600; }

.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th {
  text-align: left;
  color: var(--ink-secondary);
  font-weight: 500;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
}
.data-table td { padding: 8px; border-bottom: 1px solid var(--border-subtle); }
.table-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }

.bar-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.bar-list-row { display: grid; grid-template-columns: 110px 1fr auto; align-items: center; gap: 10px; font-size: 13px; }
.bar-list-track { background: rgba(53, 52, 52, 0.08); border-radius: 999px; height: 8px; overflow: hidden; }
.bar-list-fill { background: var(--ink-primary); height: 100%; border-radius: 999px; }

.panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.panel-item { border-left: 4px solid var(--tab-color, var(--ink-primary)); padding-left: 10px; }
.panel-item-label { font-size: 12px; color: var(--ink-secondary); }
.panel-item-value { font-size: 18px; font-weight: 700; }
.panel-item-sub { font-size: 12px; color: var(--ink-secondary); }

.login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--surface-card); }
.login-card {
  background: var(--surface-page);
  padding: 40px;
  border-radius: var(--radius);
  width: 320px;
  text-align: center;
  box-shadow: 0 4px 24px rgba(53, 52, 52, 0.08);
}
.login-logo { font-weight: 700; font-size: 24px; margin-bottom: 24px; }
.login-card input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  font-size: 14px;
  margin-bottom: 12px;
  font-family: inherit;
}
.login-card button {
  width: 100%;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: var(--ink-primary);
  color: var(--surface-page);
  font-size: 14px;
  font-weight: 600;
}
.login-error { color: var(--delta-negative); font-size: 13px; margin-top: 10px; }

.status-text { padding: 24px; color: var(--ink-secondary); }
.status-error { color: var(--delta-negative); }
```

- [ ] **Step 7: Create `frontend/src/main.jsx`**

```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/tokens.css';
import './styles/global.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 8: Create `frontend/src/App.jsx`** (placeholder — Login/Dashboard wiring happens in Task 5 and Task 12)

```jsx
export default function App() {
  return <div style={{ padding: 24 }}>Altorancho Reportes — scaffolding OK</div>;
}
```

- [ ] **Step 9: Install dependencies and verify in a browser**

Run: `cd frontend && npm install`
Run: `npm run dev` (leave running, note the printed local URL, typically `http://localhost:5173`)

Use the `claude-in-chrome` tools to verify (load them first if deferred: `ToolSearch` with query `"select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_create_mcp"`):
1. `tabs_context_mcp` to get a tab.
2. `navigate` to the dev server URL.
3. `computer` with `action: screenshot`.

Expected: a page with white background, Poppins-looking sans-serif text reading "Altorancho Reportes — scaffolding OK", no console errors (check with `read_console_messages` if available/loaded).

- [ ] **Step 10: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.js frontend/index.html frontend/.env.example frontend/src/main.jsx frontend/src/App.jsx frontend/src/styles/
git commit -m "feat(frontend): scaffold Vite/React project with design tokens and global styles"
```

---

### Task 2: `lib/format.js` — number/currency formatting

**Files:**
- Create: `frontend/src/lib/format.js`
- Test: `frontend/src/lib/format.test.js`

**Interfaces:**
- Produces: `formatCurrency(amount)`, `formatNumber(n)`, `formatPercent(pct)`. Consumed by nearly every later component.

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/lib/format.test.js
import { describe, test, expect } from 'vitest';
import { formatCurrency, formatNumber, formatPercent } from './format.js';

test('formatCurrency formats ARS with no decimals and thousands separators', () => {
  expect(formatCurrency(105653226.14)).toBe('$ 105.653.226');
});

test('formatCurrency handles zero', () => {
  expect(formatCurrency(0)).toBe('$ 0');
});

test('formatNumber formats with a thousands separator', () => {
  expect(formatNumber(1872)).toBe('1.872');
});

test('formatNumber formats small numbers without a separator', () => {
  expect(formatNumber(42)).toBe('42');
});

test('formatPercent adds a plus sign for positive values, one decimal place', () => {
  expect(formatPercent(51.8)).toBe('+51.8%');
});

test('formatPercent keeps the minus sign for negative values, one decimal place', () => {
  expect(formatPercent(-51.78)).toBe('-51.8%');
});

test('formatPercent returns an em dash for null (no comparison baseline)', () => {
  expect(formatPercent(null)).toBe('—');
});

test('formatPercent returns an em dash for undefined', () => {
  expect(formatPercent(undefined)).toBe('—');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- format.test.js`
Expected: FAIL — "Cannot find module './format.js'" (or similar)

- [ ] **Step 3: Create `frontend/src/lib/format.js`**

```js
const currencyFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('es-AR');

export function formatCurrency(amount) {
  return currencyFormatter.format(amount);
}

export function formatNumber(n) {
  return numberFormatter.format(n);
}

export function formatPercent(pct) {
  if (pct === null || pct === undefined) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- format.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/format.js frontend/src/lib/format.test.js
git commit -m "feat(frontend): add currency/number/percent formatting helpers"
```

---

### Task 3: `lib/periods.js` — period navigation and display labels

**Files:**
- Create: `frontend/src/lib/periods.js`
- Test: `frontend/src/lib/periods.test.js`

**Interfaces:**
- Produces: `shiftPeriod(dateStr, period, direction)` → new `YYYY-MM-DD` anchor date; `formatPeriodLabel(dateStr, period)` → human-readable range string. Consumed by `PeriodSelector` (Task 6) and `Dashboard` (Task 12).
- Note: `shiftPeriod` for `period === 'month'` deliberately normalizes to the 1st of the target month rather than preserving the day-of-month — the backend hit a real date-overflow bug doing naive `setUTCMonth` arithmetic (see `docs/superpowers/plans/2026-07-08-backend-pipeline-plan.md` Task 4's fix); since day-of-month is irrelevant for a month-period anchor (the backend's `getPeriodRanges` only cares which month the date falls in), normalizing to day 1 sidesteps the whole overflow class rather than clamping it.

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/lib/periods.test.js
import { test, expect } from 'vitest';
import { shiftPeriod, formatPeriodLabel } from './periods.js';

test('shiftPeriod week moves the anchor forward 7 days', () => {
  expect(shiftPeriod('2026-07-06', 'week', 1)).toBe('2026-07-13');
});

test('shiftPeriod week moves the anchor backward 7 days', () => {
  expect(shiftPeriod('2026-07-06', 'week', -1)).toBe('2026-06-29');
});

test('shiftPeriod month normalizes to the 1st of the next month regardless of anchor day', () => {
  expect(shiftPeriod('2026-01-31', 'month', 1)).toBe('2026-02-01');
});

test('shiftPeriod month normalizes to the 1st of the previous month across a year boundary', () => {
  expect(shiftPeriod('2026-01-15', 'month', -1)).toBe('2025-12-01');
});

test('formatPeriodLabel week formats a Monday-Sunday range within the same month', () => {
  // 2026-07-06 is a Monday (verified); week is Jul 6-12.
  expect(formatPeriodLabel('2026-07-08', 'week')).toBe('6 – 12 jul 2026');
});

test('formatPeriodLabel week formats a range spanning two months', () => {
  // 2026-06-29 is a Monday (verified); week is Jun 29 - Jul 5.
  expect(formatPeriodLabel('2026-06-30', 'week')).toBe('29 jun – 5 jul 2026');
});

test('formatPeriodLabel month formats the full month name and year', () => {
  expect(formatPeriodLabel('2026-07-08', 'month')).toBe('Julio 2026');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- periods.test.js`
Expected: FAIL — "Cannot find module './periods.js'"

- [ ] **Step 3: Create `frontend/src/lib/periods.js`**

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

export function shiftPeriod(dateStr, period, direction) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (period === 'week') {
    date.setUTCDate(date.getUTCDate() + 7 * direction);
    return toISODate(date);
  }
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, 1));
  return toISODate(target);
}

const WEEKDAY_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const FULL_MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export function formatPeriodLabel(dateStr, period) {
  const date = new Date(`${dateStr}T00:00:00Z`);

  if (period === 'month') {
    return `${FULL_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }

  const start = mondayOf(date);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startLabel = sameMonth
    ? `${start.getUTCDate()}`
    : `${start.getUTCDate()} ${WEEKDAY_MONTHS[start.getUTCMonth()]}`;

  return `${startLabel} – ${end.getUTCDate()} ${WEEKDAY_MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- periods.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/periods.js frontend/src/lib/periods.test.js
git commit -m "feat(frontend): add period navigation and label formatting"
```

---

### Task 4: `lib/channels.js` — channel metadata

**Files:**
- Create: `frontend/src/lib/channels.js`
- Test: `frontend/src/lib/channels.test.js`

**Interfaces:**
- Produces: `CHANNELS` (array of `{id, label, color}`), `getChannelColor(channelId)`, `getChannelLabel(channelId)`. Consumed by `ChannelTabs`, `DailyChart`, `LocalesPanel`, `MayoristaPanel` (Tasks 6, 8, 11).

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/lib/channels.test.js
import { test, expect } from 'vitest';
import { CHANNELS, getChannelColor, getChannelLabel } from './channels.js';

test('CHANNELS lists all five channels with hex colors matching the design tokens', () => {
  expect(CHANNELS).toEqual([
    { id: 'ecommerce', label: 'Ecommerce', color: '#1BAF7A' },
    { id: 'local_lomas', label: 'Lomas', color: '#008300' },
    { id: 'local_belgrano', label: 'Belgrano', color: '#4A3AA7' },
    { id: 'local_alcorta', label: 'Alcorta', color: '#EB6834' },
    { id: 'mayorista', label: 'Mayorista', color: '#2A78D6' },
  ]);
});

test('getChannelColor returns the mapped color for a known channel', () => {
  expect(getChannelColor('mayorista')).toBe('#2A78D6');
});

test('getChannelColor returns the neutral ink color for null (consolidado)', () => {
  expect(getChannelColor(null)).toBe('#353434');
});

test('getChannelLabel returns "Consolidado" for null', () => {
  expect(getChannelLabel(null)).toBe('Consolidado');
});

test('getChannelLabel returns the mapped label for a known channel', () => {
  expect(getChannelLabel('local_belgrano')).toBe('Belgrano');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- channels.test.js`
Expected: FAIL — "Cannot find module './channels.js'"

- [ ] **Step 3: Create `frontend/src/lib/channels.js`**

```js
export const CHANNELS = [
  { id: 'ecommerce', label: 'Ecommerce', color: '#1BAF7A' },
  { id: 'local_lomas', label: 'Lomas', color: '#008300' },
  { id: 'local_belgrano', label: 'Belgrano', color: '#4A3AA7' },
  { id: 'local_alcorta', label: 'Alcorta', color: '#EB6834' },
  { id: 'mayorista', label: 'Mayorista', color: '#2A78D6' },
];

const CONSOLIDADO_COLOR = '#353434';

export function getChannelColor(channelId) {
  if (!channelId) return CONSOLIDADO_COLOR;
  const channel = CHANNELS.find(c => c.id === channelId);
  return channel ? channel.color : CONSOLIDADO_COLOR;
}

export function getChannelLabel(channelId) {
  if (!channelId) return 'Consolidado';
  const channel = CHANNELS.find(c => c.id === channelId);
  return channel ? channel.label : channelId;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- channels.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/channels.js frontend/src/lib/channels.test.js
git commit -m "feat(frontend): add channel metadata (labels, brand colors)"
```

---

### Task 5: API client, auth hook, and Login page

**Files:**
- Create: `frontend/src/api/client.js`
- Create: `frontend/src/auth/useAuth.js`
- Create: `frontend/src/pages/Login.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Produces: `login(password)`, `getReport({period, date, channel})`, `getToken()`, `setToken(token)`, `clearToken()` (`api/client.js`); `useAuth()` hook returning `{isAuthenticated, login, logout}` (`auth/useAuth.js`). Consumed by every later page/component that needs report data or auth state.
- These three files are only really verifiable together (a client with no UI to trigger it can't be meaningfully exercised) — verified as one real browser login flow, not separately.

- [ ] **Step 1: Create `frontend/src/api/client.js`**

```js
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3055';
const TOKEN_KEY = 'altorancho_reportes_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(password) {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Login failed');
  setToken(data.token);
  return data.token;
}

export async function getReport({ period, date, channel }) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');

  const params = new URLSearchParams({ period, date });
  if (channel) params.set('channels', channel);

  const res = await fetch(`${API_URL}/api/report?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    clearToken();
    throw new Error('Unauthorized');
  }

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Report fetch failed');
  return data;
}
```

- [ ] **Step 2: Create `frontend/src/auth/useAuth.js`**

```jsx
import { useState, useCallback } from 'react';
import { login as apiLogin, getToken, clearToken } from '../api/client.js';

export function useAuth() {
  const [token, setTokenState] = useState(() => getToken());

  const login = useCallback(async (password) => {
    const newToken = await apiLogin(password);
    setTokenState(newToken);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  return { isAuthenticated: !!token, login, logout };
}
```

- [ ] **Step 3: Create `frontend/src/pages/Login.jsx`**

```jsx
import { useState } from 'react';

export default function Login({ onLogin, error }) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    await onLogin(password);
    setSubmitting(false);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">altorancho.</div>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Contraseña"
            autoFocus
          />
          <button type="submit" disabled={submitting}>
            {submitting ? 'Ingresando...' : 'Ingresar'}
          </button>
          {error && <p className="login-error">{error}</p>}
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Modify `frontend/src/App.jsx`**

```jsx
import { useState } from 'react';
import { useAuth } from './auth/useAuth.js';
import Login from './pages/Login.jsx';

export default function App() {
  const { isAuthenticated, login, logout } = useAuth();
  const [loginError, setLoginError] = useState(null);

  if (!isAuthenticated) {
    return (
      <Login
        error={loginError}
        onLogin={async (password) => {
          try {
            setLoginError(null);
            await login(password);
          } catch (err) {
            setLoginError(err.message);
          }
        }}
      />
    );
  }

  return (
    <div style={{ padding: 24 }}>
      Logged in. Dashboard page comes in a later task.
      <button onClick={logout}>Salir</button>
    </div>
  );
}
```

- [ ] **Step 5: Verify a real login against the local backend, in a browser**

Confirm the backend is running (`cd backend && npm run dev` or `PORT=3055 node index.mjs`, whichever port matches `frontend/.env.example` — create a real `frontend/.env` with `VITE_API_URL` pointing at whatever port the backend is actually listening on if it differs from the example's `3055`). Run `cd frontend && npm run dev`.

Use the `claude-in-chrome` tools:
1. `navigate` to the frontend dev URL.
2. `computer screenshot` — confirm the login card renders with the beige page background, white card, "altorancho." logo, password field, and dark "Ingresar" button.
3. Read the real `DASHBOARD_PASSWORD` from `backend/.env`, type it into the password field (`computer` with `action: type` after clicking the input), and submit.
4. `computer screenshot` — confirm the page now shows "Logged in..." with a "Salir" button (proving the token round-tripped through the real login endpoint and `isAuthenticated` flipped to `true`).
5. Click "Salir", screenshot again, confirm it's back to the login card (logout clears the token and flips `isAuthenticated` back to `false`).
6. Also try an intentionally wrong password once, screenshot, confirm the red error message renders (exercises the `error` prop path).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/client.js frontend/src/auth/useAuth.js frontend/src/pages/Login.jsx frontend/src/App.jsx frontend/.env
```

Wait — do NOT commit `frontend/.env` if it contains a real API URL pointing at a non-default local port; check `frontend/.gitignore` exists and excludes `.env` (create it if this task is the first to need one: content `node_modules/\n.env\ndist/\n`). Stage only the source files plus `.gitignore` if you created it.

```bash
git commit -m "feat(frontend): add API client, auth hook, and Login page"
```

---

### Task 6: `PeriodSelector` and `ChannelTabs` components

**Files:**
- Create: `frontend/src/components/PeriodSelector.jsx`
- Create: `frontend/src/components/ChannelTabs.jsx`

**Interfaces:**
- Consumes: `formatPeriodLabel` (Task 3), `CHANNELS` (Task 4).
- Produces: `<PeriodSelector period date onPeriodChange onNavigate />`, `<ChannelTabs channel onChannelChange />`. Consumed by `Dashboard` (Task 12).

- [ ] **Step 1: Create `frontend/src/components/PeriodSelector.jsx`**

```jsx
import { formatPeriodLabel } from '../lib/periods.js';

export default function PeriodSelector({ period, date, onPeriodChange, onNavigate }) {
  return (
    <div className="period-selector">
      <div className="period-toggle">
        <button className={period === 'week' ? 'active' : ''} onClick={() => onPeriodChange('week')}>
          Semana
        </button>
        <button className={period === 'month' ? 'active' : ''} onClick={() => onPeriodChange('month')}>
          Mes
        </button>
      </div>
      <div className="period-nav">
        <button onClick={() => onNavigate(-1)} aria-label="Período anterior">‹</button>
        <span className="period-label">{formatPeriodLabel(date, period)}</span>
        <button onClick={() => onNavigate(1)} aria-label="Período siguiente">›</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `frontend/src/components/ChannelTabs.jsx`**

```jsx
import { CHANNELS } from '../lib/channels.js';

export default function ChannelTabs({ channel, onChannelChange }) {
  return (
    <div className="channel-tabs">
      <button
        className={`channel-tab ${channel === null ? 'active' : ''}`}
        style={channel === null ? { '--tab-color': '#353434' } : undefined}
        onClick={() => onChannelChange(null)}
      >
        Consolidado
      </button>
      {CHANNELS.map((c) => (
        <button
          key={c.id}
          className={`channel-tab ${channel === c.id ? 'active' : ''}`}
          style={channel === c.id ? { '--tab-color': c.color } : undefined}
          onClick={() => onChannelChange(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify in a browser**

Temporarily render both in `App.jsx`'s authenticated branch with local `useState` for `period`/`date`/`channel` (throwaway wiring, doesn't need to be kept — Task 12 replaces this with the real `Dashboard`). Screenshot via `claude-in-chrome`:
1. Confirm the Semana/Mes toggle shows one pill highlighted dark, click the other and confirm it swaps.
2. Confirm the ‹/› arrows change the displayed label (e.g. clicking › on a week view advances by a week — cross-check the label text against `shiftPeriod`'s known output for that date).
3. Confirm all 6 channel tabs render with their labels, and clicking one shows a colored underline in that channel's brand color (zoom in via `computer zoom` on the active tab to confirm the underline color visually matches, e.g. blue for Mayorista).

Revert the throwaway `App.jsx` wiring after confirming (git diff should show only the two new component files, not App.jsx, when you commit).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PeriodSelector.jsx frontend/src/components/ChannelTabs.jsx
git commit -m "feat(frontend): add PeriodSelector and ChannelTabs components"
```

---

### Task 7: `DeltaBadge` and `KpiCards` components

**Files:**
- Create: `frontend/src/components/DeltaBadge.jsx`
- Create: `frontend/src/components/KpiCards.jsx`

**Interfaces:**
- Consumes: `formatPercent`, `formatCurrency`, `formatNumber` (Task 2).
- Produces: `<DeltaBadge pct />`, `<KpiCards current comparisons />` where `current` is a `totals` object and `comparisons` is the `{prevPeriod, prevMonth, prevYear}` object from the report response. Consumed by `Dashboard` (Task 12).

- [ ] **Step 1: Create `frontend/src/components/DeltaBadge.jsx`**

```jsx
import { formatPercent } from '../lib/format.js';

export default function DeltaBadge({ pct }) {
  if (pct === null || pct === undefined) {
    return <span className="delta-badge delta-neutral">—</span>;
  }
  const className = pct >= 0 ? 'delta-positive' : 'delta-negative';
  return <span className={`delta-badge ${className}`}>{formatPercent(pct)}</span>;
}
```

- [ ] **Step 2: Create `frontend/src/components/KpiCards.jsx`**

```jsx
import { formatCurrency, formatNumber } from '../lib/format.js';
import DeltaBadge from './DeltaBadge.jsx';

const METRICS = [
  { key: 'revenue', label: 'Facturación', format: formatCurrency },
  { key: 'avgDailyRevenue', label: 'Facturación promedio diaria', format: formatCurrency },
  { key: 'orders', label: 'Ventas', format: formatNumber },
  { key: 'units', label: 'Unidades', format: formatNumber },
  { key: 'avgTicket', label: 'Ticket promedio', format: formatCurrency },
];

const COMPARISON_LABELS = {
  prevPeriod: 'vs. período anterior',
  prevMonth: 'vs. mes anterior',
  prevYear: 'vs. año anterior',
};

export default function KpiCards({ current, comparisons }) {
  return (
    <div className="kpi-cards">
      {METRICS.map((metric) => (
        <div className="kpi-card" key={metric.key}>
          <div className="kpi-label">{metric.label}</div>
          <div className="kpi-value">{metric.format(current[metric.key])}</div>
          <div className="kpi-deltas">
            {Object.entries(COMPARISON_LABELS).map(([key, label]) => (
              <div className="kpi-delta-row" key={key}>
                <span className="kpi-delta-label">{label}</span>
                <DeltaBadge pct={comparisons[key].deltas[metric.key]?.pct} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify in a browser against real data**

Temporarily render `<KpiCards current={...} comparisons={...} />` in `App.jsx`'s authenticated branch, fetching once with a hardcoded `getReport({ period: 'week', date: '2026-07-06' })` call (throwaway wiring, Task 12 replaces it). Screenshot via `claude-in-chrome`:
1. Confirm 5 cards render with real revenue/units/orders/ticket numbers formatted as `$ X.XXX.XXX` / `X.XXX`.
2. Confirm each card shows 3 delta rows with green/red badges (or `—` where the comparison period had no data, e.g. "vs. año anterior" should show `—` since no historical backfill has run yet — this is expected, not a bug).

Revert the throwaway wiring after confirming.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/DeltaBadge.jsx frontend/src/components/KpiCards.jsx
git commit -m "feat(frontend): add DeltaBadge and KpiCards components"
```

---

### Task 8: `DailyChart` component

**Files:**
- Create: `frontend/src/components/DailyChart.jsx`

**Interfaces:**
- Consumes: `formatCurrency` (Task 2), `getChannelColor` (Task 4), Recharts (`BarChart`, `Bar`, `XAxis`, `YAxis`, `Tooltip`, `ResponsiveContainer`, `CartesianGrid`).
- Produces: `<DailyChart data={report.current.dailyBreakdown} channel={channel} />`. Consumed by `Dashboard` (Task 12).

- [ ] **Step 1: Create `frontend/src/components/DailyChart.jsx`**

```jsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatCurrency } from '../lib/format.js';
import { getChannelColor } from '../lib/channels.js';

function formatDayTick(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

export default function DailyChart({ data, channel }) {
  const color = getChannelColor(channel);

  return (
    <div className="chart-card">
      <h3 className="chart-title">Facturación por día</h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="date" tickFormatter={formatDayTick} stroke="var(--ink-secondary)" fontSize={12} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={(v) => formatCurrency(v)} width={90} />
          <Tooltip formatter={(value) => formatCurrency(value)} labelFormatter={formatDayTick} />
          <Bar dataKey="revenue" fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Verify in a browser against real data**

Temporarily render `<DailyChart data={report.current.dailyBreakdown} channel={null} />` in `App.jsx` (throwaway wiring, same pattern as Task 7). Screenshot via `claude-in-chrome`:
1. Confirm bars render, one per day in the fetched period, with rounded top corners, in the neutral charcoal color (since `channel={null}`).
2. Hover over a bar (`computer` `action: hover` at the bar's coordinates) and screenshot again — confirm a tooltip appears showing the formatted currency value.
3. Re-render with `channel="mayorista"` and confirm the bars turn blue.

Revert the throwaway wiring after confirming.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/DailyChart.jsx
git commit -m "feat(frontend): add DailyChart component"
```

---

### Task 9: `TopProductsTable` component

**Files:**
- Create: `frontend/src/components/TopProductsTable.jsx`

**Interfaces:**
- Consumes: `formatCurrency`, `formatNumber` (Task 2).
- Produces: `<TopProductsTable byUnits={report.current.topProductsByUnits} byRevenue={report.current.topProductsByRevenue} />`. Consumed by `Dashboard` (Task 12).

- [ ] **Step 1: Create `frontend/src/components/TopProductsTable.jsx`**

```jsx
import { useState } from 'react';
import { formatCurrency, formatNumber } from '../lib/format.js';

export default function TopProductsTable({ byUnits, byRevenue }) {
  const [sortBy, setSortBy] = useState('units');
  const rows = sortBy === 'units' ? byUnits : byRevenue;

  return (
    <div className="table-card">
      <div className="table-header">
        <h3 className="chart-title">Top productos</h3>
        <div className="table-toggle">
          <button className={sortBy === 'units' ? 'active' : ''} onClick={() => setSortBy('units')}>Vendidos</button>
          <button className={sortBy === 'revenue' ? 'active' : ''} onClick={() => setSortBy('revenue')}>Facturación</button>
        </div>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Producto</th>
            <th>Vendidos</th>
            <th>Facturación</th>
            <th>Stock</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.sku}>
              <td>{p.name}</td>
              <td>{formatNumber(p.unitsSold)}</td>
              <td>{formatCurrency(p.revenue)}</td>
              <td>{p.currentStock === null ? '—' : formatNumber(p.currentStock)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Verify in a browser against real data**

Same throwaway-render pattern as Task 7/8. Screenshot via `claude-in-chrome`:
1. Confirm the table lists real product names with unit/revenue/stock columns, sorted by units sold (default).
2. Click "Facturación", screenshot again, confirm the row order changes to revenue-sorted.
3. Confirm at least one row shows `—` for stock (products not in Tiendanube's catalog have `currentStock: null` — verified in Task 8 of the backend plan; if all synced test data happens to have real stock values, this specific case may not be visible, note that in your report rather than forcing it).

Revert the throwaway wiring after confirming.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/TopProductsTable.jsx
git commit -m "feat(frontend): add TopProductsTable component"
```

---

### Task 10: `CategoryBreakdown`, `PaymentMethodsChart`, `ProvincesChart` components

**Files:**
- Create: `frontend/src/components/CategoryBreakdown.jsx`
- Create: `frontend/src/components/PaymentMethodsChart.jsx`
- Create: `frontend/src/components/ProvincesChart.jsx`

**Interfaces:**
- Consumes: `formatCurrency`, `formatNumber` (Task 2), Recharts (`PieChart`, `Pie`, `Cell`, `Tooltip`, `Legend`, `BarChart`, `Bar`, `XAxis`, `YAxis`, `ResponsiveContainer`).
- Produces: `<CategoryBreakdown categories={report.current.categories} />`, `<PaymentMethodsChart paymentMethods={report.current.paymentMethods} />`, `<ProvincesChart provinces={report.current.provinces} />`. Consumed by `Dashboard` (Task 12), which hides `ProvincesChart` entirely when `provinces` is empty (non-ecommerce channels have no province data).

- [ ] **Step 1: Create `frontend/src/components/CategoryBreakdown.jsx`**

```jsx
import { formatCurrency, formatNumber } from '../lib/format.js';

export default function CategoryBreakdown({ categories }) {
  const max = categories[0]?.revenue || 1;

  return (
    <div className="list-card">
      <h3 className="chart-title">Ventas por categoría</h3>
      <ul className="bar-list">
        {categories.map((c) => (
          <li key={c.category} className="bar-list-row">
            <span className="bar-list-label">{c.category}</span>
            <div className="bar-list-track">
              <div className="bar-list-fill" style={{ width: `${(c.revenue / max) * 100}%` }} />
            </div>
            <span className="bar-list-value">{formatCurrency(c.revenue)} · {formatNumber(c.units)} un.</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Create `frontend/src/components/PaymentMethodsChart.jsx`**

```jsx
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '../lib/format.js';

const DONUT_COLORS = ['#2A78D6', '#1BAF7A', '#EB6834', '#4A3AA7', '#008300', '#6B6968'];

export default function PaymentMethodsChart({ paymentMethods }) {
  return (
    <div className="chart-card">
      <h3 className="chart-title">Medios de pago</h3>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={paymentMethods} dataKey="revenue" nameKey="method" innerRadius={60} outerRadius={90}>
            {paymentMethods.map((entry, i) => (
              <Cell key={entry.method} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => formatCurrency(value)} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Create `frontend/src/components/ProvincesChart.jsx`**

```jsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { formatNumber } from '../lib/format.js';

export default function ProvincesChart({ provinces }) {
  const top5 = provinces.slice(0, 5);

  return (
    <div className="chart-card">
      <h3 className="chart-title">Top provincias</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={top5} layout="vertical" margin={{ left: 24 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="province" stroke="var(--ink-secondary)" fontSize={12} width={110} />
          <Tooltip formatter={(value) => formatNumber(value)} />
          <Bar dataKey="orders" fill="#1BAF7A" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Verify all three in a browser against real data**

Same throwaway-render pattern as prior component tasks. Screenshot via `claude-in-chrome`:
1. `CategoryBreakdown` — confirm horizontal bars scaled relative to the top category, with revenue + unit count labels.
2. `PaymentMethodsChart` — confirm a donut renders with a legend listing real payment method names (Mercado Pago, Pago Nube, Caja ..., etc. — real values seen during backend verification).
3. `ProvincesChart` — confirm horizontal bars with province names, only when testing against the `ecommerce` channel (or consolidado) — test once with `provinces: []` (e.g. by fetching a locales-only channel) to confirm it doesn't crash on an empty array (it should just render an empty chart; `Dashboard` in Task 12 is what actually hides the section, this component itself just needs to not error).

Revert the throwaway wiring after confirming.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CategoryBreakdown.jsx frontend/src/components/PaymentMethodsChart.jsx frontend/src/components/ProvincesChart.jsx
git commit -m "feat(frontend): add CategoryBreakdown, PaymentMethodsChart, ProvincesChart components"
```

---

### Task 11: `LocalesPanel` and `MayoristaPanel` components

**Files:**
- Create: `frontend/src/components/LocalesPanel.jsx`
- Create: `frontend/src/components/MayoristaPanel.jsx`

**Interfaces:**
- Consumes: `getReport` (Task 5), `formatCurrency`/`formatNumber` (Task 2), `getChannelColor`/`getChannelLabel` (Task 4).
- Produces: `<LocalesPanel period date />`, `<MayoristaPanel period date />` — each fetches its own data independently (the `/api/report` endpoint aggregates whatever channels it's given into ONE combined total, it doesn't return a per-channel breakdown, so comparing Lomas/Belgrano/Alcorta side by side needs 3 separate calls). Consumed by `Dashboard` (Task 12), rendered only when the top-level channel filter is "Consolidado" (`channel === null`) — comparing locals to each other doesn't make sense once you've already drilled into one specific channel.

- [ ] **Step 1: Create `frontend/src/components/LocalesPanel.jsx`**

```jsx
import { useState, useEffect } from 'react';
import { getReport } from '../api/client.js';
import { formatCurrency, formatNumber } from '../lib/format.js';
import { getChannelColor, getChannelLabel } from '../lib/channels.js';

const LOCAL_CHANNELS = ['local_lomas', 'local_belgrano', 'local_alcorta'];

export default function LocalesPanel({ period, date }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    Promise.all(LOCAL_CHANNELS.map((channel) => getReport({ period, date, channel })))
      .then((results) => { if (!cancelled) setData(results); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [period, date]);

  if (!data) return null;

  return (
    <div className="panel-card">
      <h3 className="chart-title">Locales</h3>
      <div className="panel-grid">
        {LOCAL_CHANNELS.map((channel, i) => (
          <div className="panel-item" key={channel} style={{ '--tab-color': getChannelColor(channel) }}>
            <div className="panel-item-label">{getChannelLabel(channel)}</div>
            <div className="panel-item-value">{formatCurrency(data[i].current.totals.revenue)}</div>
            <div className="panel-item-sub">{formatNumber(data[i].current.totals.orders)} ventas</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `frontend/src/components/MayoristaPanel.jsx`**

```jsx
import { useState, useEffect } from 'react';
import { getReport } from '../api/client.js';
import { formatCurrency, formatNumber } from '../lib/format.js';
import { getChannelColor, getChannelLabel } from '../lib/channels.js';

export default function MayoristaPanel({ period, date }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    getReport({ period, date, channel: 'mayorista' })
      .then((result) => { if (!cancelled) setData(result); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [period, date]);

  if (!data) return null;

  return (
    <div className="panel-card">
      <h3 className="chart-title">Mayorista</h3>
      <div className="panel-item" style={{ '--tab-color': getChannelColor('mayorista') }}>
        <div className="panel-item-label">{getChannelLabel('mayorista')}</div>
        <div className="panel-item-value">{formatCurrency(data.current.totals.revenue)}</div>
        <div className="panel-item-sub">{formatNumber(data.current.totals.orders)} ventas</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify in a browser against real data**

Same throwaway-render pattern. Screenshot via `claude-in-chrome`:
1. `LocalesPanel` — confirm 3 items render (Lomas/Belgrano/Alcorta), each with a colored left border matching its brand color, and real revenue/order numbers that are each individually smaller than the "Consolidado" KPI total (sanity check: they're a subset).
2. `MayoristaPanel` — confirm one item renders in blue with real numbers.
3. Confirm neither panel crashes or shows stale data when you change the `date`/`period` props (re-fetches correctly — watch the network tab or console log a marker if `read_network_requests` is available/loaded).

Revert the throwaway wiring after confirming.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LocalesPanel.jsx frontend/src/components/MayoristaPanel.jsx
git commit -m "feat(frontend): add LocalesPanel and MayoristaPanel components"
```

---

### Task 12: `Dashboard` page — wires everything together

**Files:**
- Create: `frontend/src/pages/Dashboard.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: every component and lib module from Tasks 2-11.
- Produces: the real, final `Dashboard` page. This replaces all the throwaway wiring used to verify Tasks 6-11 individually — after this task, `App.jsx` should contain no leftover inline test rendering.

- [ ] **Step 1: Create `frontend/src/pages/Dashboard.jsx`**

```jsx
import { useState, useEffect, useCallback } from 'react';
import { getReport } from '../api/client.js';
import { shiftPeriod } from '../lib/periods.js';
import PeriodSelector from '../components/PeriodSelector.jsx';
import ChannelTabs from '../components/ChannelTabs.jsx';
import KpiCards from '../components/KpiCards.jsx';
import DailyChart from '../components/DailyChart.jsx';
import TopProductsTable from '../components/TopProductsTable.jsx';
import CategoryBreakdown from '../components/CategoryBreakdown.jsx';
import PaymentMethodsChart from '../components/PaymentMethodsChart.jsx';
import ProvincesChart from '../components/ProvincesChart.jsx';
import LocalesPanel from '../components/LocalesPanel.jsx';
import MayoristaPanel from '../components/MayoristaPanel.jsx';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Dashboard({ onLogout }) {
  const [period, setPeriod] = useState('week');
  const [date, setDate] = useState(todayISO());
  const [channel, setChannel] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getReport({ period, date, channel });
      setReport(data);
    } catch (err) {
      setError(err.message);
      if (err.message === 'Unauthorized') onLogout();
    } finally {
      setLoading(false);
    }
  }, [period, date, channel, onLogout]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <span className="logo">altorancho.</span>
        <PeriodSelector
          period={period}
          date={date}
          onPeriodChange={setPeriod}
          onNavigate={(direction) => setDate((prev) => shiftPeriod(prev, period, direction))}
        />
        <ChannelTabs channel={channel} onChannelChange={setChannel} />
      </header>

      {loading && <p className="status-text">Cargando...</p>}
      {error && <p className="status-text status-error">Error: {error}</p>}

      {report && !loading && (
        <main className="dashboard-body">
          <KpiCards current={report.current.totals} comparisons={report.comparisons} />
          <DailyChart data={report.current.dailyBreakdown} channel={channel} />
          <div className="dashboard-grid">
            <TopProductsTable
              byUnits={report.current.topProductsByUnits}
              byRevenue={report.current.topProductsByRevenue}
            />
            <CategoryBreakdown categories={report.current.categories} />
            <PaymentMethodsChart paymentMethods={report.current.paymentMethods} />
            {report.current.provinces.length > 0 && (
              <ProvincesChart provinces={report.current.provinces} />
            )}
          </div>
          {channel === null && (
            <div className="dashboard-grid">
              <LocalesPanel period={period} date={date} />
              <MayoristaPanel period={period} date={date} />
            </div>
          )}
        </main>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Modify `frontend/src/App.jsx`** to render the real `Dashboard` instead of the placeholder, removing any leftover throwaway wiring from Tasks 6-11

```jsx
import { useState } from 'react';
import { useAuth } from './auth/useAuth.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

export default function App() {
  const { isAuthenticated, login, logout } = useAuth();
  const [loginError, setLoginError] = useState(null);

  if (!isAuthenticated) {
    return (
      <Login
        error={loginError}
        onLogin={async (password) => {
          try {
            setLoginError(null);
            await login(password);
          } catch (err) {
            setLoginError(err.message);
          }
        }}
      />
    );
  }

  return <Dashboard onLogout={logout} />;
}
```

- [ ] **Step 3: Full end-to-end browser verification**

With the backend running, `npm run dev` in `frontend/`. Use `claude-in-chrome`:
1. Navigate, screenshot the login page, log in with the real password.
2. Screenshot the resulting Dashboard — confirm the header (logo, period selector, channel tabs), KPI cards, daily chart, product table, category/payment breakdowns, and (since starting channel is "Consolidado") the Locales and Mayorista panels all render together with real data, matching the visual identity (beige cards, charcoal ink, Poppins).
3. Click "Mes" in the period toggle, screenshot — confirm the whole page reloads with month-scoped data (loading state briefly, then new numbers) and the Locales/Mayorista panels update too.
4. Click a specific channel tab (e.g. "Belgrano"), screenshot — confirm the KPIs/chart/tables update to that channel's data, the daily chart bars turn Belgrano's violet color, and the Locales/Mayorista panels disappear (since you're no longer in Consolidado view).
5. Click back to "Consolidado", click the › (next period) arrow, screenshot — confirm the period label and data both advance.
6. Check for console errors throughout (`read_console_messages` if loaded) — should be clean, no React key warnings, no unhandled promise rejections.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Dashboard.jsx frontend/src/App.jsx
git commit -m "feat(frontend): add Dashboard page wiring all sections together"
```

---

### Task 13: Production build and deployment docs

**Files:**
- Create: `frontend/README.md`
- Modify: `frontend/.gitignore` (create if Task 5 didn't already)

**Interfaces:** none (build verification + docs only).

- [ ] **Step 1: Verify the production build works**

Run: `cd frontend && npm run build`
Expected: succeeds, produces a `dist/` folder with hashed asset filenames, no build errors or warnings about missing env vars.

Run: `npm run preview` (serves the built `dist/` locally) and use `claude-in-chrome` to navigate to the preview URL, screenshot, confirm it looks identical to the dev-server version (login page renders; if you have real credentials handy, log in and confirm the Dashboard renders too — the build output must talk to the backend the same way dev mode did).

- [ ] **Step 2: Create `frontend/README.md`**

```markdown
# Altorancho Reportes — Frontend

Dashboard de React que consume la API del backend (`../backend`) para mostrar
el reporte semanal/mensual de ventas.

## Desarrollo local

    npm install
    cp .env.example .env   # ajustar VITE_API_URL al puerto real del backend local
    npm run dev
    npm test

Necesita el backend corriendo (`cd ../backend && npm run dev`) para poder loguearse
y ver datos reales.

## Build de producción

    npm run build

Genera `dist/` — subir el contenido de esa carpeta por FTP/cPanel a Hostinger o
GoDaddy. `VITE_API_URL` se resuelve en build time: correr `npm run build` con esa
variable apuntando a la URL real del backend en Railway antes de subir, por ejemplo:

    VITE_API_URL=https://tu-backend.up.railway.app npm run build

## Variables de entorno

Ver `.env.example`. Solo hay una: `VITE_API_URL`, la URL base del backend.
```

- [ ] **Step 3: Commit**

```bash
git add frontend/README.md frontend/.gitignore
git commit -m "docs(frontend): add build verification notes and deployment README"
```

---

## Not covered by this plan

- Actually deploying the backend to Railway or the frontend to Hostinger/GoDaddy — explicitly deferred; the user wants to verify everything locally first.
- Running the full 14-month backend backfill — still pending from the backend plan, needed before "vs. año anterior" comparisons show real data instead of `—`.
- Any visual polish pass beyond what's specified here (animations, empty/loading skeleton states beyond the plain "Cargando..." text, mobile-responsive breakpoints) — this plan targets a working, on-brand desktop dashboard for the weekly meeting, not a polished public-facing product.
