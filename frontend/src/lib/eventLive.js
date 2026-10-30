// Pure helpers for the live Cyber/Black page: the per-view numbers (total =
// web + locales), the milestones to celebrate and the news-ticker lines.
// Everything here derives from the /api/event payload; nothing is invented.
import { formatCurrency, formatNumber } from './format.js';

export const STATUS_LABELS = { bajo_piso: 'bajo piso', entre: 'entre piso y obj.', sobre: 'sobre obj.' };

export const MILESTONE_COPY = {
  piso_dia: '¡Pasamos el piso de HOY!',
  objetivo_dia: '¡Pasamos el objetivo de HOY!',
  piso_evento: '¡Pasamos el PISO del {label}!',
  objetivo_evento: '¡OBJETIVO del {label} cumplido!',
};

const GROUPS = ['web', 'locales'];
const groupsOf = (view) => (view === 'total' ? GROUPS : [view]);

// Same rule as the backend's statusOf.
function statusOf(revenue, floor, target) {
  if (revenue >= target) return 'sobre';
  if (revenue >= floor) return 'entre';
  return 'bajo_piso';
}

export function groupView(data, view) {
  const groups = groupsOf(view);
  const sumTotals = (k) => groups.reduce((s, g) => s + (data.totals?.[g]?.[k] || 0), 0);
  const v = {
    revenue: sumTotals('revenue'),
    orders: sumTotals('orders'),
    floor: sumTotals('floor'),
    target: sumTotals('target'),
    floorToDate: sumTotals('floorToDate'),
    targetToDate: sumTotals('targetToDate'),
    prevRevenue: sumTotals('prevRevenue'),
  };
  if (view === 'total') {
    v.status = v.targetToDate ? statusOf(v.revenue, v.floorToDate, v.targetToDate) : null;
  } else {
    v.status = data.totals?.[view]?.status ?? null;
  }
  v.projection = data.live?.projection?.[view] ?? null;

  const share = data.live?.todayShare || {};
  const day = (data.days || []).find(d => d.date === data.today);
  const played = !!day?.played;
  const sumDay = (k) => groups.reduce((s, g) => s + (day?.[g]?.[k] || 0), 0);
  const todayStatus = data.live?.todayStatus?.[view] ?? null;
  v.today = {
    date: data.today,
    revenue: played ? sumDay('revenue') : null,
    orders: played ? sumDay('orders') : null,
    floor: day ? sumDay('floor') : 0,
    target: day ? sumDay('target') : 0,
    pct: todayStatus?.pct ?? null,
    status: todayStatus?.status ?? null,
  };
  // Same day of last year, inflation-adjusted (the floor), up to the share of
  // the day already elapsed — so "hoy vs 2025" compares like with like.
  v.todayPrev = day ? groups.reduce((s, g) => s + (day[g]?.floor || 0) * (share[g] || 0), 0) : 0;
  // Floor of the time elapsed so far (played days, today pro-rated).
  v.floorElapsed = (data.days || []).filter(d => d.played).reduce(
    (s, d) => s + groups.reduce((t, g) => t + (d[g]?.floor || 0) * (d.date === data.today ? (share[g] || 0) : 1), 0),
    0,
  );
  return v;
}

const MILESTONES = [
  ['piso_dia', (v) => v.today?.revenue ?? 0, (v) => v.today?.floor ?? 0],
  ['objetivo_dia', (v) => v.today?.revenue ?? 0, (v) => v.today?.target ?? 0],
  ['piso_evento', (v) => v.revenue ?? 0, (v) => v.floor ?? 0],
  ['objetivo_evento', (v) => v.revenue ?? 0, (v) => v.target ?? 0],
];

export function crossedMilestones(prev, next) {
  if (!next) return [];
  return MILESTONES.filter(([id, value, threshold]) => {
    const t = threshold(next);
    if (!(t > 0) || value(next) < t) return false;
    if (!prev) return true;
    // A new day starts the daily milestones from zero.
    if (id.endsWith('_dia') && prev.today?.date !== next.today?.date) return true;
    return value(prev) < t;
  }).map(([id]) => id);
}

export function milestoneText(id, label) {
  return MILESTONE_COPY[id].replace('{label}', label);
}

export function minutesAgo(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60000));
}

// "$14M", "$6,7M", "$321K": short amounts for the ticker, tiles and table.
export function compactMoney(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',')}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return formatCurrency(v).replace(/\s/g, '');
}

export function buildTicker(data, view) {
  const items = [];
  const v = groupView(data, view);
  const label = data.label;
  for (const id of crossedMilestones(null, v)) items.push(`⚡ ${milestoneText(id, label)}`);

  const top = data.live?.topProductToday;
  if (top?.name && top.units > 0) {
    items.push(`🔥 ${top.name}: ${formatNumber(top.units)} ${top.units === 1 ? 'vendida' : 'vendidas'} hoy`);
  }
  const peak = data.live?.peakHourYesterday;
  if (peak && peak.revenue > 0) {
    items.push(`📈 Hora pico de ayer: ${peak.hour} a ${peak.hour + 1} h, ${compactMoney(peak.revenue)}`);
  }
  for (const c of data.live?.categories || []) {
    if (c.cantMatch && c.id !== 'otros') items.push(`⚠ ${c.label}: quedan ${formatNumber(c.stock)} en stock`);
  }
  if (v.floor > 0 && v.revenue < v.floor) {
    items.push(`🎯 Faltan ${compactMoney(v.floor - v.revenue)} para el piso del ${label}`);
  } else if (v.target > 0 && v.revenue < v.target) {
    items.push(`🎯 Faltan ${compactMoney(v.target - v.revenue)} para el objetivo del ${label}`);
  }
  return items;
}

const seenKey = (eventId) => `eventLive.seen.${eventId}`;

export function loadSeen(eventId) {
  try {
    const raw = globalThis.sessionStorage?.getItem(seenKey(eventId));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function markSeen(eventId, id) {
  try {
    const seen = loadSeen(eventId);
    seen.add(id);
    globalThis.sessionStorage?.setItem(seenKey(eventId), JSON.stringify([...seen]));
  } catch {
    // Storage blocked (private mode, previews): celebrations just repeat.
  }
}
