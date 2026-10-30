// Pure helpers for the live Cyber/Black page: the per-view numbers (total =
// web + locales) and the milestones to celebrate.
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
  // Floor and target of the time elapsed so far: played days in full, today
  // only for the share already elapsed (each group with its own share).
  // totals.floorToDate/targetToDate count today's whole day, which would make
  // every afternoon look "bajo piso".
  const elapsed = (k) => (data.days || []).filter(d => d.played).reduce(
    (s, d) => s + groups.reduce((t, g) => t + (d[g]?.[k] || 0) * (d.date === data.today ? (share[g] || 0) : 1), 0),
    0,
  );
  v.floorElapsed = elapsed('floor');
  v.targetElapsed = elapsed('target');
  v.status = v.targetElapsed ? statusOf(v.revenue, v.floorElapsed, v.targetElapsed) : null;
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

// " (web)" / " (locales)" so a toast says which view it is about.
export function viewSuffix(view) {
  return view && view !== 'total' ? ` (${view})` : '';
}

export function milestoneText(id, label, view = 'total') {
  return MILESTONE_COPY[id].replace('{label}', () => label) + viewSuffix(view);
}

export function minutesAgo(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60000));
}

// "$14M", "$6,7M", "$321K": short amounts for the tiles and table.
export function compactMoney(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}$${formatNumber(Math.round(a / 1e6))}M`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1).replace('.', ',')}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return formatCurrency(v).replace(/\s/g, '');
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
