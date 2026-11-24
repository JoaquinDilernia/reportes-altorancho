// GET /api/v3/lectores: los lectores de precios de los locales (pick.altorancho.com).
// Cada consulta de un cliente queda en Firestore `pickalto_searches` (SKU, local,
// hora). Se cruza con las ventas del POS del mismo local y período: lo que se
// consulta mucho y no se vende es la señal (precio, stock, exhibición).
import { getPeriodRanges } from './periods.mjs';
import { getDb, querySalesByRange, getProductsBySku } from './firestore.mjs';
import { argDay, argHour } from './events.mjs';
import { webPlan } from './webReport.mjs';
import { skuModel } from './eventCategories.mjs';
import { LOCALES } from './localesTab.mjs';
import { isRefund } from './aggregate.mjs';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pctDelta = (cur, prev) => (prev > 0 ? round(((cur / prev) - 1) * 100, 1) : null);

// Puro. searches: [{ sku, local, date }], sales: docs del POS de los locales.
export function buildLectores({ curSearches, prevSearches, curSales, productsBySku, limit = 15 }) {
  const byLocal = {};
  for (const l of LOCALES) {
    const cur = curSearches.filter((s) => s.local === l.id);
    const prevCount = prevSearches.filter((s) => s.local === l.id).length;
    const sales = curSales.filter((d) => d.channel === l.channel && d.status === 'completed');
    const unitsBySku = new Map();
    const tickets = sales.filter((d) => !isRefund(d));
    for (const d of sales) for (const it of d.items || []) unitsBySku.set(it.sku, (unitsBySku.get(it.sku) || 0) + (it.qty || 0));

    const bySku = new Map();
    const byHour = new Map();
    for (const s of cur) {
      const p = bySku.get(s.sku) ?? { sku: s.sku, searches: 0, name: productsBySku.get(s.sku)?.name || s.name || s.sku };
      p.searches += 1;
      bySku.set(s.sku, p);
      const h = argHour(s.date);
      byHour.set(h, (byHour.get(h) || 0) + 1);
    }
    const top = [...bySku.values()]
      .sort((a, b) => b.searches - a.searches || a.sku.localeCompare(b.sku))
      .slice(0, limit)
      .map((p) => ({ ...p, model: skuModel(p.sku), unitsSold: unitsBySku.get(p.sku) || 0 }));
    const consultedSkus = bySku.size;
    const soldOfConsulted = [...bySku.keys()].filter((sku) => unitsBySku.get(sku) > 0).length;

    byLocal[l.id] = {
      id: l.id,
      label: l.label,
      hasReader: cur.length + prevCount > 0,
      searches: cur.length,
      prevSearches: prevCount,
      vsPrev: pctDelta(cur.length, prevCount),
      tickets: tickets.length,
      searchesPerTicket: tickets.length ? round(cur.length / tickets.length) : null,
      consultedSkus,
      soldOfConsultedPct: consultedSkus ? round((soldOfConsulted / consultedSkus) * 100, 1) : null,
      hours: [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, n]) => ({ hour, searches: n })),
      top,
    };
  }
  const known = new Set(LOCALES.map((l) => l.id));
  return { byLocal, unassigned: curSearches.filter((s) => !known.has(s.local)).length };
}

// Bordes del día en hora Argentina
const artStart = (ymd) => new Date(`${ymd}T00:00:00-03:00`);
const artEnd = (ymd) => new Date(`${ymd}T23:59:59.999-03:00`);

async function querySearches({ start, end }) {
  const snap = await getDb().collection('pickalto_searches')
    .where('timestamp', '>=', artStart(start))
    .where('timestamp', '<=', artEnd(end))
    .select('productName', 'productDescription', 'timestamp', 'local')
    .get();
  return snap.docs.map((d) => {
    const x = d.data();
    return { sku: String(x.productName || '').trim(), name: x.productDescription || '', local: x.local || 'sin_local', date: x.timestamp.toDate().toISOString() };
  }).filter((s) => s.sku);
}

export async function buildLectoresReport({ period = 'week', date, start, end }, { now = new Date() } = {}) {
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current } = ranges;
  const { prevPeriodRange } = webPlan(ranges, argDay(now.toISOString()));
  const [curSearches, prevSearches, curSales, productsBySku] = await Promise.all([
    querySearches(current),
    querySearches(prevPeriodRange),
    querySalesByRange(LOCALES.map((l) => l.channel), current.start, current.end),
    getProductsBySku(),
  ]);
  return {
    range: current,
    prevPeriodRange,
    ...buildLectores({ curSearches, prevSearches, curSales, productsBySku }),
    generatedAt: now.toISOString(),
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function getLectores(params) {
  const { current } = params.period === 'custom' ? getPeriodRanges(params.start, 'custom', params.end) : getPeriodRanges(params.date, params.period);
  const key = `${current.start}|${current.end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildLectoresReport(params);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
