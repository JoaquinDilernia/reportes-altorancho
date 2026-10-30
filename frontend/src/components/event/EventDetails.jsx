import { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { formatCurrency, formatNumber } from '../../lib/format.js';
import { getChannelColor, getChannelLabel } from '../../lib/channels.js';
import TopProductsTable from '../TopProductsTable.jsx';
import InvestmentPlan from '../InvestmentPlan.jsx';

// Planning material, folded at the bottom of the live page. It renders on a
// light sheet with the regular report components (moved from EventPanel).

const GROUPS = [
  { id: 'web', label: 'Web', color: getChannelColor('ecommerce') },
  { id: 'locales', label: 'Locales', color: getChannelColor('local_belgrano') },
];

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
      <div>
        Proyección: lo vendido + el objetivo de los días que faltan × el ritmo actual contra el objetivo (el día de hoy
        se pondera con la curva horaria de {data.previous.year}).
      </div>
      <div>Mismo criterio que el resto del reporte: web sin IVA ni envío, locales con IVA.</div>
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

export default function EventDetails({ data, view }) {
  // Render the heavy content only once opened (charts inside a closed
  // <details> would measure 0 px wide).
  const [open, setOpen] = useState(false);
  const groups = view === 'total' ? GROUPS : GROUPS.filter(g => g.id === view);
  return (
    <details className="ev-details" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {open ? '▾' : '▸'} Plan de inversión, supuestos y cómo fue {data.label} {data.previous.year}
        <small>plegado; se abre si lo necesitás</small>
      </summary>
      {open && (
        <div className="ev-paper">
          <h2 className="section-title">Supuestos</h2>
          <Assumptions data={data} />
          {data.investment && <InvestmentPlan data={data} />}
          {groups.map(g => data.previousRecap?.[g.id] && (
            <PastEventRecap key={g.id} recap={data.previousRecap[g.id]} group={g} eventLabel={data.label} prevYear={data.previous.year} />
          ))}
        </div>
      )}
    </details>
  );
}
