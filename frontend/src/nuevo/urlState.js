// The new report's state lives in the URL (?v=nuevo&tab=…&period=…), so a
// view can be shared, reloaded or reached with the back button.
export const TABS = ['resumen', 'web', 'locales', 'producto', 'pauta', 'mayorista', 'cyber'];
const PERIODS = ['week', 'month', 'custom'];
// Producto tab channel filter (?ch=…); 'all' is the default and stays out of the URL.
export const PRODUCT_CHANNELS = ['all', 'web', 'locales', 'mayorista'];
// Locales tab store (?loc=…); lomas is the default and stays out of the URL.
export const LOCAL_IDS = ['lomas', 'belgrano', 'alcorta'];
// An open product sheet (?sku=…). SKUs are letters, digits, . _ -
const SKU_RE = /^[A-Za-z0-9._-]{1,40}$/;

function isISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parsePeriod(q, today) {
  const fallback = { period: 'week', date: today, start: null, end: null };
  const period = q.get('period') || 'week';
  if (!PERIODS.includes(period)) return fallback;
  if (period === 'custom') {
    const start = q.get('start');
    const end = q.get('end');
    if (!isISODate(start) || !isISODate(end) || start > end) return fallback;
    return { period, date: today, start, end };
  }
  const date = q.get('date') || today;
  if (!isISODate(date)) return fallback;
  return { period, date, start: null, end: null };
}

export function parseUrlState(search, today) {
  const q = new URLSearchParams(search);
  const tab = TABS.includes(q.get('tab')) ? q.get('tab') : 'resumen';
  const sku = SKU_RE.test(q.get('sku') || '') ? q.get('sku') : null;
  const ch = PRODUCT_CHANNELS.includes(q.get('ch')) ? q.get('ch') : 'all';
  const loc = LOCAL_IDS.includes(q.get('loc')) ? q.get('loc') : 'lomas';
  return { tab, ...parsePeriod(q, today), sku, ch, loc };
}

export function serializeUrlState({ tab, period, date, start, end, sku, ch, loc }) {
  const q = new URLSearchParams({ v: 'nuevo' });
  if (tab && tab !== 'resumen') q.set('tab', tab);
  q.set('period', period);
  if (period === 'custom') { q.set('start', start); q.set('end', end); } else q.set('date', date);
  if (ch && ch !== 'all') q.set('ch', ch);
  if (loc && loc !== 'lomas') q.set('loc', loc);
  if (sku) q.set('sku', sku);
  return `?${q.toString()}`;
}

// Same shape client.js sends to the backend.
export function periodParams({ period, date, start, end }) {
  return period === 'custom' ? { period, start, end } : { period, date };
}
