// Commercial events (Cyber / Black) — each one compares this year's run
// against last year's, day by day, and turns last year's sales into a target
// (last year × inflation × real growth). Pure logic only; the Firestore side
// lives in eventReport.mjs.

// `start`/`end` are the dates WE ran the promo (we start before and finish
// after the official CACE dates); `officialStart`/`officialEnd` are the
// official days, used to label phases and to anchor the day alignment.
export const EVENTS = {
  cyber: {
    label: 'Cyber',
    current: {
      year: 2026, start: '2026-10-29', end: '2026-11-15',
      officialStart: '2026-11-02', officialEnd: '2026-11-04',
      launchNote: 'lanzamiento jueves 29/10 a las 21 h',
      // Hours the promo is live on launch day (21 h → midnight).
      launchHours: 3,
      // Meta + Google combined; the base plan was 2M per platform per day.
      dailyAdBudget: 4_000_000,
      // Optional fixed Meta share (e.g. 0.6 for 60/40) to override the
      // per-phase split suggested by last year's data. Marketing's own
      // projection was 60/40, which the suggested split averages out to.
    },
    previous: {
      year: 2025, start: '2025-10-29', end: '2025-11-09',
      officialStart: '2025-11-03', officialEnd: '2025-11-05',
    },
  },
  // 2025's window is where the web actually spiked (Thu 27/11 → Mon 1/12),
  // not a planned calendar — 2026's is the same weekdays a year later.
  black: {
    label: 'Black',
    current: {
      year: 2026, start: '2026-11-26', end: '2026-11-30',
      officialStart: '2026-11-27', officialEnd: '2026-11-27',
      // Not defined for Black yet — assumed the same as Cyber.
      dailyAdBudget: 4_000_000,
    },
    previous: {
      year: 2025, start: '2025-11-27', end: '2025-12-01',
      officialStart: '2025-11-28', officialEnd: '2025-11-28',
    },
  },
};

export const EVENT_GROUPS = {
  web: ['ecommerce'],
  locales: ['local_lomas', 'local_belgrano', 'local_alcorta'],
};

// Real (inflation-adjusted) growth on top of last year. Web came in flat in
// real terms Jan–Aug 2026 vs 2025, so +10% is a stretch goal driven by the
// event itself; locales are softer (Lomas down in real terms, partly
// cannibalized by Belgrano/Alcorta).
export const TARGET_REAL_GROWTH = { web: 0.10, locales: 0.05 };

// Months of published INDEC data averaged to project the months INDEC
// hasn't published yet (~6-week lag).
const PROJECTION_LOOKBACK_MONTHS = 3;
// A channel with no sales in last year's window (Alcorta opened mid-2026)
// gets its target from its own recent run rate instead.
const BASELINE_WEEKS = 8;

