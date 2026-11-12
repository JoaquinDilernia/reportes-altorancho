// Locales tab (new report): the three stores side by side, sales per hour and
// each store's detail. Pure — the IO lives in localesReport.mjs.
import { computeTotals, computeDelta, computeInflationAdjustedDelta } from './aggregate.mjs';
import { argHour } from './events.mjs';
import { summarizeCategories, compareTopProducts } from './eventCategories.mjs';
import { summarizeOrigins } from './eventOrigins.mjs';
import { modelStock, warehouses } from './productTab.mjs';
import { LOC_GROUPS } from './stockLocations.mjs';

export const LOCALES = [
  { id: 'lomas', label: 'Lomas', channel: 'local_lomas', stockKey: 'lomas_stock', exhibitionKey: 'lomas_exhibicion' },
  { id: 'belgrano', label: 'Belgrano', channel: 'local_belgrano', stockKey: 'belgrano_stock', exhibitionKey: 'belgrano_exhibicion' },
  { id: 'alcorta', label: 'Alcorta', channel: 'local_alcorta', stockKey: 'alcorta_stock', exhibitionKey: 'alcorta_exhibicion' },
];
const LOCAL_BY_CHANNEL = new Map(LOCALES.map(l => [l.channel, l]));

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pctDelta = (cur, prev) => (cur == null || prev == null ? null : computeDelta(cur, prev).pct);
const ofChannels = (docs, channels) => (docs || []).filter(d => channels.includes(d.channel));

function metrics(docs) {
  const t = computeTotals(docs);
  return { revenue: t.revenue, orders: t.orders, units: t.units, avgTicket: t.avgTicket, unitsPerTicket: t.orders ? round(t.units / t.orders) : null };
}

function row({ id, label }, cur, prev, year, inflation, totalRevenue) {
  const { currentIndex, prevYearIndex } = inflation;
  const money = (key) => computeInflationAdjustedDelta(cur[key], year[key], currentIndex, prevYearIndex);
  const revAdj = money('revenue');
  const ticketAdj = money('avgTicket');
  return {
    id, label, ...cur,
    sharePct: totalRevenue ? round((cur.revenue / totalRevenue) * 100, 1) : 0,
    vsPrev: {
      revenue: pctDelta(cur.revenue, prev.revenue),
      orders: pctDelta(cur.orders, prev.orders),
      avgTicket: pctDelta(cur.avgTicket, prev.avgTicket),
      unitsPerTicket: pctDelta(cur.unitsPerTicket, prev.unitsPerTicket),
    },
    vsYear: {
      revenue: revAdj ? revAdj.pct : pctDelta(cur.revenue, year.revenue),
      orders: pctDelta(cur.orders, year.orders),
      avgTicket: ticketAdj ? ticketAdj.pct : pctDelta(cur.avgTicket, year.avgTicket),
      unitsPerTicket: pctDelta(cur.unitsPerTicket, year.unitsPerTicket),
    },
    yearAdjusted: !!revAdj,
  };
}

export function localesSideBySide({ curDocs, prevDocs, yearDocs, inflation = {} }) {
  const all = LOCALES.map(l => l.channel);
  const side = (docs, channels) => metrics(ofChannels(docs, channels));
  const total = side(curDocs, all);
  return {
    locales: LOCALES.map(l => row(l, side(curDocs, [l.channel]), side(prevDocs, [l.channel]), side(yearDocs, [l.channel]), inflation, total.revenue)),
    total: row({ id: 'total', label: 'Total locales' }, total, side(prevDocs, all), side(yearDocs, all), inflation, total.revenue),
  };
}

// Tickets and revenue per Argentina hour, from the first to the last hour
// with a sale in any store (gaps in between are filled with zeros).
export function localesByHour(curDocs) {
  const byHour = new Map();
  for (const d of curDocs || []) {
    const l = LOCAL_BY_CHANNEL.get(d.channel);
    if (!l || d.status !== 'completed') continue;
    const h = argHour(d.date);
    const acc = byHour.get(h) ?? {};
    const c = acc[l.id] ?? { orders: 0, revenue: 0 };
    c.orders += 1;
    c.revenue += d.total;
    acc[l.id] = c;
    byHour.set(h, acc);
  }
  if (!byHour.size) return { from: null, to: null, rows: [] };
  const from = Math.min(...byHour.keys());
  const to = Math.max(...byHour.keys());
  const rows = [];
  for (let hour = from; hour <= to; hour += 1) {
    const acc = byHour.get(hour) ?? {};
    rows.push({ hour, byLocal: Object.fromEntries(LOCALES.map(l => [l.id, acc[l.id] ?? { orders: 0, revenue: 0 }])) });
  }
  return { from, to, rows };
}

function payments(docs) {
  const by = new Map();
  let total = 0;
  for (const d of docs) {
    if (d.status !== 'completed') continue;
    const method = d.paymentMethod || 'Sin dato';
    const p = by.get(method) ?? { method, orders: 0, revenue: 0 };
    p.orders += 1;
    p.revenue += d.total;
    total += d.total;
    by.set(method, p);
  }
  return [...by.values()]
    .map(p => ({ ...p, sharePct: total ? round((p.revenue / total) * 100, 1) : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
}

// One store's detail. curDocs/prevDocs are already that store's (prev = last
// year's window, cut to the same elapsed days while the period runs).
export function localDetail({ local, curDocs, prevDocs, productsBySku, originBySku, factorByRefDate }) {
  const stockByModel = modelStock(productsBySku);
  const topModels = compareTopProducts({ prevToDateDocs: prevDocs, currentDocs: curDocs, productsBySku, factorByRefDate, limit: 15 })
    .map(m => {
      const byLoc = stockByModel.get(m.sku)?.byLoc ?? {};
      return {
        ...m,
        local: { stock: byLoc[local.stockKey] || 0, exhibition: byLoc[local.exhibitionKey] || 0 },
        rolon: LOC_GROUPS.rolon.reduce((s, k) => s + (byLoc[k] || 0), 0),
      };
    });
  const categories = summarizeCategories({ prevDocs, prevToDateDocs: prevDocs, currentDocs: curDocs, productsBySku, factorByRefDate })
    .filter(c => c.units > 0)
    .map(({ id, label, units, revenue, prevRevenueToDateAdj }) => ({ id, label, units, revenue, prevRevenueToDateAdj }))
    .sort((a, b) => b.revenue - a.revenue);
  const wh = new Map(warehouses(productsBySku).map(w => [w.key, w]));
  const pick = (key) => ({ units: wh.get(key)?.units ?? 0, products: wh.get(key)?.products ?? 0 });
  return {
    topModels,
    categories,
    origins: originBySku?.size ? summarizeOrigins({ prevToDateDocs: prevDocs, currentDocs: curDocs, originBySku, factorByRefDate }) : null,
    payments: payments(curDocs),
    stock: { stock: pick(local.stockKey), exhibition: pick(local.exhibitionKey) },
  };
}
