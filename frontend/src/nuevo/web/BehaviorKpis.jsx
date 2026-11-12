import { num, pct, pp, toneOf } from '../format.js';
import { rate, mmss, convPpDelta } from './webFormat.js';

const PREV_LABEL = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };
const delta = (a, b) => (a != null && b ? ((a / b) - 1) * 100 : null);

export default function BehaviorKpis({ totals, period, prevYear }) {
  const { cur, prev, yoy } = totals;
  const prevL = PREV_LABEL[period];
  const items = [
    { label: 'Sesiones', value: num(cur.sessions), d: [delta(cur.sessions, prev.sessions), yoy && delta(cur.sessions, yoy.sessions)], kind: 'pct' },
    {
      label: 'Conversión', value: rate(cur.conversion), kind: 'pp',
      d: [convPpDelta(cur.conversion, prev.conversion), yoy ? convPpDelta(cur.conversion, yoy.conversion) : null],
      title: 'Compras ÷ sesiones (GA4)',
    },
    { label: 'Páginas por sesión', value: cur.pagesPerSession == null ? '—' : cur.pagesPerSession.toLocaleString('es-AR', { maximumFractionDigits: 1 }), d: [delta(cur.pagesPerSession, prev.pagesPerSession), null], kind: 'pct' },
    { label: 'Tiempo por sesión', value: mmss(cur.avgSessionSec), d: [delta(cur.avgSessionSec, prev.avgSessionSec), null], kind: 'pct' },
  ];
  const fmt = (v, kind) => (kind === 'pp' ? pp(v) : pct(v, { sign: true }));
  const flat = (kind) => (kind === 'pp' ? 0.02 : 0.5);
  return (
    <div className="nv-kpis nv-kpis4">
      {items.map(it => (
        <div className="nv-card nv-kpi" key={it.label} title={it.title}>
          <div className="nv-lbl">{it.label}</div>
          <div className="nv-big">{it.value}</div>
          <div className="nv-pills">
            <span className={`nv-pill ${toneOf(it.d[0], flat(it.kind))}`}>{fmt(it.d[0], it.kind)} {prevL}</span>
            {it.d[1] != null && <span className={`nv-pill ${toneOf(it.d[1], flat(it.kind))}`}>{fmt(it.d[1], it.kind)} {prevYear}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
