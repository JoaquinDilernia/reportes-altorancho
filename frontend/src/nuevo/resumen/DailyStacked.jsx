import { GROUPS } from './ChannelsCard.jsx';
import { money } from '../format.js';

const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function labelOf(key, bucket, many) {
  const d = new Date(`${key}T00:00:00Z`);
  if (bucket === 'week') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return many ? String(d.getUTCDate()) : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

function tooltip(row, bucket, prevYear, groups, prevLabel) {
  const head = bucket === 'week' ? `Semana del ${labelOf(row.key, 'week')}` : row.key.split('-').reverse().join('/');
  const lines = groups.filter(g => row.byChannel[g.id]).map(g => `${g.label}: ${money(row.byChannel[g.id])}`);
  return [head, `Total: ${money(row.total)}`, ...lines, `${prevYear} ${prevLabel}: ${money(row.prevYearAdj)}`].join('\n');
}

// `groups` limits the channels drawn (the Web tab passes only web).
export default function DailyStacked({ daily, prevYear, groups = GROUPS, subtitle = 'apilado por canal', prevLabel = 'ajustado' }) {
  const { bucket, rows } = daily;
  const max = Math.max(...rows.map(r => Math.max(r.total, r.prevYearAdj)), 1);
  const many = rows.length > 14;
  // With many bars, label every few so they don't collide.
  const every = rows.length > 21 ? 3 : rows.length > 14 ? 2 : 1;
  return (
    <section className="nv-card">
      <div className="nv-h">
        <h2>Facturación por {bucket === 'week' ? 'semana' : 'día'}</h2>
        <span>{subtitle} · marca punteada = mismo {bucket === 'week' ? 'período' : 'día'} {prevYear} {prevLabel}</span>
      </div>
      <div className={`nv-chart${many ? ' many' : ''}`}>
        {rows.map(r => (
          <div className="nv-col" key={r.key} title={tooltip(r, bucket, prevYear, groups, prevLabel)}>
            <div className="nv-stack" style={{ height: `${(r.total / max) * 100}%` }}>
              {groups.map(g => (r.byChannel[g.id] > 0 ? (
                <s key={g.id} style={{ flexGrow: r.byChannel[g.id], background: g.color }} />
              ) : null))}
            </div>
            {r.prevYearAdj > 0 && <em style={{ bottom: `${(r.prevYearAdj / max) * 100}%` }} />}
          </div>
        ))}
      </div>
      <div className={`nv-days${many ? ' many' : ''}`}>
        {rows.map((r, i) => <span key={r.key}>{i % every === 0 ? labelOf(r.key, bucket, many) : ''}</span>)}
      </div>
      <div className="nv-legend">
        {groups.map(g => <span key={g.id}><span className="nv-dot" style={{ background: g.color }} />{g.label}</span>)}
        <span><span className="nv-dash" />{prevYear} {prevLabel}</span>
      </div>
    </section>
  );
}