function pad(n) { return String(n).padStart(2, '0'); }

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function argDay(isoDate) {
  return new Date(new Date(isoDate).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function argHour(isoDate) {
  return new Date(new Date(isoDate).getTime() - 3 * 3600 * 1000).getUTCHours();
}

function phaseOf(date, window) {
  if (date < window.officialStart) return 'pre';
  if (date <= window.officialEnd) return 'oficial';
  return 'extension';
}

// Pairs each day of this year's window with the day of last year it should
// be compared against: same weekday, anchored on the official start (so
// Cyber Monday lines up with Cyber Monday). The launch day is the exception
// — it's compared with last year's launch day, since a launch (often at
// night) behaves nothing like a regular event day.
export function alignEventDays(current, previous) {
  const shift = daysBetween(current.officialStart, previous.officialStart);
  const days = [];
  for (let date = current.start; date <= current.end; date = addDays(date, 1)) {
    const isLaunch = date === current.start;
    const refDate = isLaunch ? previous.start : addDays(date, shift);
    days.push({ date, refDate, phase: phaseOf(date, current), isLaunch });
  }
  return days;
}

// INDEC index for `month`, or — when it isn't published yet — the last
// published value compounded forward at the average monthly rate of the
// last few published months.
export function projectInflationIndex(indexByMonth, month) {
  if (indexByMonth.has(month)) return { index: indexByMonth.get(month), projected: false };
  const published = [...indexByMonth.keys()].sort();
  const last = published[published.length - 1];
  if (!last || month < last) return { index: null, projected: false };

  const base = shiftMonth(last, -PROJECTION_LOOKBACK_MONTHS);
  const monthlyRate = indexByMonth.has(base)
    ? Math.pow(indexByMonth.get(last) / indexByMonth.get(base), 1 / PROJECTION_LOOKBACK_MONTHS) - 1
    : 0;
  let index = indexByMonth.get(last);
  for (let m = last; m < month; m = shiftMonth(m, 1)) index *= 1 + monthlyRate;
  return { index, projected: true, monthlyRate, lastPublishedMonth: last };
}

export function inflationFactor(indexByMonth, refMonth, targetMonth) {
  const ref = projectInflationIndex(indexByMonth, refMonth);
  const target = projectInflationIndex(indexByMonth, targetMonth);
  if (!ref.index || !target.index) return { factor: 1, projected: false, missing: true };
  return { factor: target.index / ref.index, projected: ref.projected || target.projected };
}

// { channel -> Map(date -> { revenue, orders }) } from completed sales docs.
export function dailyByChannel(salesDocs) {
  const out = {};
  for (const s of salesDocs) {
    if (s.status !== 'completed') continue;
    const day = argDay(s.date);
    out[s.channel] ??= new Map();
    const map = out[s.channel];
    if (!map.has(day)) map.set(day, { revenue: 0, orders: 0 });
    const entry = map.get(day);
    entry.revenue += s.total;
    entry.orders += 1;
  }
  return out;
}

// Average daily revenue per weekday over [start, end], counting days with
// no sales as 0 so a closed day doesn't inflate the average.
export function weekdayBaseline(dailyMap, start, end) {
  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const wd = weekdayOf(date);
    sums[wd] += dailyMap?.get(date)?.revenue || 0;
    counts[wd] += 1;
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
}

// The 8 weeks before the event — or before today, when the event is still
// weeks away (Black, seen during Cyber), so days that haven't happened yet
// don't count as zero-sales days.
export function baselineRange(current, today) {
  const end = [addDays(current.start, -1), addDays(today, -1)].sort()[0];
  return { start: addDays(end, -BASELINE_WEEKS * 7 + 1), end };
}

function emptyCell() {
  return { prevRevenue: 0, prevOrders: 0, floor: 0, target: 0, revenue: 0, orders: 0 };
}

// Channels that sold nothing during last year's promo window — they can't
// be targeted off last year, so they fall back to their recent run rate.
export function channelsWithoutHistory(prevDaily, previous) {
  return Object.values(EVENT_GROUPS).flat().filter((c) => {
    for (let d = previous.start; d <= previous.end; d = addDays(d, 1)) {
      if (prevDaily[c]?.get(d)?.revenue) return false;
    }
    return true;
  });
}

// Below the floor = worse than last year in real terms; at/above target =
// the stretch goal is met; anything in between is "entre".
export function statusOf(revenue, floor, target) {
  if (revenue >= target) return 'sobre';
  if (revenue >= floor) return 'entre';
  return 'bajo_piso';
}

// Builds the day-by-day rows (per group: last year's aligned day, target,
// this year's actual) plus window totals. `today` (ART date) splits days
// into already-played (actual counts) and still-to-come (actual = null).
export function buildEventDays({
  current, previous, prevDaily, currentDaily, baselineDaily, indexByMonth,
  growth = TARGET_REAL_GROWTH, today,
}) {
  const aligned = alignEventDays(current, previous);
  const baseline = baselineRange(current, today);
  const withoutHistory = channelsWithoutHistory(prevDaily, previous);
  const hasHistory = {};
  for (const c of Object.values(EVENT_GROUPS).flat()) hasHistory[c] = !withoutHistory.includes(c);
  const baselineByChannel = {};
  for (const channels of Object.values(EVENT_GROUPS)) {
    for (const c of channels) {
      if (!hasHistory[c]) baselineByChannel[c] = weekdayBaseline(baselineDaily[c], baseline.start, baseline.end);
    }
  }

  const days = aligned.map((day) => {
    const { factor } = inflationFactor(indexByMonth, day.refDate.slice(0, 7), day.date.slice(0, 7));
    const played = day.date <= today;
    const row = { ...day, inflationFactor: factor, played };
    for (const [group, channels] of Object.entries(EVENT_GROUPS)) {
      const cell = emptyCell();
      for (const c of channels) {
        const prev = prevDaily[c]?.get(day.refDate);
        const actual = currentDaily[c]?.get(day.date);
        cell.prevRevenue += prev?.revenue || 0;
        cell.prevOrders += prev?.orders || 0;
        // Floor = last year's day in today's pesos (no real growth); a
        // channel with no history only has its run rate, so floor = target.
        if (hasHistory[c]) {
          const floor = (prev?.revenue || 0) * factor;
          cell.floor += floor;
          cell.target += floor * (1 + growth[group]);
        } else {
          const base = baselineByChannel[c][weekdayOf(day.date)];
          cell.floor += base;
          cell.target += base;
        }
        cell.revenue += actual?.revenue || 0;
        cell.orders += actual?.orders || 0;
      }
      if (!played) { cell.revenue = null; cell.orders = null; }
      row[group] = cell;
    }
    return row;
  });

  const totals = {};
  for (const group of Object.keys(EVENT_GROUPS)) {
    const t = { prevRevenue: 0, prevOrders: 0, floor: 0, floorToDate: 0, target: 0, targetToDate: 0, revenue: 0, orders: 0 };
    for (const d of days) {
      const cell = d[group];
      t.prevRevenue += cell.prevRevenue;
      t.prevOrders += cell.prevOrders;
      t.target += cell.target;
      t.floor += cell.floor;
      if (d.played) {
        t.floorToDate += cell.floor;
        t.targetToDate += cell.target;
        t.revenue += cell.revenue;
        t.orders += cell.orders;
      }
    }
    t.progressPct = t.target ? Math.round((t.revenue / t.target) * 1000) / 10 : null;
    t.vsTargetToDatePct = t.targetToDate ? Math.round((t.revenue / t.targetToDate) * 1000) / 10 : null;
    // No target yet (event hasn't started) -> no status, not a green one.
    t.status = t.targetToDate ? statusOf(t.revenue, t.floorToDate, t.targetToDate) : null;
    totals[group] = t;
  }

  return {
    days,
    totals,
    channelsWithoutHistory: Object.keys(hasHistory).filter(c => !hasHistory[c]),
    baselineRange: baseline,
  };
}

// "How did last year go": totals, peak day, lift vs. a normal day, share of
// the official days and the hour-of-day curve. `baselineDocs` are the 14
// days before the event, used as "a normal day".
export function summarizePastEvent(salesDocs, baselineDocs, window) {
  const completed = salesDocs.filter(s => s.status === 'completed');
  const revenue = completed.reduce((sum, s) => sum + s.total, 0);
  const orders = completed.length;
  const days = daysBetween(window.start, window.end) + 1;

  const byDay = new Map();
  for (let d = window.start; d <= window.end; d = addDays(d, 1)) byDay.set(d, { date: d, revenue: 0, orders: 0 });
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, orders: 0 }));
  let officialRevenue = 0;
  for (const s of completed) {
    const day = argDay(s.date);
    const entry = byDay.get(day);
    if (entry) { entry.revenue += s.total; entry.orders += 1; }
    if (day >= window.officialStart && day <= window.officialEnd) {
      officialRevenue += s.total;
      const h = hourly[argHour(s.date)];
      h.revenue += s.total;
      h.orders += 1;
    }
  }
  const daily = [...byDay.values()];
  const peakDay = daily.reduce((best, d) => (d.revenue > (best?.revenue ?? -1) ? d : best), null);

  const baselineCompleted = baselineDocs.filter(s => s.status === 'completed');
  const baselineDays = new Set(baselineCompleted.map(s => argDay(s.date))).size || 1;
  const baselineDailyRevenue = baselineCompleted.reduce((sum, s) => sum + s.total, 0) / baselineDays;
  const avgDailyRevenue = days ? revenue / days : 0;

  return {
    revenue,
    orders,
    avgTicket: orders ? revenue / orders : 0,
    avgDailyRevenue,
    baselineDailyRevenue,
    lift: baselineDailyRevenue ? Math.round((avgDailyRevenue / baselineDailyRevenue) * 100) / 100 : null,
    officialSharePct: revenue ? Math.round((officialRevenue / revenue) * 1000) / 10 : 0,
    peakDay,
    daily,
    hourly,
  };
}

