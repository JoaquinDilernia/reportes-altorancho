// Mayorista tab (new report): mayorista + ferias. Pure — the IO lives in
// mayoristaReport.mjs. Ferias count inside Mayorista and the total; only
// mayorista orders carry what was actually collected (amountCollected).
import { computeTotals, computeDelta, computeInflationAdjustedDelta } from './aggregate.mjs';

export const SOURCES = [
  { id: 'mayorista', label: 'Mayorista' },
  { id: 'feria', label: 'Ferias' },
];
const CHANNELS = SOURCES.map(s => s.id);
const MONEY = new Set(['revenue', 'avgTicket']);

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const pctDelta = (cur, prev) => (cur == null || prev == null ? null : computeDelta(cur, prev).pct);
const ours = (docs) => (docs || []).filter(d => CHANNELS.includes(d.channel));

function metrics(docs) {
  const t = computeTotals(docs);
  return { revenue: t.revenue, orders: t.orders, units: t.units, avgTicket: t.orders ? t.avgTicket : null };
}

export function mayoristaSummary({ curDocs, prevDocs, yearDocs, inflation = {} }) {
  const cur = metrics(ours(curDocs));
  const prev = metrics(ours(prevDocs));
  const year = metrics(ours(yearDocs));
  const { currentIndex, prevYearIndex } = inflation;
  const kpi = (key) => {
    const adj = MONEY.has(key) && cur[key] != null && year[key] != null
      ? computeInflationAdjustedDelta(cur[key], year[key], currentIndex, prevYearIndex)
      : null;
    return { value: cur[key], vsPrev: pctDelta(cur[key], prev[key]), vsYear: adj ? adj.pct : pctDelta(cur[key], year[key]), yearAdjusted: !!adj };
  };

  const may = computeTotals((curDocs || []).filter(d => d.channel === 'mayorista'));
  const sources = SOURCES.map(({ id, label }) => {
    const t = computeTotals((curDocs || []).filter(d => d.channel === id));
    return { id, label, revenue: t.revenue, orders: t.orders, sharePct: cur.revenue ? round((t.revenue / cur.revenue) * 100) : 0 };
  });
  return {
    kpis: { revenue: kpi('revenue'), orders: kpi('orders'), avgTicket: kpi('avgTicket'), units: kpi('units') },
    collected: { invoiced: may.revenue, collected: may.amountCollected, rate: may.revenue ? may.collectionRate : null },
    sources,
  };
}

// Feria sales per Odoo sales team (one team per fair). Docs synced before the
// team was stored land in "Sin equipo" instead of being dropped.
export function feriaTeams(curDocs) {
  const by = new Map();
  let total = 0;
  for (const d of curDocs || []) {
    if (d.channel !== 'feria' || d.status !== 'completed') continue;
    const team = d.team || 'Sin equipo';
    const t = by.get(team) ?? { team, revenue: 0, orders: 0 };
    t.revenue += d.total;
    t.orders += 1;
    total += d.total;
    by.set(team, t);
  }
  return [...by.values()]
    .map(t => ({ ...t, sharePct: total ? round((t.revenue / total) * 100) : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
}
