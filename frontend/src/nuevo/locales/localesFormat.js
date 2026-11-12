// Locales tab helpers.

// Heat level 0..4 of a cell relative to the busiest one (0 = empty).
export function heatLevel(n, max) {
  if (!(n > 0) || !(max > 0)) return 0;
  return Math.min(4, Math.ceil((n / max) * 4));
}

// Units per ticket: "1,5" · "2,78" · "—".
export function upt(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('es-AR', { maximumFractionDigits: 2 }) : '—';
}