// ---- Ad investment (Meta + Google) ----

export const AD_PLATFORMS = ['meta', 'google'];
// A day never gets less than 50% or more than 160% of the average daily
// budget: last year's spend barely moved day to day, so we have no evidence
// of how returns hold up far outside that range.
const DAY_BUDGET_MIN = 0.5;
const DAY_BUDGET_MAX = 1.6;
// Platform split stays within 35–65% of a day's budget around the 50/50
// base plan, for the same reason.
const PLATFORM_SHARE_MIN = 0.35;
const PLATFORM_SHARE_MAX = 0.65;
// Budgets are rounded to 1/40 of the daily budget ($100k on $4M) so the
// plan reads as amounts someone can actually load in the ad managers.
const BUDGET_STEPS_PER_DAY = 40;

// date -> { meta: { spend, value }, google: { spend, value } } from the
// Meta and Google daily docs (each with spend + purchaseValue).
export function adsByDate(metaDocs, googleDocs) {
  const map = new Map();
  const get = (date) => {
    if (!map.has(date)) map.set(date, { meta: { spend: 0, value: 0 }, google: { spend: 0, value: 0 } });
    return map.get(date);
  };
  for (const d of metaDocs) { const e = get(d.date).meta; e.spend += d.spend || 0; e.value += d.purchaseValue || 0; }
  for (const d of googleDocs) { const e = get(d.date).google; e.spend += d.spend || 0; e.value += d.purchaseValue || 0; }
  return map;
}

