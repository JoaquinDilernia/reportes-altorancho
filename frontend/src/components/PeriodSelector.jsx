import { formatPeriodLabel } from '../lib/periods.js';

export default function PeriodSelector({ period, date, onPeriodChange, onNavigate }) {
  return (
    <div className="period-selector">
      <div className="period-toggle">
        <button className={period === 'week' ? 'active' : ''} onClick={() => onPeriodChange('week')}>
          Semana
        </button>
        <button className={period === 'month' ? 'active' : ''} onClick={() => onPeriodChange('month')}>
          Mes
        </button>
      </div>
      <div className="period-nav">
        <button onClick={() => onNavigate(-1)} aria-label="Período anterior">‹</button>
        <span className="period-label">{formatPeriodLabel(date, period)}</span>
        <button onClick={() => onNavigate(1)} aria-label="Período siguiente">›</button>
      </div>
    </div>
  );
}
