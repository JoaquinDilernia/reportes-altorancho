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
