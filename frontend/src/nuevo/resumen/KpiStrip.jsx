import Sparkline from './Sparkline.jsx';
import { money, num, pct, pp, toneOf } from '../format.js';

const PREV_LABEL = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };

const KPI = {
  revenue: { label: 'Facturación', value: money },
  orders: { label: 'Ventas', value: num },
  avgTicket: { label: 'Ticket promedio', value: money },
  conversion: { label: 'Conversión web', value: (v) => pct(v, { decimals: 2 }) },
  adSpend: { label: 'Inversión en pauta', value: money },
};

const Pill = ({ tone = 'nt', children, title }) => <span className={`nv-pill ${tone}`} title={title}>{children}</span>;
const roas = (v) => (v == null ? '—' : `${v.toLocaleString('es-AR', { maximumFractionDigits: 1 })}x`);

function Pills({ k, period, prevYear }) {
  const prev = PREV_LABEL[period];
  if (k.id === 'conversion') {
    if (k.value == null) return <Pill>Sin datos de GA4</Pill>;
    return (
      <>
        <Pill tone={toneOf(k.vsPrev, 0.02)}>{pp(k.vsPrev)} {prev}</Pill>
        <Pill tone={toneOf(k.vsYear, 0.02)}>{pp(k.vsYear)} {prevYear}</Pill>
      </>
    );
  }
  if (k.id === 'adSpend') {
    const r = k.extra?.roas;
    const rp = k.extra?.roasPrev;
    const diff = r != null && rp != null ? r - rp : null;
    return (
      <>
        <Pill title="Valor de compras atribuido ÷ inversión (Meta + Google, incluida la búsqueda de marca)">ROAS {roas(r)}</Pill>
        {diff != null && <Pill tone={toneOf(diff, 0.1)}>{diff > 0 ? '+' : diff < 0 ? '−' : ''}{roas(Math.abs(diff))} {prev}</Pill>}
        <Pill>{pct(k.vsPrev, { sign: true })} inversión</Pill>
      </>
    );
  }
  return (
    <>
      <Pill tone={toneOf(k.vsPrev)}>{pct(k.vsPrev, { sign: true })} {prev}</Pill>
      {k.vsYearKind && (
        <Pill
          tone={toneOf(k.vsYear)}
          title={k.vsYearKind === 'nominal' ? 'Sin índice de inflación publicado para comparar: variación nominal' : 'Ajustado por inflación (INDEC)'}
        >
          {pct(k.vsYear, { sign: true })} {k.vsYearKind} {prevYear}
        </Pill>
      )}
    </>
  );
}

export default function KpiStrip({ kpis, period, prevYear }) {
  return (
    <div className="nv-kpis">
      {kpis.map(k => (
        <div className="nv-card nv-kpi" key={k.id}>
          <div className="nv-lbl">{KPI[k.id].label}</div>
          <div className="nv-big">{KPI[k.id].value(k.value)}</div>
          <div className="nv-pills"><Pills k={k} period={period} prevYear={prevYear} /></div>
          <Sparkline values={k.spark} label={`Tendencia de ${KPI[k.id].label.toLowerCase()}`} />
        </div>
      ))}
    </div>
  );
}
