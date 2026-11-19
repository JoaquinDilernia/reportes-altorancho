import { useState } from 'react';
import { money, pct, toneOf } from '../format.js';
import { times, perPeso, VERDICT, SOURCE_LABEL, SOURCE_COLOR } from './prFormat.js';

const PREV = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };

function Delta({ v, period, sense = 'up' }) {
  const tone = sense === 'none' ? 'nt' : toneOf(v == null ? v : sense === 'down' ? -v : v);
  return <span className={`nv-pill ${tone}`}>{v == null ? 'sin dato' : `${pct(v, { sign: true })} ${PREV[period]}`}</span>;
}

export function VerdictTag({ verdict }) {
  const v = VERDICT[verdict];
  if (!v) return null;
  return <span className={`nv-pr-verdict ${v.tone}`} title={v.hint}>{v.label}</span>;
}

// La respuesta en una línea, antes que cualquier número.
export function Headline({ h, period }) {
  const won = h.profitAfterAds >= 0;
  return (
    <section className="nv-card nv-pr-hero">
      <p className="nv-pr-say">
        Invertimos <b>{money(h.spend)}</b> en pauta y el negocio vendió <b>{money(h.revenue)}</b>.
        {' '}Después de pagar la mercadería y la pauta {won ? 'quedaron' : 'faltaron'} <b className={won ? 'up' : 'dn'}>{money(Math.abs(h.profitAfterAds))}</b>.
      </p>
      <div className="nv-pr-kpis">
        <Kpi label="Inversión en pauta" value={money(h.spend)} note="Meta + Google" delta={<Delta v={h.vsPrev?.spend} period={period} sense="none" />} />
        <Kpi label="Ventas totales" value={money(h.revenue)} note={`Web ${money(h.web.revenue)} · Locales ${money(h.locales.revenue)}`} delta={<Delta v={h.vsPrev?.revenue} period={period} />} />
        <Kpi label="Ganancia bruta" value={money(h.grossProfit)} note={`Margen ${pct(h.marginPct)} sobre el costo de Odoo`} delta={<Delta v={h.vsPrev?.grossProfit} period={period} />} />
        <Kpi label="Ganancia después de pauta" value={money(h.profitAfterAds)} strong note="Ganancia bruta − inversión" delta={<Delta v={h.vsPrev?.profitAfterAds} period={period} />} />
        <Kpi label="Por cada $1 de pauta" value={perPeso(h.merTotal)} note={`de ventas totales · ${perPeso(h.merWeb)} solo web`} delta={<Delta v={h.vsPrev?.merTotal} period={period} />} />
      </div>
      <div className="nv-pr-share">
        <div className="nv-pr-sharebar" role="img" aria-label={`La pauta se lleva el ${pct(h.adsShareOfRevenuePct, { decimals: 1 })} de lo vendido`}>
          <span className="spend" style={{ width: `${Math.min(100, h.adsShareOfRevenuePct || 0)}%` }} />
          <span className="cogs" style={{ width: `${Math.max(0, 100 - (h.marginPct || 0))}%` }} />
        </div>
        <div className="nv-legend">
          <span><span className="nv-dot" style={{ background: 'var(--nv-pr-spend)' }} />Pauta: {pct(h.adsShareOfRevenuePct, { decimals: 1 })} de lo vendido</span>
          <span><span className="nv-dot" style={{ background: 'var(--nv-pr-cogs)' }} />Mercadería: {pct(h.marginPct == null ? null : 100 - h.marginPct)}</span>
          <span><span className="nv-dot" style={{ background: 'var(--nv-pr-profit)' }} />Queda: {pct(h.marginPct == null ? null : h.marginPct - (h.adsShareOfRevenuePct || 0), { decimals: 1 })}</span>
        </div>
      </div>
    </section>
  );
}

function Kpi({ label, value, note, delta, strong }) {
  return (
    <div className={`nv-pr-kpi${strong ? ' strong' : ''}`}>
      <span className="nv-lbl">{label}</span>
      <span className="nv-big">{value}</span>
      {delta}
      <span className="nv-mute nv-kpinote">{note}</span>
    </div>
  );
}

const PLATFORM = { meta: { label: 'Meta', color: '#1877F2' }, google: { label: 'Google', color: '#EA4335' } };

