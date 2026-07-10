function pad(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }

function mondayOf(d) {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday;
}

export function shiftPeriod(dateStr, period, direction) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (period === 'week') {
    date.setUTCDate(date.getUTCDate() + 7 * direction);
    return toISODate(date);
  }
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, 1));
  return toISODate(target);
}

const WEEKDAY_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const FULL_MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export function formatPeriodLabel(dateStr, period) {
  const date = new Date(`${dateStr}T00:00:00Z`);

  if (period === 'month') {
    return `${FULL_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }

  const start = mondayOf(date);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startLabel = sameMonth
    ? `${start.getUTCDate()}`
    : `${start.getUTCDate()} ${WEEKDAY_MONTHS[start.getUTCMonth()]}`;

  return `${startLabel} – ${end.getUTCDate()} ${WEEKDAY_MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}
