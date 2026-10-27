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
  return { prevRevenue: 0, prevOrders: 0, target: 0, revenue: 0, orders: 0 };
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
        cell.target += hasHistory[c]
          ? (prev?.revenue || 0) * factor * (1 + growth[group])
          : baselineByChannel[c][weekdayOf(day.date)];
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
    const t = { prevRevenue: 0, prevOrders: 0, target: 0, targetToDate: 0, revenue: 0, orders: 0 };
    for (const d of days) {
      const cell = d[group];
      t.prevRevenue += cell.prevRevenue;
      t.prevOrders += cell.prevOrders;
      t.target += cell.target;
      if (d.played) {
        t.targetToDate += cell.target;
        t.revenue += cell.revenue;
        t.orders += cell.orders;
      }
    }
    t.progressPct = t.target ? Math.round((t.revenue / t.target) * 1000) / 10 : null;
    t.vsTargetToDatePct = t.targetToDate ? Math.round((t.revenue / t.targetToDate) * 1000) / 10 : null;
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