// Lo que dice la plataforma vs. lo que llegó a la tienda vs. lo que dejó.
export function TruthCard({ id, p, reported }) {
  const { label, color } = PLATFORM[id];
  if (!p) {
    return (
      <div className="nv-card nv-pr-truth" style={{ borderTopColor: color }}>
        <div className="nv-loc-head"><span className="nv-lbl">{label}</span><span className="nv-mute">inversión {money(reported.spend)}</span></div>
        <div className="nv-pr-steps">
          <Step label={`Lo que dice ${label}`} value={times(reported.spend ? reported.reportedValue / reported.spend : null)} sub={`${money(reported.reportedValue)} en ventas`} />
        </div>
        <p className="nv-note">Falta conectar la atribución para ver cuánto llegó de verdad a la tienda.</p>
      </div>
    );
  }
  const max = Math.max(p.reported.revenue, p.real.revenue, 1);
  return (
    <div className="nv-card nv-pr-truth" style={{ borderTopColor: color }}>
      <div className="nv-loc-head">
        <span className="nv-lbl">{label}</span>
        <VerdictTag verdict={p.verdict} />
      </div>
      <div className="nv-pr-inv">Inversión <b>{money(p.spend)}</b>{p.costPerSale != null && <> · <b>{money(p.costPerSale)}</b> por venta</>}</div>
      <div className="nv-pr-steps">
        <Step label={`Lo que dice ${label}`} value={times(p.reported.roas)} sub={`${money(p.reported.revenue)} en ventas`} bar={p.reported.revenue / max} color="var(--nv-ink3)" />
        <Step label="Lo que llegó a la tienda" value={times(p.real.roas)} sub={`${money(p.real.revenue)} · ${p.real.orders} pedidos`} bar={p.real.revenue / max} color={color} />
        <Step label="Lo que dejó (POAS)" value={times(p.poas)} sub={`ganancia ${money(p.grossProfit)} · neto ${money(p.profitAfterAds)}`} bar={Math.max(0, p.grossProfit) / max} color="var(--nv-pr-profit)" />
      </div>
      {p.overReportPct != null && p.overReportPct > 5 && (
        <p className="nv-note">{label} se adjudica un <b>{pct(p.overReportPct)}</b> más de ventas que las que entraron a la tienda con su clic (cuenta vistas, otros dispositivos y ventas que también reclama otra plataforma).</p>
      )}
    </div>
  );
}

function Step({ label, value, sub, bar, color }) {
  return (
    <div className="nv-pr-step">
      <span className="nv-mute">{label}</span>
      <span className="nv-pr-roas">{value}</span>
      {bar != null && <span className="nv-track"><span style={{ display: 'block', height: '100%', width: `${Math.max(2, bar * 100)}%`, background: color, borderRadius: 4 }} /></span>}
      <span className="nv-mute">{sub}</span>
    </div>
  );
}

// Ventas web por origen
export function Sources({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.revenue));
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>De dónde vinieron las ventas web</h2><span>último clic antes de comprar, según la tienda</span></div>
      {rows.map((r) => (
        <div className="nv-chrow nv-pr-srcrow" key={r.channel}>
          <span className="nv-chname"><span className="nv-dot" style={{ background: SOURCE_COLOR[r.channel] || '#9a9897' }} />{SOURCE_LABEL[r.channel] || r.channel}</span>
          <span className="nv-track"><span style={{ display: 'block', height: '100%', width: `${(r.revenue / max) * 100}%`, background: SOURCE_COLOR[r.channel] || '#9a9897', borderRadius: 4 }} /></span>
          <b>{money(r.revenue)}</b>
          <span className="nv-mute">{pct(r.sharePct)}</span>
        </div>
      ))}
    </section>
  );
}

