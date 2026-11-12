import { money, num, pct, toneOf } from '../format.js';
import { GROUPS } from '../resumen/ChannelsCard.jsx';
import { upt } from './localesFormat.js';

const PREV_LABEL = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };
const COLOR = Object.fromEntries(GROUPS.map(g => [g.id, g.color]));
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

function Pills({ vsPrev, vsYear, period, yearLabel, kind }) {
  return (
    <span className="nv-pills">
      <span className={`nv-pill ${toneOf(vsPrev)}`}>{pct(vsPrev, { sign: true })} {PREV_LABEL[period]}</span>
      <span
        className={`nv-pill ${toneOf(vsYear)}`}
        title={kind === 'nominal' ? 'Todavía no hay índice de inflación para este mes: variación nominal' : undefined}
      >
        {vsYear == null ? `sin ${yearLabel}` : [pct(vsYear, { sign: true }), kind, yearLabel].filter(Boolean).join(' ')}
      </span>
    </span>
  );
}

function Card({ l, period, yearLabel, total }) {
  const kind = l.yearAdjusted ? 'ajust.' : 'nominal';
  const lines = [
    ['Tickets', num(l.orders), 'orders', ''],
    ['Ticket promedio', money(l.avgTicket), 'avgTicket', kind],
    ['Unid. por ticket', upt(l.unitsPerTicket), 'unitsPerTicket', ''],
  ];
  return (
    <div className={`nv-card nv-loc${total ? ' nv-loc-total' : ''}`} style={{ borderTopColor: COLOR[l.id] ?? '#353434' }}>
      <div className="nv-loc-head">
        <span className="nv-lbl">{l.label}</span>
        {!total && <span className="nv-mute">{pct(l.sharePct)} de locales</span>}
      </div>
      <div className="nv-big">{money(l.revenue)}</div>
      <Pills vsPrev={l.vsPrev.revenue} vsYear={l.vsYear.revenue} period={period} yearLabel={yearLabel} kind={kind} />
      <dl className="nv-loc-lines">
        {lines.map(([label, value, key, k]) => (
          <div key={key}>
            <dt>{label} <b>{value}</b></dt>
            <dd><Pills vsPrev={l.vsPrev[key]} vsYear={l.vsYear[key]} period={period} yearLabel={yearLabel} kind={k} /></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function CompareCards({ compare, period, prevYear, prevRange }) {
  const yearLabel = prevRange.partial ? `${prevYear} al ${ddmm(prevRange.end)}` : String(prevYear);
  return (
    <div className="nv-locs">
      {compare.locales.map(l => <Card key={l.id} l={l} period={period} yearLabel={yearLabel} />)}
      <Card l={compare.total} period={period} yearLabel={yearLabel} total />
    </div>
  );
}
