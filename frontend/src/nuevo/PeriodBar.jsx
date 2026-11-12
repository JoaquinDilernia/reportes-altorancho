import { shiftPeriod, formatPeriodLabel } from '../lib/periods.js';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function shortDate(iso, withYear) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prevYearOf({ period, date, start }) {
  return Number((period === 'custom' ? start : date).slice(0, 4)) - 1;
}

export default function PeriodBar({ state, today, onChange }) {
  const { period, date, start, end } = state;
  const setPeriod = (p) => {
    if (p === period) return;
    if (p === 'custom') onChange({ period: p, start: start ?? addDays(today, -6), end: end ?? today });
    else onChange({ period: p, date: date ?? today });
  };
  const label = period === 'custom'
    ? `${shortDate(start, start.slice(0, 4) !== end.slice(0, 4))} – ${shortDate(end, true)}`
    : formatPeriodLabel(date, period);

  return (
    <div className="nv-bar">
      <div className="nv-seg" role="group" aria-label="Período">
        {[['week', 'Semana'], ['month', 'Mes'], ['custom', 'Rango']].map(([id, text]) => (
          <button key={id} type="button" className={period === id ? 'on' : ''} aria-pressed={period === id} onClick={() => setPeriod(id)}>{text}</button>
        ))}
      </div>
      {period !== 'custom' ? (
        <div className="nv-nav-period">
          <button type="button" aria-label="Anterior" onClick={() => onChange({ date: shiftPeriod(date, period, -1) })}>‹</button>
          <span className="nv-range">{label}</span>
          <button type="button" aria-label="Siguiente" onClick={() => onChange({ date: shiftPeriod(date, period, 1) })}>›</button>
        </div>
      ) : (
        <div className="nv-dates">
          <input type="date" value={start} max={end} aria-label="Desde" onChange={(e) => e.target.value && e.target.value <= end && onChange({ start: e.target.value })} />
          <span>a</span>
          <input type="date" value={end} min={start} aria-label="Hasta" onChange={(e) => e.target.value && e.target.value >= start && onChange({ end: e.target.value })} />
          <span className="nv-range">{label}</span>
        </div>
      )}
      <div className="nv-cmp">
        Comparando con: período anterior · mismo período {prevYearOf(state)} (ajustado por inflación)
      </div>
    </div>
  );
}