// Por día: ganancia bruta partida en lo que se llevó la pauta y lo que quedó.
export function ProfitDaily({ rows }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.grossProfit, r.spend)));
  const many = rows.length > 14;
  const every = rows.length > 21 ? 3 : rows.length > 14 ? 2 : 1;
  const day = (d) => Number(d.slice(8));
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Ganancia por día</h2><span>cada barra es la ganancia bruta del día · pasá el mouse para el detalle</span></div>
      <div className={`nv-chart${many ? ' many' : ''}`}>
        {rows.map((r) => {
          const kept = Math.max(0, r.profitAfterAds);
          const ads = Math.min(r.spend, Math.max(0, r.grossProfit));
          const over = Math.max(0, r.spend - Math.max(0, r.grossProfit));
          const tip = [
            r.date.split('-').reverse().join('/'),
            `Ventas ${money(r.web + r.locales)} (web ${money(r.web)} · locales ${money(r.locales)})`,
            `Ganancia bruta ${money(r.grossProfit)}`,
            `Pauta ${money(r.spend)}`,
            `Queda ${money(r.profitAfterAds)}`,
          ].join('\n');
          return (
            <div className="nv-col" key={r.date} title={tip}>
              <div className="nv-stack nv-pr-stack" style={{ height: `${((kept + ads + over) / max) * 100}%` }}>
                {kept > 0 && <s style={{ flexGrow: kept, background: 'var(--nv-pr-profit)' }} />}
                {ads > 0 && <s style={{ flexGrow: ads, background: 'var(--nv-pr-spend)' }} />}
                {over > 0 && <s style={{ flexGrow: over, background: 'var(--nv-dn)' }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className={`nv-days${many ? ' many' : ''}`}>
        {rows.map((r, i) => <span key={r.date}>{i % every === 0 ? day(r.date) : ''}</span>)}
      </div>
      <div className="nv-legend">
        <span><span className="nv-dot" style={{ background: 'var(--nv-pr-profit)' }} />Queda después de pauta</span>
        <span><span className="nv-dot" style={{ background: 'var(--nv-pr-spend)' }} />Se lo lleva la pauta</span>
        <span><span className="nv-dot" style={{ background: 'var(--nv-dn)' }} />Pauta que no se cubrió</span>
      </div>
    </section>
  );
}

export function Glossary() {
  return (
    <section className="nv-card nv-sec nv-pr-gloss">
      <div className="nv-h"><h2>Cómo leer este tablero</h2></div>
      <dl>
        <div><dt>Lo que dice la plataforma</dt><dd>El ROAS que muestran Meta y Google. Cuentan ventas que vieron con su píxel, incluso de gente que solo vio el anuncio, y las dos se adjudican la misma venta.</dd></div>
        <div><dt>Lo que llegó a la tienda (ROAS real)</dt><dd>Solo los pedidos pagos de Tienda Nube donde el último clic antes de comprar fue de ese anuncio.</dd></div>
        <div><dt>Lo que dejó (POAS)</dt><dd>La ganancia de esas ventas (precio − costo de Odoo) dividida lo invertido. Por encima de 1 la pauta se paga sola.</dd></div>
        <div><dt>Por cada $1 de pauta</dt><dd>Ventas totales (web + locales) sobre la inversión. Sirve para ver la tendencia: la pauta también trae gente al local, aunque esa venta no tenga clic.</dd></div>
      </dl>
      <p className="nv-note">Montos con IVA. La inversión es la que informa cada plataforma, sin impuestos. El envío que paga el cliente cuenta como venta.</p>
    </section>
  );
}

// Pinterest y Perfit: sin API de gasto todavía. El costo se carga por mes
// (Pinterest: gasto del Administrador de anuncios; Perfit: el abono) y se
// prorratea por día. Mismo criterio de "lo que llegó": último clic antes de comprar.
const OTHER = {
  pinterest: { label: 'Pinterest', color: '#B5176E', costLabel: 'Gasto en anuncios', hint: 'del Administrador de anuncios de Pinterest' },
  email: { label: 'Email (Perfit)', color: '#E0A100', costLabel: 'Abono de Perfit', hint: 'lo que se paga por mes' },
};
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function CostEditor({ cost, label, onSave }) {
  const [value, setValue] = useState(cost.monthly ?? '');
  const [state, setState] = useState({ saving: false, error: null });
  const save = async (e) => {
    e.preventDefault();
    const n = Number(String(value).replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) { setState({ saving: false, error: 'Poné un monto en pesos' }); return; }
    setState({ saving: true, error: null });
    try {
      await onSave({ key: cost.key, month: cost.month, value: n });
    } catch (err) {
      setState({ saving: false, error: err.message });
    }
  };
  return (
    <form className="nv-pr-cost" onSubmit={save}>
      <label>
        <span className="nv-mute">{label} de {monthName(cost.month)}</span>
        <input type="text" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="$ del mes" aria-label={`${label} de ${monthName(cost.month)}`} />
      </label>
      <button type="submit" className="nv-btn" disabled={state.saving}>{state.saving ? 'Guardando…' : 'Guardar'}</button>
      {state.error && <span className="nv-red">{state.error}</span>}
    </form>
  );
}

export function OtherCard({ id, p, onSaveCost }) {
  const { label, color, costLabel, hint } = OTHER[id];
  const [editing, setEditing] = useState(false);
  const noCost = p.spend == null;
  const max = Math.max(p.real.revenue, Math.max(0, p.grossProfit), 1);
  const save = async (args) => { await onSaveCost(args); setEditing(false); };
  return (
    <div className="nv-card nv-pr-truth" style={{ borderTopColor: color }}>
      <div className="nv-loc-head">
        <span className="nv-lbl">{label}</span>
        <VerdictTag verdict={p.verdict} />
      </div>
      <div className="nv-pr-inv">
        {noCost ? <>{costLabel}: <b>sin cargar</b></> : <>{costLabel} <b>{money(p.spend)}</b>{p.costPerSale != null && <> · <b>{money(p.costPerSale)}</b> por venta</>}</>}
        {' · '}<button type="button" className="nv-link" onClick={() => setEditing((v) => !v)}>{editing ? 'cancelar' : noCost ? 'cargar' : 'cambiar'}</button>
      </div>
      {(editing || noCost) && <CostEditor cost={p.cost} label={costLabel} onSave={save} />}
      <div className="nv-pr-steps">
        <Step label="Lo que llegó a la tienda" value={noCost ? '—' : times(p.real.roas)} sub={`${money(p.real.revenue)} · ${p.real.orders} pedidos`} bar={p.real.revenue / max} color={color} />
        <Step label="Lo que dejó (POAS)" value={noCost ? '—' : times(p.poas)} sub={noCost ? `ganancia ${money(p.grossProfit)}` : `ganancia ${money(p.grossProfit)} · neto ${money(p.profitAfterAds)}`} bar={Math.max(0, p.grossProfit) / max} color="var(--nv-pr-profit)" />
      </div>
      <p className="nv-note">
        {noCost
          ? `Cargá el ${costLabel.toLowerCase()} de ${monthName(p.cost.month)} (${hint}) para ver ROAS y POAS. `
          : `${costLabel} ${hint}, repartido por día del período. `}
        Cuenta solo las compras de quien entró con un clic de {id === 'email' ? 'un mail' : 'un anuncio'} en esa visita.
      </p>
    </div>
  );
}
