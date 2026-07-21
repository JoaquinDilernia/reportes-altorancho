import { formatPeriodLabel } from '../lib/periods.js';

export default function PeriodSelector({
  period, date, onPeriodChange, onNavigate,
  customStart, customEnd, onCustomChange,
}) {
  return (
    <div className="period-selector">
      <div className="period-toggle">
        <button className={period === 'week' ? 'active' : ''} onClick={() => onPeriodChange('week')}>
          Semana
        </button>
        <button className={period === 'month' ? 'active' : ''} onClick={() => onPeriodChange('month')}>
          Mes
        </button>
        <button className={period === 'custom' ? 'active' : ''} onClick={() => onPeriodChange('custom')}>
          Rango
        </button>
      </div>
      {period === 'custom' ? (
        <div className="period-range">
          <input
            type="date"
            value={customStart}
            max={customEnd}
            onChange={(e) => onCustomChange(e.target.value, customEnd)}
            aria-label="Desde"
          />
          <span>–</span>
          <input
            type="date"
            value={customEnd}
            min={customStart}
            onChange={(e) => onCustomChange(customStart, e.target.value)}
            aria-label="Hasta"
          />
        </div>
      ) : (
        <div className="period-nav">
          <button onClick={() => onNavigate(-1)} aria-label="Período anterior">‹</button>
          <span className="period-label">{formatPeriodLabel(date, period)}</span>
          <button onClick={() => onNavigate(1)} aria-label="Período siguiente">›</button>
        </div>
      )}
    </div>
  );
}
