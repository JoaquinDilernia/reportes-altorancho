function pad(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }

function mondayOf(d) {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday;
}

function firstDayOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function lastDayOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function shiftMonths(d, delta) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, d.getUTCDate()));
}

function shiftYears(d, delta) {
  return new Date(Date.UTC(d.getUTCFullYear() + delta, d.getUTCMonth(), d.getUTCDate()));
}

export function getPeriodRanges(dateStr, period) {
  const date = new Date(`${dateStr}T00:00:00Z`);

  let start, end;
  if (period === 'week') {
    start = mondayOf(date);
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
  } else if (period === 'month') {
    start = firstDayOfMonth(date);
    end = lastDayOfMonth(date);
  } else {
    throw new Error(`Unknown period: ${period}`);
  }

  const current = { start: toISODate(start), end: toISODate(end) };

  let prevPeriod;
  if (period === 'week') {
    const ps = new Date(start); ps.setUTCDate(start.getUTCDate() - 7);
    const pe = new Date(end);   pe.setUTCDate(end.getUTCDate() - 7);
    prevPeriod = { start: toISODate(ps), end: toISODate(pe) };
  } else {
    const prevMonthAnchor = shiftMonths(start, -1);
    prevPeriod = {
      start: toISODate(firstDayOfMonth(prevMonthAnchor)),
      end: toISODate(lastDayOfMonth(prevMonthAnchor)),
    };
  }

  const prevMonth = {
    start: toISODate(shiftMonths(start, -1)),
    end: toISODate(shiftMonths(end, -1)),
  };

  const prevYear = {
    start: toISODate(shiftYears(start, -1)),
    end: toISODate(shiftYears(end, -1)),
  };

  return { current, prevPeriod, prevMonth, prevYear };
}
