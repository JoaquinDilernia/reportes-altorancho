import { useState, useEffect } from 'react';
import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { getEventReport } from '../api/client.js';
import { formatCurrency, formatNumber, formatPercent } from '../lib/format.js';
import { getChannelColor, getChannelLabel } from '../lib/channels.js';
import TopProductsTable from './TopProductsTable.jsx';
import InvestmentPlan from './InvestmentPlan.jsx';

const EVENTS = [
  { id: 'cyber', label: 'Cyber' },
  { id: 'black', label: 'Black' },
];

const GROUPS = [
  { id: 'web', label: 'Web', color: getChannelColor('ecommerce') },
  { id: 'locales', label: 'Locales', color: getChannelColor('local_belgrano') },
];

// Cool gray for last year's bars: reads as "reference" on the beige card,
// and stays distinguishable from both group colors under color-vision deficiency.
const PREV_YEAR_COLOR = '#A9B4C2';
const TARGET_COLOR = '#353434';

const PHASE_LABELS = { pre: 'Pre', oficial: 'Oficial', extension: 'Extensión' };
const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function monthLabel(month) {
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

function shortDate(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

function dayLabel(dateStr) {
  return `${WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]} ${shortDate(dateStr)}`;
}

function compactCurrency(v) {
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return formatCurrency(v);
}

function pctOf(actual, target) {
  if (actual == null || !target) return null;
  return Math.round((actual / target) * 1000) / 10;
}

function ProgressBadge({ pct }) {
  if (pct == null) return <span className="delta-badge delta-neutral">—</span>;
  const className = pct >= 100 ? 'delta-positive' : 'delta-negative';
  return <span className={`delta-badge ${className}`}>{`${pct.toFixed(0)}%`}</span>;
}

function TargetCard({ title, totals, eventLabel, prevYear }) {
  const started = totals.targetToDate > 0;
  return (
    <div className="kpi-card">
      <div className="kpi-label">{title} · objetivo {eventLabel}</div>
      <div className="kpi-value">{formatCurrency(totals.target)}</div>
      <div className="kpi-deltas">
        <div className="kpi-delta-row">
          <span className="kpi-delta-label">Mismos días {prevYear}</span>
          <span>{formatCurrency(totals.prevRevenue)}</span>
        </div>
        <div className="kpi-delta-row">
          <span className="kpi-delta-label">Vendido hasta hoy</span>
          <span>{started ? formatCurrency(totals.revenue) : '—'}</span>
        </div>
        <div className="kpi-delta-row">
          <span className="kpi-delta-label">Avance sobre el objetivo total</span>
          <span>{started ? formatPercent(totals.progressPct).replace('+', '') : '—'}</span>
        </div>
        <div className="kpi-delta-row kpi-delta-row-adjusted">
          <span className="kpi-delta-label">vs. objetivo de los días ya jugados</span>
          <ProgressBadge pct={started ? totals.vsTargetToDatePct : null} />
        </div>
      </div>
    </div>
  );
}

function sumTotals(a, b) {
  const t = {};
  for (const k of ['prevRevenue', 'target', 'targetToDate', 'revenue']) t[k] = a[k] + b[k];
  t.progressPct = t.target ? Math.round((t.revenue / t.target) * 1000) / 10 : null;
  t.vsTargetToDatePct = t.targetToDate ? Math.round((t.revenue / t.targetToDate) * 1000) / 10 : null;
  return t;
}

function Assumptions({ data }) {
  const { realGrowth, inflation, channelsWithoutHistory, baselineRange } = data.assumptions;
  const yoy = inflation.yearOverYear
    .map(i => `${monthLabel(i.month)}: ${i.pct.toFixed(1)}%${i.projected ? '*' : ''}`)
    .join(' · ');
  return (
    <div className="event-assumptions">
      <div>
        <strong>Cómo se calcula el objetivo:</strong> venta del mismo día de la semana de {data.previous.year} (alineado
        al día oficial) × inflación interanual × crecimiento real (web +{Math.round(realGrowth.web * 100)}%,
        locales +{Math.round(realGrowth.locales * 100)}%).
      </div>
      <div>
        Inflación interanual usada — {yoy}.
        {inflation.lastPublishedMonth && (
          <> * INDEC publicado hasta {monthLabel(inflation.lastPublishedMonth)}; el resto proyectado
          al {inflation.projectedMonthlyRatePct?.toFixed(2)}% mensual (promedio de los últimos 3 meses).</>
        )}
      </div>
      {channelsWithoutHistory.length > 0 && (
        <div>
          {channelsWithoutHistory.map(getChannelLabel).join(', ')} no vendía en {data.previous.year}: su objetivo es su
          promedio por día de semana del {shortDate(baselineRange.start)} al {shortDate(baselineRange.end)}.
        </div>
      )}
      <div>Mismo criterio que el resto del reporte: web sin IVA ni envío, locales con IVA.</div>
    </div>
  );
}

function DayByDayChart({ days, group, prevYear, currentYear }) {
  const data = days.map(d => ({
    label: dayLabel(d.date),
    prev: d[group.id].prevRevenue,
    target: d[group.id].target,
    actual: d[group.id].revenue,
    refDate: d.refDate,
  }));
  return (
    <div className="chart-card">
      <h3 className="chart-title">{group.label}: día por día</h3>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }} barGap={2}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="label" stroke="var(--ink-secondary)" fontSize={11} interval={0} angle={-35} textAnchor="end" height={50} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={compactCurrency} width={60} />
          <Tooltip
            formatter={(v) => (v == null ? '—' : formatCurrency(v))}
            labelFormatter={(label, payload) => {
              const ref = payload?.[0]?.payload?.refDate;
              return ref ? `${label} (vs. ${dayLabel(ref)} ${prevYear})` : label;
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={(value) => <span style={{ color: 'var(--ink-primary)' }}>{value}</span>} />
          <Bar dataKey="prev" name={`${prevYear} (mismo día)`} fill={PREV_YEAR_COLOR} radius={[4, 4, 0, 0]} />
          <Bar dataKey="actual" name={`${currentYear} real`} fill={group.color} radius={[4, 4, 0, 0]} />
          <Line dataKey="target" name={`Objetivo ${currentYear}`} stroke={TARGET_COLOR} strokeWidth={2} dot={{ r: 4 }} type="linear" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function DayByDayTable({ days, group, prevYear, currentYear }) {
  return (
    <div className="table-card event-table-card">
      <h3 className="chart-title">{group.label}: tabla día por día</h3>
      <div className="event-table-scroll">
        <table className="data-table event-table">
          <thead>
            <tr>
              <th>Día</th>
              <th>Fase</th>
              <th>Comparable {prevYear}</th>
              <th className="num">Venta {prevYear}</th>
              <th className="num">Objetivo {currentYear}</th>
              <th className="num">Real {currentYear}</th>
              <th className="num">Cumplimiento</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const cell = d[group.id];
              return (
                <tr key={d.date} className={d.phase === 'oficial' ? 'event-row-official' : undefined}>
                  <td>{dayLabel(d.date)}{d.isLaunch ? ' · lanzamiento' : ''}</td>
                  <td>{PHASE_LABELS[d.phase]}</td>
                  <td>{dayLabel(d.refDate)}</td>
                  <td className="num">{formatCurrency(cell.prevRevenue)}</td>
                  <td className="num">{formatCurrency(cell.target)}</td>
                  <td className="num">{cell.revenue == null ? '—' : formatCurrency(cell.revenue)}</td>
                  <td className="num"><ProgressBadge pct={pctOf(cell.revenue, cell.target)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PastEventRecap({ recap, group, eventLabel, prevYear }) {
  const stats = [
    { label: 'Facturación', value: formatCurrency(recap.revenue) },
    { label: 'Ventas', value: formatNumber(recap.orders) },
    { label: 'Ticket promedio', value: formatCurrency(recap.avgTicket) },
    {
      label: 'Promedio diario vs. día normal',
      value: recap.lift != null ? `${recap.lift.toFixed(1)}x` : '—',
      sub: `${formatCurrency(recap.avgDailyRevenue)} vs. ${formatCurrency(recap.baselineDailyRevenue)}`,
    },
    {
      label: 'Mejor día',
      value: recap.peakDay ? dayLabel(recap.peakDay.date) : '—',
      sub: recap.peakDay ? `${formatCurrency(recap.peakDay.revenue)} · ${formatNumber(recap.peakDay.orders)} ventas` : '',
    },
    { label: 'Venta en días oficiales', value: `${recap.officialSharePct.toFixed(0)}%` },
  ];
  const stores = recap.byChannel.filter(c => c.revenue > 0);
  return (
    <>
      <h2 className="section-title">Cómo fue {eventLabel} {prevYear}: {group.label.toLowerCase()}</h2>
      <div className="panel-card">
        <div className="panel-grid">
          {stats.map(s => (
            <div className="panel-item" key={s.label} style={{ '--tab-color': group.color }}>
              <div className="panel-item-label">{s.label}</div>
              <div className="panel-item-value">{s.value}</div>
              {s.sub && <div className="panel-item-sub">{s.sub}</div>}
            </div>
          ))}
          {stores.length > 1 && stores.map(c => (
            <div className="panel-item" key={c.channel} style={{ '--tab-color': getChannelColor(c.channel) }}>
              <div className="panel-item-label">{getChannelLabel(c.channel)}</div>
              <div className="panel-item-value">{formatCurrency(c.revenue)}</div>
              <div className="panel-item-sub">{formatNumber(c.orders)} ventas</div>
            </div>
          ))}
        </div>
      </div>
      <div className="dashboard-grid">
        <div className="chart-card">
          <h3 className="chart-title">Facturación por día, {eventLabel} {prevYear} completo</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={recap.daily.map(d => ({ ...d, label: dayLabel(d.date) }))} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              <XAxis dataKey="label" stroke="var(--ink-secondary)" fontSize={11} interval={0} angle={-35} textAnchor="end" height={50} />
              <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={compactCurrency} width={60} />
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Bar dataKey="revenue" name="Facturación" fill={group.color} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3 className="chart-title">Facturación por hora en los días oficiales</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={recap.hourly.map(h => ({ ...h, label: `${h.hour}h` }))} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              <XAxis dataKey="label" stroke="var(--ink-secondary)" fontSize={11} interval={1} />
              <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={compactCurrency} width={60} />
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Bar dataKey="revenue" name="Facturación" fill={group.color} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="dashboard-grid">
        <TopProductsTable byUnits={recap.topProductsByUnits} byRevenue={recap.topProductsByRevenue} />
      </div>
    </>
  );
}

export default function EventPanel({ onLogout }) {
  const [eventId, setEventId] = useState('cyber');
  const [groupId, setGroupId] = useState('web');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getEventReport(eventId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout();
      });
    return () => { cancelled = true; };
  }, [eventId, onLogout]);

  const group = GROUPS.find(g => g.id === groupId);

  return (
    <main className="dashboard-body">
      <div className="event-header">
        <div className="table-toggle">
          {EVENTS.map(e => (
            <button key={e.id} className={eventId === e.id ? 'active' : ''} onClick={() => setEventId(e.id)}>{e.label}</button>
          ))}
        </div>
        {data && (
          <div className="event-dates">
            <strong>{data.label} {data.current.year}:</strong> {shortDate(data.current.start)} → {shortDate(data.current.end)}
            {data.current.launchNote ? ` (${data.current.launchNote})` : ''} · días oficiales {shortDate(data.current.officialStart)}
            {data.current.officialEnd !== data.current.officialStart ? `–${shortDate(data.current.officialEnd)}` : ''}
            <span className="event-dates-prev">
              {' '}· {data.previous.year}: {shortDate(data.previous.start)} → {shortDate(data.previous.end)}
            </span>
          </div>
        )}
      </div>

      {error && <p className="status-text status-error">Error: {error}</p>}
      {!data && !error && <p className="status-text">Cargando...</p>}

      {data && (
        <>
          <div className="kpi-cards">
            <TargetCard title="Web" totals={data.totals.web} eventLabel={data.label} prevYear={data.previous.year} />
            <TargetCard title="Locales" totals={data.totals.locales} eventLabel={data.label} prevYear={data.previous.year} />
            <TargetCard title="Total" totals={sumTotals(data.totals.web, data.totals.locales)} eventLabel={data.label} prevYear={data.previous.year} />
          </div>
          <Assumptions data={data} />

          <div className="table-toggle">
            {GROUPS.map(g => (
              <button key={g.id} className={groupId === g.id ? 'active' : ''} onClick={() => setGroupId(g.id)}>{g.label}</button>
            ))}
          </div>
          <DayByDayChart days={data.days} group={group} prevYear={data.previous.year} currentYear={data.current.year} />
          <DayByDayTable days={data.days} group={group} prevYear={data.previous.year} currentYear={data.current.year} />
          {data.investment && <InvestmentPlan data={data} />}
          <PastEventRecap recap={data.previousRecap[groupId]} group={group} eventLabel={data.label} prevYear={data.previous.year} />
        </>
      )}
    </main>
  );
}
