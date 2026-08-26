import { formatCurrency, formatNumber, formatRate, formatPercent } from '../lib/format.js';
import DeltaBadge from './DeltaBadge.jsx';

export const SALES_METRICS = [
  { key: 'revenue', label: 'Facturación', format: formatCurrency, inflationAdjustable: true },
  { key: 'shippingRevenue', label: 'Envíos facturados', format: formatCurrency, inflationAdjustable: true },
  { key: 'avgDailyRevenue', label: 'Facturación promedio diaria', format: formatCurrency, inflationAdjustable: true },
  { key: 'orders', label: 'Ventas', format: formatNumber },
  { key: 'units', label: 'Unidades', format: formatNumber },
  { key: 'avgTicket', label: 'Ticket promedio', format: formatCurrency, inflationAdjustable: true },
  { key: 'cancellationRate', label: 'Tasa de cancelación', format: formatRate, invert: true },
];

const COMPARISON_LABELS = {
  prevPeriod: 'vs. período anterior',
  prevMonth: 'vs. mes anterior',
  prevYear: 'vs. año anterior',
};

// Meta Ads' KpiCards call passes deltasKey="metaAdsDeltas" — its inflation-
// adjusted counterpart lives under a matching key on comparisons.prevYear.
const INFLATION_ADJUSTED_KEY_BY_DELTAS_KEY = {
  deltas: 'deltasInflationAdjusted',
  metaAdsDeltas: 'metaAdsDeltasInflationAdjusted',
};

export default function KpiCards({ current, comparisons, metrics = SALES_METRICS, deltasKey = 'deltas' }) {
  const inflationAdjustedKey = INFLATION_ADJUSTED_KEY_BY_DELTAS_KEY[deltasKey];
  const inflationRate = comparisons.prevYear.inflationRate;

  return (
    <div className="kpi-cards">
      {metrics.map((metric) => {
        const adjusted = inflationAdjustedKey && comparisons.prevYear[inflationAdjustedKey]?.[metric.key];
        return (
          <div className="kpi-card" key={metric.key}>
            <div className="kpi-label">{metric.label}</div>
            <div className="kpi-value">{metric.format(current[metric.key])}</div>
            <div className="kpi-deltas">
              {Object.entries(COMPARISON_LABELS).map(([key, label]) => (
                <div className="kpi-delta-row" key={key}>
                  <span className="kpi-delta-label">{label}</span>
                  <DeltaBadge pct={comparisons[key][deltasKey][metric.key]?.pct} invert={metric.invert} />
                </div>
              ))}
              {metric.inflationAdjustable && adjusted && (
                <div className="kpi-delta-row kpi-delta-row-adjusted">
                  <span className="kpi-delta-label">
                    vs. año anterior (ajustado inflación{inflationRate != null ? `: ${formatPercent(inflationRate)}` : ''})
                  </span>
                  <DeltaBadge pct={adjusted.pct} invert={metric.invert} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
