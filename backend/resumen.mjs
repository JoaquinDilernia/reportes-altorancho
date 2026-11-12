// Resumen tab of the new report: KPIs with sparklines, sales by channel and
// the stacked daily chart. Pure functions — the IO lives in resumenReport.mjs.
import { computeDelta, computeInflationAdjustedDelta } from './aggregate.mjs';
import { addDays, argDay, weekdayOf } from './events.mjs';

// Feria is folded into mayorista: it no longer has a tab of its own.
export const RESUMEN_CHANNELS = [
  { id: 'web', channels: ['ecommerce'] },
  { id: 'lomas', channels: ['local_lomas'] },
  { id: 'belgrano', channels: ['local_belgrano'] },
  { id: 'alcorta', channels: ['local_alcorta'] },
  { id: 'mayorista', channels: ['mayorista', 'feria'] },
];
const GROUP_OF = new Map(RESUMEN_CHANNELS.flatMap(g => g.channels.map(ch => [ch, g.id])));
const emptyByChannel = () => Object.fromEntries(RESUMEN_CHANNELS.map(g => [g.id, 0]));

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pctDelta = (cur, prev) => computeDelta(cur, prev).pct;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

function monthRange(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) };
}

// The n consecutive ranges ending with the current one (last = current).
// Month mode always shows a year of calendar months.
export function sparkRanges(ranges, period, n = 8) {
  const { start, end } = ranges.current;
  if (period === 'month') {
    const [y, m] = start.split('-').map(Number);
    return Array.from({ length: 12 }, (_, i) => monthRange(y, m - 1 - 11 + i));
  }
  const len = daysBetween(start, end) + 1;
  return Array.from({ length: n }, (_, i) => {
    const shift = -(n - 1 - i) * len;
    return { start: addDays(start, shift), end: addDays(end, shift) };
  });
}

function sumByGroup(docs) {
  const out = Object.fromEntries(RESUMEN_CHANNELS.map(g => [g.id, { revenue: 0, orders: 0 }]));
  for (const d of docs) {
    if (d.status !== 'completed') continue;
    const g = GROUP_OF.get(d.channel);
    if (!g) continue;
    out[g].revenue += d.total;
    out[g].orders += 1;
  }
  return out;
}

export function channelBreakdown(curDocs, prevDocs) {
  const cur = sumByGroup(curDocs);
  const prev = sumByGroup(prevDocs);
  const total = Object.values(cur).reduce((s, c) => s + c.revenue, 0);
  return RESUMEN_CHANNELS.map(({ id }) => ({
    id,
    revenue: cur[id].revenue,
    orders: cur[id].orders,
    deltaPct: pctDelta(cur[id].revenue, prev[id].revenue),
    sharePct: total ? round((cur[id].revenue / total) * 100, 1) : 0,
  }));
}

const mondayOf = (day) => addDays(day, -((weekdayOf(day) + 6) % 7));
// A year-ago sale is drawn on the same calendar date this year.
const plusOneYear = (day) => `${Number(day.slice(0, 4)) + 1}${day.slice(4)}`;

// Stacked revenue per day (per week past 45 days) and channel, with last
// year's same dates as a line, adjusted by inflation when the factor is known.
export function dailyStacked(curDocs, prevYearDocs, { start, end, prevYearFactor }) {
  const bucket = daysBetween(start, end) + 1 > 45 ? 'week' : 'day';
  const keyOf = (day) => (bucket === 'week' ? mondayOf(day) : day);
  const rows = new Map();
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const key = keyOf(day);
    if (!rows.has(key)) rows.set(key, { key, byChannel: emptyByChannel(), total: 0, prevYearAdj: 0 });
  }
  for (const d of curDocs) {
    if (d.status !== 'completed') continue;
    const g = GROUP_OF.get(d.channel);
    const row = rows.get(keyOf(argDay(d.date)));
    if (!g || !row) continue;
    row.byChannel[g] += d.total;
    row.total += d.total;
  }
  const factor = prevYearFactor ?? 1;
  for (const d of prevYearDocs) {
    if (d.status !== 'completed' || !GROUP_OF.has(d.channel)) continue;
    const row = rows.get(keyOf(plusOneYear(argDay(d.date))));
    if (row) row.prevYearAdj += d.total * factor;
  }
  return { bucket, rows: [...rows.values()] };
}

const conversionOf = (w) => (w && w.sessions ? (w.purchases / w.sessions) * 100 : null);
const ppDelta = (a, b) => (a == null || b == null ? null : round(a - b));
const roasOf = (a) => (a && a.spend ? round(a.value / a.spend) : null);

// `sparks` are the totals of sparkRanges (oldest first); web and ads carry
// their own per-range series.
export function buildKpis({ cur, prevPeriod, prevYear, sparks, inflation = {}, web, ads }) {
  const { currentIndex, prevYearIndex } = inflation;
  const hasIndex = !!(currentIndex && prevYearIndex);
  const money = (key) => ({
    id: key,
    value: cur[key],
    vsPrev: pctDelta(cur[key], prevPeriod[key]),
    vsYear: hasIndex
      ? computeInflationAdjustedDelta(cur[key], prevYear[key], currentIndex, prevYearIndex).pct
      : pctDelta(cur[key], prevYear[key]),
    vsYearKind: hasIndex ? 'real' : 'nominal',
    spark: sparks.map(s => s[key]),
  });
  const conv = conversionOf(web?.cur);
  return [
    money('revenue'),
    {
      id: 'orders', value: cur.orders, vsPrev: pctDelta(cur.orders, prevPeriod.orders),
      vsYear: pctDelta(cur.orders, prevYear.orders), vsYearKind: 'nominal', spark: sparks.map(s => s.orders),
    },
    money('avgTicket'),
    {
      id: 'conversion',
      value: conv == null ? null : round(conv),
      vsPrev: ppDelta(conv, conversionOf(web?.prev)),
      vsYear: ppDelta(conv, conversionOf(web?.yoy)),
      vsYearKind: web ? 'pp' : null,
      spark: web ? web.spark.map(s => { const c = conversionOf(s); return c == null ? null : round(c); }) : [],
    },
    {
      id: 'adSpend', value: ads.cur.spend, vsPrev: pctDelta(ads.cur.spend, ads.prev.spend),
      vsYear: null, vsYearKind: null, spark: ads.spark.map(s => s.spend),
      extra: { roas: roasOf(ads.cur), roasPrev: roasOf(ads.prev) },
    },
  ];
}
