import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { formatCurrency } from '../lib/format.js';

// Validated as a pair (CVD + contrast) on the beige card surface.
const META_COLOR = '#1877F2';
const GOOGLE_COLOR = '#C26A00';
const PREV_YEAR_COLOR = '#A9B4C2';

const PHASE_LABELS = { pre: 'Pre-Cyber', oficial: 'Días oficiales', extension: 'Extensión' };
const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function shortDate(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

function dayLabel(dateStr) {
  return `${WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]} ${shortDate(dateStr)}`;
}

function millions(v) {
  if (v == null) return '—';
  return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
}

function times(v) {
  return v == null ? '—' : `${v.toFixed(1)}x`;
}

const ratio = (value, spend) => (spend ? value / spend : null);

const legendInk = (value) => <span style={{ color: 'var(--ink-primary)' }}>{value}</span>;

// One-line reason for each phase's split, built from last year's numbers.
function phaseReason(p) {
  const { meta, google } = p.prev;
  if (meta.lift == null || google.lift == null) return 'Sin datos de 2025 para esta fase: reparto 50/50.';
  const better = meta.lift > google.lift ? 'Meta' : 'Google';
  const diff = Math.abs(meta.lift - google.lift) / Math.min(meta.lift, google.lift);
  const head = `En 2025 el ROAS de Meta se multiplicó ×${meta.lift.toFixed(1)} y el de Google ×${google.lift.toFixed(1)} contra semanas normales`;
  return diff < 0.1
    ? `${head}: respondieron parecido, va mitad y mitad.`
    : `${head}: ${better} respondió mejor y se lleva más presupuesto.`;
}

function ScaleWarning({ scale }) {
  const big = Object.entries(scale || {}).filter(([, s]) => s != null && s >= 2);
  if (!big.length) return null;
  return (
    <div className="invest-warning">
      {big.map(([p, s]) => `${p === 'meta' ? 'Meta' : 'Google'} invierte ${s.toFixed(1)} veces lo de 2025 (en pesos de hoy)`).join(' · ')}
      : el ROAS del año pasado puede no sostenerse a esa escala, mirar el día a día.
    </div>
  );
}

function PhaseCards({ phases }) {
  return (
    <div className="invest-phases">
      {phases.filter(p => p.days > 0).map(p => (
        <div className="kpi-card invest-phase" key={p.phase}>
          <div className="kpi-label">{PHASE_LABELS[p.phase]} · {p.days} {p.days === 1 ? 'día' : 'días'}</div>
          <div className="kpi-value">{millions(p.plan.spend)}</div>
          <div className="invest-split">
            <span><i style={{ background: META_COLOR }} />Meta {millions(p.plan.meta)} ({Math.round(p.metaShare * 100)}%)</span>
            <span><i style={{ background: GOOGLE_COLOR }} />Google {millions(p.plan.google)} ({Math.round((1 - p.metaShare) * 100)}%)</span>
          </div>
          <div className="kpi-deltas">
            <div className="kpi-delta-row">
              <span className="kpi-delta-label">2025: inversión</span>
              <span>{millions(p.prev.spend)}</span>
            </div>
            <div className="kpi-delta-row">
              <span className="kpi-delta-label">2025: ROAS Meta / Google</span>
              <span>{times(p.prev.meta.roas)} / {times(p.prev.google.roas)}</span>
            </div>
            <div className="kpi-delta-row">
              <span className="kpi-delta-label">2025: venta web por $1 invertido</span>
              <span>{times(p.prev.mer)}</span>
            </div>
          </div>
          <p className="invest-reason">
            {p.splitFromConfig
              ? `Reparto del plan de marketing. La data de 2025 sugería ${Math.round(p.suggestedMetaShare * 100)}% Meta.`
              : phaseReason(p)}
          </p>
          <ScaleWarning scale={p.scale} />
        </div>
      ))}
    </div>
  );
}

function PlanChart({ planDays, days }) {
  const data = planDays.map((d, i) => ({
    label: dayLabel(d.date),
    meta: d.meta,
    google: d.google,
    prev: days[i].ads.prev.meta.spend + days[i].ads.prev.google.spend,
  }));
  return (
    <div className="chart-card">
      <h3 className="chart-title">Inversión propuesta por día</h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="label" stroke="var(--ink-secondary)" fontSize={11} interval={0} angle={-35} textAnchor="end" height={50} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={millions} width={56} />
          <Tooltip formatter={(v) => formatCurrency(v)} />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendInk} />
          <Bar dataKey="meta" name="Meta 2026" stackId="plan" fill={META_COLOR} stroke="var(--surface-card)" strokeWidth={2} />
          <Bar dataKey="google" name="Google 2026" stackId="plan" fill={GOOGLE_COLOR} stroke="var(--surface-card)" strokeWidth={2} radius={[4, 4, 0, 0]} />
          <Bar dataKey="prev" name="Total 2025 (mismo día)" fill={PREV_YEAR_COLOR} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// "When does it pay to invest": last year's real web revenue per peso of
// ad spend on the aligned day.
function EfficiencyChart({ days }) {
  const data = days.map(d => {
    const spend = d.ads.prev.meta.spend + d.ads.prev.google.spend;
    return { label: dayLabel(d.date), mer: ratio(d.web.prevRevenue, spend) };
  });
  return (
    <div className="chart-card">
      <h3 className="chart-title">Cuándo rindió más invertir: venta web por cada $1 en 2025 (mismo día)</h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="label" stroke="var(--ink-secondary)" fontSize={11} interval={0} angle={-35} textAnchor="end" height={50} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={(v) => `${v}x`} width={40} />
          <Tooltip formatter={(v) => times(v)} />
          <Bar dataKey="mer" name="Venta web / inversión" fill="var(--ink-primary)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function PlanTable({ planDays, days }) {
  const anyPlayed = days.some(d => d.ads.actual);
  return (
    <div className="table-card event-table-card">
      <h3 className="chart-title">Plan día por día y ROAS objetivo</h3>
      <div className="event-table-scroll">
        <table className="data-table event-table invest-table">
          <thead>
            <tr>
              <th>Día</th>
              <th className="num">Meta</th>
              <th className="num">Google</th>
              <th className="num">Total</th>
              <th className="num">ROAS obj. Meta</th>
              <th className="num">ROAS obj. Google (GA4)</th>
              <th className="num">Venta web / $1 obj.</th>
              {anyPlayed && <th className="num">Real Meta (ROAS)</th>}
              {anyPlayed && <th className="num">Real Google (ROAS)</th>}
            </tr>
          </thead>
          <tbody>
            {planDays.map((d, i) => {
              const actual = days[i].ads.actual;
              return (
                <tr key={d.date} className={d.phase === 'oficial' ? 'event-row-official' : undefined}>
                  <td>{dayLabel(d.date)}{days[i].isLaunch ? ' · lanz.' : ''}</td>
                  <td className="num">{millions(d.meta)}</td>
                  <td className="num">{millions(d.google)}</td>
                  <td className="num">{millions(d.spend)}</td>
                  <td className="num">{times(d.roasTarget.meta)}</td>
                  <td className="num">{times(d.roasTarget.google)}</td>
                  <td className="num">{times(d.merTarget)}</td>
                  {anyPlayed && (
                    <td className="num">{actual ? `${millions(actual.meta.spend)} (${times(ratio(actual.meta.value, actual.meta.spend))})` : '—'}</td>
                  )}
                  {anyPlayed && (
                    <td className="num">{actual ? `${millions(actual.google.spend)} (${times(ratio(actual.google.value, actual.google.spend))})` : '—'}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviousAds({ previousAds, recapDaily, eventLabel, prevYear }) {
  const webByDate = new Map(recapDaily.map(d => [d.date, d.revenue]));
  const rows = previousAds.map(d => {
    const spend = d.meta.spend + d.google.spend;
    const web = webByDate.get(d.date) || 0;
    return {
      ...d,
      label: dayLabel(d.date),
      spend,
      web,
      roasMeta: ratio(d.meta.value, d.meta.spend),
      roasGoogle: ratio(d.google.value, d.google.spend),
      mer: ratio(web, spend),
    };
  });
  const tot = rows.reduce((t, r) => ({
    meta: t.meta + r.meta.spend, google: t.google + r.google.spend,
    metaValue: t.metaValue + r.meta.value, googleValue: t.googleValue + r.google.value, web: t.web + r.web,
  }), { meta: 0, google: 0, metaValue: 0, googleValue: 0, web: 0 });
  return (
    <>
      <h2 className="section-title">Pauta {eventLabel} {prevYear}: Meta y Google</h2>
      <div className="dashboard-grid">
        <div className="chart-card">
          <h3 className="chart-title">ROAS por día que reportó cada plataforma</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              <XAxis dataKey="label" stroke="var(--ink-secondary)" fontSize={11} interval={0} angle={-35} textAnchor="end" height={50} />
              <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={(v) => `${v}x`} width={40} />
              <Tooltip formatter={(v) => times(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendInk} />
              <Line dataKey="roasMeta" name="Meta" stroke={META_COLOR} strokeWidth={2} dot={{ r: 4 }} />
              <Line dataKey="roasGoogle" name="Google" stroke={GOOGLE_COLOR} strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3 className="chart-title">Inversión por día</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              <XAxis dataKey="label" stroke="var(--ink-secondary)" fontSize={11} interval={0} angle={-35} textAnchor="end" height={50} />
              <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={millions} width={56} />
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendInk} />
              <Bar dataKey="meta.spend" name="Meta" stackId="a" fill={META_COLOR} stroke="var(--surface-card)" strokeWidth={2} />
              <Bar dataKey="google.spend" name="Google" stackId="a" fill={GOOGLE_COLOR} stroke="var(--surface-card)" strokeWidth={2} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="table-card event-table-card">
        <h3 className="chart-title">Pauta {prevYear} día por día</h3>
        <div className="event-table-scroll">
          <table className="data-table event-table invest-table">
            <thead>
              <tr>
                <th>Día</th>
                <th className="num">Inversión Meta</th>
                <th className="num">ROAS Meta</th>
                <th className="num">Inversión Google</th>
                <th className="num">ROAS Google (GA4)</th>
                <th className="num">Inversión total</th>
                <th className="num">Facturación web</th>
                <th className="num">Venta web / $1</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.date}>
                  <td>{r.label}</td>
                  <td className="num">{formatCurrency(r.meta.spend)}</td>
                  <td className="num">{times(r.roasMeta)}</td>
                  <td className="num">{formatCurrency(r.google.spend)}</td>
                  <td className="num">{times(r.roasGoogle)}</td>
                  <td className="num">{formatCurrency(r.spend)}</td>
                  <td className="num">{formatCurrency(r.web)}</td>
                  <td className="num">{times(r.mer)}</td>
                </tr>
              ))}
              <tr className="event-row-official">
                <td>Total</td>
                <td className="num">{formatCurrency(tot.meta)}</td>
                <td className="num">{times(ratio(tot.metaValue, tot.meta))}</td>
                <td className="num">{formatCurrency(tot.google)}</td>
                <td className="num">{times(ratio(tot.googleValue, tot.google))}</td>
                <td className="num">{formatCurrency(tot.meta + tot.google)}</td>
                <td className="num">{formatCurrency(tot.web)}</td>
                <td className="num">{times(ratio(tot.web, tot.meta + tot.google))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function InvestmentPlan({ data }) {
  const inv = data.investment;
  return (
    <>
      <h2 className="section-title">Propuesta de inversión en pauta · {data.label} {data.current.year}</h2>
      <div className="event-assumptions">
        {inv.fixedPlan ? (
          <div>
            <strong>Presupuesto:</strong> el plan día por día confirmado por marketing, {millions(inv.total)} en total
            entre Meta y Google ({millions(inv.dailyBudget)} por día en promedio). Los montos de cada día salen de la
            planilla, no de este reporte.
          </div>
        ) : (
          <div>
            <strong>Presupuesto:</strong> {millions(inv.dailyBudget)} por día entre Meta y Google ({millions(inv.total)} en
            total{data.current.launchHours ? `, el día del lanzamiento proporcional a ${data.current.launchHours} h` : ''}).
            Un monto fijo por día en cada etapa (previa, días oficiales, extensión), según cuánto vendió la web en esa
            etapa en {data.previous.year}: entre la mitad y 1,6 veces el promedio diario, redondeado para cargarlo
            directo en las plataformas.
          </div>
        )}
        <div>
          <strong>ROAS objetivo:</strong> lo que tiene que reportar cada plataforma para que la web llegue a su objetivo del
          día. Hoy Meta se adjudica el {Math.round(inv.shares.meta * 100)}% de la venta web y Google
          el {Math.round(inv.shares.google * 100)}% (del {shortDate(inv.sharesRange.start)} al {shortDate(inv.sharesRange.end)};
          se solapan, por eso suman más que lo vendido). "Venta web / $1" es la venta real dividida por toda la inversión.
        </div>
        <div>
          <strong>Cómo se mide:</strong> Meta, compras con 1 día desde el clic (Meta Ads). Google, compras e ingresos de
          GA4 de las visitas que llegan por <em>google / cpc</em> (no la conversión de Google Ads, que atribuye con
          ventanas de 30–90 días).
        </div>
        {inv.googleBrand?.previous?.revenuePct != null && (
          <div>
            <strong>Ojo con la búsqueda de marca:</strong> en {data.label} {data.previous.year} la campaña de marca
            ("altorancho" en Google) fue el {Math.round(inv.googleBrand.previous.spendPct * 100)}% de la inversión de
            Google pero el {Math.round(inv.googleBrand.previous.revenuePct * 100)}% de sus ingresos. Son en gran parte
            ventas que se hacían igual: sin marca, Google rindió {times(inv.googleBrand.previous.roasNonBrand)}
            {inv.googleBrand.recent?.roasNonBrand != null && <> (hoy {times(inv.googleBrand.recent.roasNonBrand)})</>}.
            Por eso la plata extra rinde más en las campañas que no son de marca.
          </div>
        )}
      </div>
      <PhaseCards phases={inv.phases} />
      <PlanChart planDays={inv.days} days={data.days} />
      <EfficiencyChart days={data.days} />
      <PlanTable planDays={inv.days} days={data.days} />
      <PreviousAds
        previousAds={data.previousAds}
        recapDaily={data.previousRecap.web.daily}
        eventLabel={data.label}
        prevYear={data.previous.year}
      />
    </>
  );
}
