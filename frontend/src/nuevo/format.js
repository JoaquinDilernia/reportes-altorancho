// Number formatting for the new report (es-AR, real minus sign U+2212).
const MINUS = '−';
const EMPTY = '—';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, decimals) => v.toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

// $412M · $9,8M · $321K · $950
export function money(v) {
  if (!isNum(v)) return EMPTY;
  const a = Math.abs(v);
  let body;
  if (a >= 10e6) body = `${fmt(Math.round(a / 1e6), 0)}M`;
  else if (a >= 1e6) body = `${fmt(Math.round(a / 1e5) / 10, 1)}M`;
  else if (a >= 1e3) body = `${fmt(Math.round(a / 1e3), 0)}K`;
  else body = fmt(Math.round(a), 0);
  return `${v < 0 ? MINUS : ''}$${body}`;
}

// +6% · −3% · 0,46%
export function pct(v, { sign = false, decimals = 0 } = {}) {
  if (!isNum(v)) return EMPTY;
  const r = Math.abs(v).toFixed(decimals) === (0).toFixed(decimals) ? 0 : v;
  const s = r < 0 ? MINUS : sign && r > 0 ? '+' : '';
  return `${s}${fmt(Math.abs(r), decimals)}%`;
}

// −0,08 pp (percentage points), up to 2 decimals.
export function pp(v) {
  if (!isNum(v)) return EMPTY;
  const s = v < 0 ? MINUS : v > 0 ? '+' : '';
  return `${s}${Math.abs(v).toLocaleString('es-AR', { maximumFractionDigits: 2 })} pp`;
}

export function num(v) {
  return isNum(v) ? fmt(Math.round(v), 0) : EMPTY;
}

// Tone of a change: up / down / neutral (|v| below `flat` counts as flat).
export function toneOf(v, flat = 0.5) {
  if (!isNum(v) || Math.abs(v) < flat) return 'nt';
  return v > 0 ? 'up' : 'dn';
}
