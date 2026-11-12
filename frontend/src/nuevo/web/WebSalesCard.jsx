import { money, num, pct, toneOf } from '../format.js';
import DailyStacked from '../resumen/DailyStacked.jsx';
import { GROUPS } from '../resumen/ChannelsCard.jsx';

const PREV_LABEL = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };
const KPIS = [
  ['revenue', 'Facturación web', money],
  ['orders', 'Pedidos', num],
  ['avgTicket', 'Ticket promedio', money],
  ['units', 'Unidades', num],
];
const WEB_ONLY = GROUPS.filter(g => g.id === 'web');
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

export default function WebSalesCard({ sales, period, prevYear, prevRange }) {
  const yearLabel = prevRange.partial ? `${prevYear} al ${ddmm(prevRange.end)}` : String(prevYear);
  return (
    <>
      <div className="nv-kpis nv-kpis4">
        {KPIS.map(([id, label, fmt]) => {
          const k = sales.kpis[id];
          const kind = ['revenue', 'avgTicket'].includes(id) ? (k.yearAdjusted ? 'ajust.' : 'nominal') : '';
          return (
            <div className="nv-card nv-kpi" key={id}>
              <div className="nv-lbl">{label}</div>
              <div className="nv-big">{fmt(k.value)}</div>
              <div className="nv-pills">
                <span className={`nv-pill ${toneOf(k.vsPrev)}`}>{pct(k.vsPrev, { sign: true })} {PREV_LABEL[period]}</span>
                <span
                  className={`nv-pill ${toneOf(k.vsYear)}`}
                  title={kind === 'nominal' ? 'Todavía no hay índice de inflación publicado para este mes: variación nominal' : undefined}
                >
                  {pct(k.vsYear, { sign: true })} {kind} {yearLabel}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <DailyStacked daily={sales.daily} prevYear={prevYear} groups={WEB_ONLY} subtitle="venta web de Odoo" />
    </>
  );
}
