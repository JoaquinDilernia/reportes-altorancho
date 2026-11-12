import { money } from '../format.js';
import { roasText } from './AdsBlocks.jsx';

const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const META = '#1877F2';
const GOOGLE = '#EA4335';

function labelOf(key, bucket, many) {
  const d = new Date(`${key}T00:00:00Z`);
  if (bucket === 'week') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return many ? String(d.getUTCDate()) : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

function tip(r, bucket) {
  const spend = r.meta.spend + r.google.spend;
  const value = r.meta.value + r.google.value;
  return [
    bucket === 'week' ? `Semana del ${labelOf(r.key, 'week')}` : r.key.split('-').reverse().join('/'),
    `Inversión ${money(spend)} · ROAS ${roasText(spend ? value / spend : null)}`,
    `Meta ${money(r.meta.spend)} (ROAS ${roasText(r.meta.spend ? r.meta.value / r.meta.spend : null)})`,
    `Google ${money(r.google.spend)} (ROAS ${roasText(r.google.spend ? r.google.value / r.google.spend : null)})`,
  ].join('\n');
}

export default function AdsDaily({ daily }) {
  const { bucket, rows } = daily;
  const max = Math.max(1, ...rows.map(r => r.meta.spend + r.google.spend));
  const many = rows.length > 14;
  const every = rows.length > 21 ? 3 : rows.length > 14 ? 2 : 1;
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Inversión por {bucket === 'week' ? 'semana' : 'día'}</h2><span>Meta y Google apilados · pasá el mouse para ver el ROAS</span></div>
      <div className={`nv-chart${many ? ' many' : ''}`}>
        {rows.map(r => {
          const spend = r.meta.spend + r.google.spend;
          return (
            <div className="nv-col" key={r.key} title={tip(r, bucket)}>
              <div className="nv-stack" style={{ height: `${(spend / max) * 100}%` }}>
                {r.meta.spend > 0 && <s style={{ flexGrow: r.meta.spend, background: META }} />}
                {r.google.spend > 0 && <s style={{ flexGrow: r.google.spend, background: GOOGLE }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className={`nv-days${many ? ' many' : ''}`}>
        {rows.map((r, i) => <span key={r.key}>{i % every === 0 ? labelOf(r.key, bucket, many) : ''}</span>)}
      </div>
      <div className="nv-legend">
        <span><span className="nv-dot" style={{ background: META }} />Meta</span>
        <span><span className="nv-dot" style={{ background: GOOGLE }} />Google</span>
      </div>
    </section>
  );
}
