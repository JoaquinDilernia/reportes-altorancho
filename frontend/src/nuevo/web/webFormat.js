import { pct } from '../format.js';

// GA4 rates come as fractions (0.0046 = 0,46%).
export function rate(v, decimals = 2) {
  return v == null || !Number.isFinite(v) ? '—' : pct(v * 100, { decimals });
}

export function mmss(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Conversion change in percentage points (both are fractions).
export function convPpDelta(cur, prev) {
  return cur == null || prev == null ? null : (cur - prev) * 100;
}

const SOURCES = {
  'Cross-network': 'Google PMax / Demand Gen',
  'Paid Social': 'Redes pagas (Meta)',
  'Paid Search': 'Google búsqueda paga',
  'Organic Social': 'Redes orgánicas',
  Direct: 'Directo',
  Email: 'Email',
  'Organic Search': 'Google orgánico',
  Unassigned: 'Sin asignar',
  'Organic Video': 'Video orgánico',
  Referral: 'Referidos',
  'Organic Shopping': 'Shopping orgánico',
  'Paid Shopping': 'Shopping pago',
  Display: 'Display',
  'AI Assistant': 'Asistentes de IA',
  'Paid Other': 'Otros pagos',
};
export const sourceLabel = (k) => SOURCES[k] ?? k;
export const DEVICES = { mobile: 'Celular', desktop: 'Computadora', tablet: 'Tablet', 'smart tv': 'Smart TV' };
export const VISITORS = { new: 'Nuevos', returning: 'Ya conocían el sitio' };

// Same rule as the Resumen alert (alertConfig.mjs: sourceMinShare 0.10,
// sourceConvRatio 1/3): a big source converting under a third of the site.
const MIN_SHARE = 0.10;
const CONV_RATIO = 1 / 3;
export function weakSources(rows, siteConversion) {
  const total = rows.reduce((s, r) => s + (r.cur?.sessions || 0), 0);
  const out = new Set();
  if (!total || siteConversion == null) return out;
  for (const r of rows) {
    if (!r.cur) continue;
    if (r.cur.sessions / total >= MIN_SHARE && (r.cur.conversion ?? 0) < siteConversion * CONV_RATIO) out.add(r.key);
  }
  return out;
}