function sumAds(adsMap, dates) {
  const out = { meta: { spend: 0, value: 0 }, google: { spend: 0, value: 0 } };
  for (const date of dates) {
    const a = adsMap.get(date);
    if (!a) continue;
    for (const p of AD_PLATFORMS) { out[p].spend += a[p].spend; out[p].value += a[p].value; }
  }
  return out;
}

function datesBetween(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const roas = (x) => (x.spend ? x.value / x.spend : null);

// Share of real web revenue each platform claims (platform-reported
// purchase value ÷ web revenue) over a recent normal stretch — converts a
// web revenue target into the ROAS each platform needs to report.
export function attributionShares(adsMap, webDailyMap, start, end) {
  const dates = datesBetween(start, end);
  const ads = sumAds(adsMap, dates);
  const web = dates.reduce((s, d) => s + (webDailyMap?.get(d)?.revenue || 0), 0);
  return { meta: web ? ads.meta.value / web : 0, google: web ? ads.google.value / web : 0 };
}

// Fits `total` across days proportionally to `weights`, keeping each day in
// [min, max] (water-filling: clamp, then re-spread the remainder).
export function allocateWithBounds(weights, total, min, max) {
  const n = weights.length;
  const out = Array(n).fill(null);
  let remaining = total;
  let free = weights.map((_, i) => i);
  for (let iter = 0; iter < n + 1 && free.length; iter++) {
    const wSum = free.reduce((s, i) => s + (weights[i] || 0), 0);
    const tentative = free.map(i => (wSum ? remaining * (weights[i] || 0) / wSum : remaining / free.length));
    // Clamp one side per pass: capping the big days frees budget that may
    // lift the small ones above the floor on the next pass.
    const over = free.filter((i, k) => tentative[k] > max);
    const violators = over.length ? over : free.filter((i, k) => tentative[k] < min);
    if (!violators.length) {
      free.forEach((i, k) => { out[i] = tentative[k]; });
      break;
    }
    for (const i of violators) {
      const k = free.indexOf(i);
      out[i] = tentative[k] < min ? min : max;
      remaining -= out[i];
    }
    free = free.filter(i => !violators.includes(i));
  }
  return out;
}

// Proposed spend per day and platform for this year's event, plus the ROAS
// each platform has to report for the day's web revenue target, and the
// phase-level evidence from last year that drives the split.
export function buildInvestmentPlan({ days, current, prevAds, prevBaselineDates, shares }) {
  const daily = current.dailyAdBudget;
  const launchSpend = current.launchHours ? daily * (current.launchHours / 24) : null;
  const step = daily / BUDGET_STEPS_PER_DAY;
  const roundBudget = (v) => Math.round(v / step) * step;
  const fullIdx = days.map((d, i) => i).filter(i => !(days[i].isLaunch && launchSpend != null));
  const alloc = allocateWithBounds(
    fullIdx.map(i => days[i].web.prevRevenue),
    daily * fullIdx.length,
    daily * DAY_BUDGET_MIN,
    daily * DAY_BUDGET_MAX,
  );
  // One flat daily amount per phase (the phase's average of the demand-based
  // allocation): following last year's demand day by day made the budget go
  // up and down in ways nobody can run in the ad managers.
  const phaseFlat = new Map();
  fullIdx.forEach((i, k) => {
    const e = phaseFlat.get(days[i].phase) || { sum: 0, n: 0 };
    e.sum += alloc[k];
    e.n += 1;
    phaseFlat.set(days[i].phase, e);
  });
  const spendByIdx = new Map(fullIdx.map(i => {
    const e = phaseFlat.get(days[i].phase);
    return [i, roundBudget(e.sum / e.n)];
  }));

  const baseline = sumAds(prevAds, prevBaselineDates);
  const phases = ['pre', 'oficial', 'extension'].map((phase) => {
    const phaseDays = days.filter(d => d.phase === phase);
    const ads = sumAds(prevAds, phaseDays.map(d => d.refDate));
    const lift = {};
    for (const p of AD_PLATFORMS) {
      const r = roas(ads[p]);
      const b = roas(baseline[p]);
      lift[p] = r != null && b ? r / b : null;
    }
    let suggestedMetaShare = 0.5;
    if (lift.meta != null && lift.google != null) {
      suggestedMetaShare = Math.min(PLATFORM_SHARE_MAX, Math.max(PLATFORM_SHARE_MIN, 0.5 * lift.meta / ((lift.meta + lift.google) / 2)));
    }
    const prevSpend = ads.meta.spend + ads.google.spend;
    const prevWeb = phaseDays.reduce((s, d) => s + d.web.prevRevenue, 0);
    return {
      phase,
      days: phaseDays.length,
      metaShare: current.metaShare ?? suggestedMetaShare,
      suggestedMetaShare,
      splitFromConfig: current.metaShare != null,
      prev: {
        meta: { ...ads.meta, roas: roas(ads.meta), baselineRoas: roas(baseline.meta), lift: lift.meta },
        google: { ...ads.google, roas: roas(ads.google), baselineRoas: roas(baseline.google), lift: lift.google },
        spend: prevSpend,
        webRevenue: prevWeb,
        mer: prevSpend ? prevWeb / prevSpend : null,
      },
    };
  });
  const shareByPhase = Object.fromEntries(phases.map(p => [p.phase, p.metaShare]));

  const planDays = days.map((d, i) => {
    const spend = spendByIdx.get(i) ?? roundBudget(launchSpend);
    const meta = roundBudget(spend * shareByPhase[d.phase]);
    const google = spend - meta;
    return {
      date: d.date,
      phase: d.phase,
      spend,
      meta,
      google,
      roasTarget: {
        meta: meta ? (shares.meta * d.web.target) / meta : null,
        google: google ? (shares.google * d.web.target) / google : null,
      },
      merTarget: spend ? d.web.target / spend : null,
    };
  });
  for (const p of phases) {
    const pd = planDays.filter(d => d.phase === p.phase);
    p.plan = { spend: pd.reduce((s, d) => s + d.spend, 0), meta: pd.reduce((s, d) => s + d.meta, 0), google: pd.reduce((s, d) => s + d.google, 0) };
    // How many times last year's spend (in today's pesos) each platform is
    // asked to absorb — the further above 1, the less last year's ROAS
    // can be trusted to hold.
    const phaseDays = days.filter(d => d.phase === p.phase);
    p.scale = {};
    for (const platform of AD_PLATFORMS) {
      const prevReal = phaseDays.reduce((s, d) => s + (prevAds.get(d.refDate)?.[platform].spend || 0) * (d.inflationFactor || 1), 0);
      p.scale[platform] = prevReal ? p.plan[platform] / prevReal : null;
    }
  }

  const total = planDays.reduce((s, d) => s + d.spend, 0);
  return { dailyBudget: daily, total, shares, phases, days: planDays };
}

// ---- Live event helpers ----

// Cumulative share (0..1) of completed revenue by the end of each ART hour,
// over all days of the docs — how a typical event day fills up. With no
// sales at all it falls back to an even spread.
export function hourlyShareCurve(salesDocs) {
  const byHour = Array(24).fill(0);
  for (const s of salesDocs) {
    if (s.status !== 'completed') continue;
    byHour[argHour(s.date)] += s.total;
  }
  const total = byHour.reduce((a, b) => a + b, 0);
  if (!total) return Array.from({ length: 24 }, (_, h) => (h + 1) / 24);
  let acc = 0;
  return byHour.map((v) => { acc += v; return acc / total; });
}

// Share of the day's revenue expected by `nowIso`, interpolating inside the
// current ART hour so the pace check doesn't jump on the hour.
export function expectedShare(curve, nowIso) {
  const h = argHour(nowIso);
  const minutes = new Date(new Date(nowIso).getTime() - 3 * 3600 * 1000).getUTCMinutes();
  const before = h > 0 ? curve[h - 1] : 0;
  return before + (minutes / 60) * (curve[h] - before);
}

// Today's status against the part of floor/target expected so far.
export function dayStatusSoFar(cell, share) {
  const denom = cell.target * share;
  return {
    pct: denom ? Math.round((cell.revenue / denom) * 1000) / 10 : null,
    status: denom ? statusOf(cell.revenue, cell.floor * share, denom) : null,
  };
}

// Pace so far (revenue ÷ target of the time elapsed) applied to what's left
// of the window. Today counts only for the share of it already elapsed.
export function projectClose(days, group, todayShare) {
  const played = days.filter(d => d.played);
  if (!played.length) return null;
  const today = played[played.length - 1];
  const revenueToDate = played.reduce((s, d) => s + d[group].revenue, 0);
  const elapsedTarget = played.reduce((s, d) => s + d[group].target * (d === today ? todayShare : 1), 0);
  if (!elapsedTarget) return null;
  const pace = revenueToDate / elapsedTarget;
  const remaining = today[group].target * (1 - todayShare)
    + days.filter(d => !d.played).reduce((s, d) => s + d[group].target, 0);
  return revenueToDate + pace * remaining;
}

// Latest completed sales for the live feed. Only these six fields go out —
// never anything about the customer.
export function recentSales(salesDocs, limit = 12) {
  return salesDocs
    .filter(s => s.status === 'completed')
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit)
    .map((s) => {
      // Negative-price lines are discounts, not products.
      const items = (s.items || []).filter(i => i.unitPrice >= 0);
      const top = items.reduce((best, i) => (!best || i.qty * i.unitPrice > best.qty * best.unitPrice ? i : best), null);
      return {
        date: s.date,
        channel: s.channel,
        province: s.shippingProvince ?? null,
        label: top?.name ?? '',
        itemCount: items.length,
        total: s.total,
      };
    });
}

// Id of the event whose run window contains `today` (ART date), if any.
export function activeEvent(today) {
  for (const [id, e] of Object.entries(EVENTS)) {
    if (e.current.start <= today && today <= e.current.end) return id;
  }
  return null;
}
