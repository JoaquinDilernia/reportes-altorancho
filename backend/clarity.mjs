// Microsoft Clarity Data Export API ("project-live-insights"). Only the last
// 1–3 days exist and the token allows ~10 calls per day (shared with any
// local run using the same token), so: 2 calls per build, a 2 h cache, a
// daily cap, and the last good result is served once the cap is hit.
// Heatmaps and recordings are not in the API — only in Clarity's own UI.
const URL_BASE = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
// 6 leaves room under the API's ~10/day for manual checks with the same token.
const DAILY_CALL_CAP = 6;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
// While Clarity has no sessions yet (just installed), retry sooner.
const EMPTY_TTL_MS = 60 * 60 * 1000;

export function isClarityConfigured() {
  return Boolean(process.env.CLARITY_API_TOKEN);
}

let calls = { day: null, count: 0 };

async function clarityCall(params) {
  const day = new Date().toISOString().slice(0, 10);
  if (calls.day !== day) calls = { day, count: 0 };
  if (calls.count >= DAILY_CALL_CAP) throw new Error('Clarity: tope diario de consultas alcanzado');
  calls.count += 1;
  const res = await fetch(`${URL_BASE}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${process.env.CLARITY_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Clarity ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const metric = (resp, name) => resp.find(m => m.metricName === name)?.information || [];

// Behaviour signals, as % of sessions that had them.
const SIGNALS = [
  { id: 'RageClickCount', key: 'rage' },
  { id: 'DeadClickCount', key: 'dead' },
  { id: 'QuickbackClick', key: 'quickback' },
  { id: 'ErrorClickCount', key: 'errorClick' },
  { id: 'ExcessiveScroll', key: 'excessiveScroll' },
  { id: 'ScriptErrorCount', key: 'scriptError' },
];

export function shapeClarityTotals(resp) {
  const traffic = metric(resp, 'Traffic')[0] || {};
  const engagement = metric(resp, 'EngagementTime')[0] || {};
  const out = {
    sessions: num(traffic.totalSessionCount) || 0,
    botSessions: num(traffic.totalBotSessionCount) || 0,
    users: num(traffic.distinctUserCount) || 0,
    pagesPerSession: num(traffic.pagesPerSessionPercentage),
    scrollDepth: num(metric(resp, 'ScrollDepth')[0]?.averageScrollDepth),
    totalTimeSec: num(engagement.totalTime),
    activeTimeSec: num(engagement.activeTime),
    signals: {},
  };
  for (const s of SIGNALS) {
    const r = metric(resp, s.id)[0];
    out.signals[s.key] = r ? { pct: num(r.sessionsWithMetricPercentage), sessions: num(r.sessionsCount), count: num(r.subTotal) } : null;
  }
  return out;
}

const urlOf = (r) => r.URL ?? r.Url ?? r.url ?? null;

// Normalizes a full URL to its path (+ query dropped) so the same page from
// different campaigns groups together.
export function pagePath(u) {
  try { return new URL(u).pathname || '/'; } catch { return String(u || '').split('?')[0] || '/'; }
}

export function shapeClarityPages(resp, { minSessions = 20, limit = 15 } = {}) {
  const pages = new Map();
  const get = (u) => {
    const path = pagePath(u);
    if (!pages.has(path)) pages.set(path, { path, sessions: 0, scrollDepth: null, signals: {} });
    return pages.get(path);
  };
  for (const r of metric(resp, 'Traffic')) {
    if (!urlOf(r)) continue;
    get(urlOf(r)).sessions += num(r.totalSessionCount) || 0;
  }
  for (const r of metric(resp, 'ScrollDepth')) {
    if (!urlOf(r)) continue;
    get(urlOf(r)).scrollDepth = num(r.averageScrollDepth);
  }
  for (const s of SIGNALS) {
    for (const r of metric(resp, s.id)) {
      if (!urlOf(r)) continue;
      const p = get(urlOf(r));
      // sessionsCount is all of the URL's sessions; only the percentage tells
      // how many of them had the signal (verified live 12/11/2026).
      const withSignal = ((num(r.sessionsCount) || 0) * (num(r.sessionsWithMetricPercentage) || 0)) / 100;
      const prev = p.signals[s.key] || { sessions: 0, count: 0 };
      p.signals[s.key] = { sessions: prev.sessions + withSignal, count: prev.count + (num(r.subTotal) || 0) };
    }
  }
  return [...pages.values()]
    .filter(p => p.sessions >= minSessions)
    .map(p => {
      const pct = (k) => (p.sessions && p.signals[k] ? (p.signals[k].sessions / p.sessions) * 100 : 0);
      return { path: p.path, sessions: p.sessions, scrollDepth: p.scrollDepth, rage: pct('rage'), dead: pct('dead'), quickback: pct('quickback') };
    })
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, limit);
}

// Raw last-24 h responses (the 2 calls), for the daily snapshot.
export async function fetchClarityLast24h() {
  const [totalsResp, byUrlResp] = await Promise.all([
    clarityCall({ numOfDays: '1' }),
    clarityCall({ numOfDays: '1', dimension1: 'URL' }),
  ]);
  return { totalsResp, byUrlResp };
}

async function buildClarity() {
  const { totalsResp: totals, byUrlResp: byUrl } = await fetchClarityLast24h();
  return {
    available: true,
    window: 'últimas 24 h',
    generatedAt: new Date().toISOString(),
    totals: shapeClarityTotals(totals),
    pages: shapeClarityPages(byUrl),
  };
}

let cache = null;
let lastGood = null;

export async function getClarityReport() {
  if (!isClarityConfigured()) return { available: false, reason: 'Clarity no configurado' };
  if (cache && Date.now() - cache.at < (cache.empty ? EMPTY_TTL_MS : CACHE_TTL_MS)) return cache.promise;
  const entry = { at: Date.now(), empty: false };
  const promise = buildClarity().then(r => {
    if (r.totals.sessions > 0) lastGood = r; else entry.empty = true;
    return r;
  });
  entry.promise = promise;
  cache = entry;
  try {
    return await promise;
  } catch (err) {
    cache = null;
    if (lastGood) return { ...lastGood, stale: true };
    return { available: false, reason: err.message };
  }
}
