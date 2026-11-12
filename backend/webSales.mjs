// Web tab: Odoo ecommerce sales (the revenue always comes from Odoo; GA4 only
// brings behaviour). Pure — the IO lives in webReport.mjs.
import { computeTotals, computeDelta, computeInflationAdjustedDelta } from './aggregate.mjs';
import { dailyStacked } from './resumen.mjs';

const webOnly = (docs) => (docs || []).filter(d => d.channel === 'ecommerce');
const MONEY = new Set(['revenue', 'avgTicket']);

export function webSalesSummary({ curDocs, prevDocs, prevYearDocs, range, inflation = {}, prevYearFactor }) {
  const cur = computeTotals(webOnly(curDocs));
  const prev = computeTotals(webOnly(prevDocs));
  const year = computeTotals(webOnly(prevYearDocs));
  const { currentIndex, prevYearIndex } = inflation;
  const kpi = (key) => {
    const adjusted = MONEY.has(key) ? computeInflationAdjustedDelta(cur[key], year[key], currentIndex, prevYearIndex) : null;
    return {
      value: cur[key],
      vsPrev: computeDelta(cur[key], prev[key]).pct,
      vsYear: adjusted ? adjusted.pct : computeDelta(cur[key], year[key]).pct,
      yearAdjusted: !!adjusted,
    };
  };
  return {
    kpis: { revenue: kpi('revenue'), orders: kpi('orders'), units: kpi('units'), avgTicket: kpi('avgTicket') },
    daily: dailyStacked(webOnly(curDocs), webOnly(prevYearDocs), { ...range, prevYearFactor }),
  };
}
