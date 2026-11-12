import { money, num, pct, toneOf } from '../format.js';

const PREV_LABEL = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };
const KPIS = [
  ['revenue', 'Facturación', money],
  ['orders', 'Pedidos', num],
  ['avgTicket', 'Ticket promedio', money],
  ['units', 'Unidades', num],
];
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

export default function MayoristaKpis({ summary, period, prevYear, prevRange }) {
  const yearLabel = prevRange.partial ? `${prevYear} al ${ddmm(prevRange.end)}` : String(prevYear);
  const c = summary.collected;
  return (
    <div className="nv-kpis">
      {KPIS.map(([id, label, fmt]) => {
        const k = summary.kpis[id];
        const kind = ['revenue', 'avgTicket'].includes(id) ? (k.yearAdjusted ? 'ajust.' : 'nominal') : '';
        return (
          <div className="nv-card nv-kpi" key={id}>
            <div className="nv-lbl">{label}</div>
            <div className="nv-big">{fmt(k.value)}</div>
            <div className="nv-pills">
              <span className={`nv-pill ${toneOf(k.vsPrev)}`}>{pct(k.vsPrev, { sign: true })} {PREV_LABEL[period]}</span>
              <span className={`nv-pill ${toneOf(k.vsYear)}`} title={kind === 'nominal' ? 'Todavía no hay índice de inflación para este mes: variación nominal' : undefined}>
                {[pct(k.vsYear, { sign: true }), kind, yearLabel].filter(Boolean).join(' ')}
              </span>
            </div>
          </div>
        );
      })}
      <div className="nv-card nv-kpi" title="Lo cobrado de las facturas de los pedidos mayoristas del período, contra lo facturado. Las ferias no se cuentan acá.">
        <div className="nv-lbl">Cobrado</div>
        <div className="nv-big">{money(c.collected)}</div>
        <div className="nv-pills">
          <span className={`nv-pill ${c.rate == null ? 'nt' : c.rate >= 80 ? 'up' : c.rate >= 50 ? 'nt' : 'dn'}`}>{pct(c.rate)} de {money(c.invoiced)}</span>
        </div>
        <div className="nv-mute nv-kpinote">solo mayorista, sin ferias</div>
      </div>
    </div>
  );
}
