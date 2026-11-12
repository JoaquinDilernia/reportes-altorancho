import { money, pct, toneOf } from '../format.js';

const PREV_LABEL = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };
const BLOCKS = [
  ['meta', 'Meta', '#1877F2'],
  ['google', 'Google', '#EA4335'],
  ['total', 'Total pauta', '#353434'],
];
const roasText = (v) => (v == null ? '—' : `${v.toLocaleString('es-AR', { maximumFractionDigits: 2 })}x`);
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

function Pills({ vsPrev, vsYear, period, yearLabel, kind, invert = false }) {
  // For costs a rise is bad: flip the tone.
  const tone = (v) => toneOf(v == null ? v : invert ? -v : v);
  return (
    <span className="nv-pills">
      <span className={`nv-pill ${tone(vsPrev)}`}>{pct(vsPrev, { sign: true })} {PREV_LABEL[period]}</span>
      <span className={`nv-pill ${tone(vsYear)}`} title={kind === 'nominal' ? 'Todavía no hay índice de inflación para este mes: variación nominal' : undefined}>
        {vsYear == null ? `sin ${yearLabel}` : [pct(vsYear, { sign: true }), kind, yearLabel].filter(Boolean).join(' ')}
      </span>
    </span>
  );
}

function Block({ id, label, color, b, period, yearLabel }) {
  const kind = b.yearAdjusted ? 'ajust.' : 'nominal';
  const lines = [
    ['Valor atribuido', money(b.value), 'value', kind, false],
    ['ROAS', roasText(b.roas), 'roas', '', false],
    ['Costo por compra', money(b.costPerPurchase), 'costPerPurchase', kind, true],
  ];
  return (
    <div className={`nv-card nv-loc${id === 'total' ? ' nv-loc-total' : ''}`} style={{ borderTopColor: color }}>
      <div className="nv-loc-head"><span className="nv-lbl">{label}</span><span className="nv-mute">inversión</span></div>
      <div className="nv-big">{money(b.spend)}</div>
      <Pills vsPrev={b.vsPrev.spend} vsYear={b.vsYear.spend} period={period} yearLabel={yearLabel} kind={kind} invert />
      <dl className="nv-loc-lines">
        {lines.map(([l, v, key, k, inv]) => (
          <div key={key}>
            <dt>{l} <b>{v}</b></dt>
            <dd><Pills vsPrev={b.vsPrev[key]} vsYear={b.vsYear[key]} period={period} yearLabel={yearLabel} kind={k} invert={inv} /></dd>
          </div>
        ))}
        {id === 'google' && (
          <div>
            <dt title="Sin las campañas de búsqueda de marca (_brand_), que inflan el ROAS">Sin marca: ROAS <b>{roasText(b.nonBrand.roas)}</b></dt>
            <dd className="nv-mute">marca: {money(b.brand.spend)} invertidos · {money(b.brand.value)} de valor</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export default function AdsBlocks({ summary, period, prevYear, prevRange }) {
  const yearLabel = prevRange.partial ? `${prevYear} al ${ddmm(prevRange.end)}` : String(prevYear);
  return (
    <div className="nv-locs nv-ads3">
      {BLOCKS.map(([id, label, color]) => (
        <Block key={id} id={id} label={label} color={color} b={summary[id]} period={period} yearLabel={yearLabel} />
      ))}
    </div>
  );
}

export { roasText };
