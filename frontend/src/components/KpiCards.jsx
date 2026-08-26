import { formatCurrency, formatNumber, formatRate } from '../lib/format.js';
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

export default function KpiCards({ current, comparisons, metrics = SALES_METRICS, deltasKey = 'deltas' }) {
  return (
    <div className="kpi-cards">
      {metrics.map((metric) => (
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
            {metric.inflationAdjustable && comparisons.prevYear.deltasInflationAdjusted?.[metric.key] && (
              <div className="kpi-delta-row kpi-delta-row-adjusted">
                <span className="kpi-delta-label">vs. año ant. (real, ajustado x inflación)</span>
                <DeltaBadge pct={comparisons.prevYear.deltasInflationAdjusted[metric.key].pct} invert={metric.invert} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
