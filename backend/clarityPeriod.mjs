// Clarity for any period, from the daily snapshots (snapshots.mjs): its API
// only keeps 1–3 days, so the report never calls it live. Percentages and
// averages are weighted by each day's (or page's) sessions.
import { addDays } from './events.mjs';

const PAGE_MIN_SESSIONS = 50;
const PAGE_LIMIT = 20;
const SIGNAL_KEYS = ['rage', 'dead', 'quickback', 'excessiveScroll'];

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function dayCount({ start, end }) {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) n += 1;
  return n;
}

// Weighted average helper: add(value, weight) then value().
function weighted() {
  let sum = 0;
  let w = 0;
  return {
    add(v, weight) { if (isNum(v) && weight > 0) { sum += v * weight; w += weight; } },
    value() { return w ? round(sum / w) : null; },
  };
}

export function mergeClarityPages(snapshots) {
  const pages = new Map();
  for (const s of snapshots || []) {
    for (const p of s.pages || []) {
      if (!(p.sessions > 0)) continue;
      const acc = pages.get(p.path) ?? { path: p.path, sessions: 0, scroll: weighted(), rage: weighted(), dead: weighted(), quickback: weighted() };
      acc.sessions += p.sessions;
      for (const k of ['rage', 'dead', 'quickback']) acc[k].add(p[k] || 0, p.sessions);
      acc.scroll.add(p.scrollDepth, p.sessions);
      pages.set(p.path, acc);
    }
  }
  return [...pages.values()]
    .map(a => ({ path: a.path, sessions: a.sessions, scrollDepth: a.scroll.value(), rage: a.rage.value() ?? 0, dead: a.dead.value() ?? 0, quickback: a.quickback.value() ?? 0 }))
    .sort((a, b) => b.sessions - a.sessions);
}

export function clarityForPeriod(snapshots, range) {
  const totalDays = dayCount(range);
  const days = (snapshots || []).filter(s => s?.totals && s.date >= range.start && s.date <= range.end)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return { days: 0, totalDays };

  let sessions = 0;
  let users = 0;
  const scroll = weighted();
  const active = weighted();
  const signals = Object.fromEntries(SIGNAL_KEYS.map(k => [k, { pct: weighted(), count: 0, seen: false }]));
  for (const s of days) {
    const t = s.totals;
    const n = t.sessions || 0;
    sessions += n;
    users += t.users || 0;
    scroll.add(t.scrollDepth, n);
    active.add(t.activeTimeSec, n);
    for (const k of SIGNAL_KEYS) {
      const v = t.signals?.[k];
      if (!v) continue;
      signals[k].seen = true;
      signals[k].pct.add(v.pct, n);
      signals[k].count += v.count || 0;
    }
  }
  return {
    days: days.length,
    totalDays,
    dates: days.map(s => s.date),
    totals: {
      sessions,
      users,
      scrollDepth: scroll.value(),
      activeTimeSec: active.value(),
      signals: Object.fromEntries(SIGNAL_KEYS.map(k => [k, signals[k].seen ? { pct: signals[k].pct.value(), count: signals[k].count } : null])),
    },
    pages: mergeClarityPages(days).filter(p => p.sessions >= PAGE_MIN_SESSIONS).slice(0, PAGE_LIMIT),
    daily: days.map(s => ({
      date: s.date,
      sessions: s.totals.sessions || 0,
      rage: s.totals.signals?.rage?.pct ?? null,
      dead: s.totals.signals?.dead?.pct ?? null,
      quickback: s.totals.signals?.quickback?.pct ?? null,
    })),
  };
}
