import { SOURCE_LABEL, SOURCE_COLOR } from '../pautaReal/prFormat.js';

const SHORT = { meta: 'Meta', google: 'Google', pinterest: 'Pinterest', organic: 'Orgánico', social_organic: 'Redes', social: 'Redes', email: 'Email', other: 'Otro link', unknown: 'Sin dato' };
export const chShort = (c) => SHORT[c] || c || '—';
export const chLong = (c) => SOURCE_LABEL[c] || (c === 'social' ? SOURCE_LABEL.social_organic : chShort(c));
export const chColor = (c) => SOURCE_COLOR[c] || (c === 'social' ? SOURCE_COLOR.social_organic : '#9a9897');

const TZ = 'America/Argentina/Buenos_Aires';
export function when(iso, { date = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  const t = d.toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  if (!date) return t;
  return `${d.toLocaleDateString('es-AR', { timeZone: TZ, day: 'numeric', month: 'short' })} · ${t}`;
}
export function longDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('es-AR', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

// 85 → "1 h 25 min"; 3000 → "2 días"
export function duration(min) {
  if (min == null) return '—';
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return `${Math.round(min / 1440)} días`;
}

export const CUSTOMER = {
  nuevo: { label: 'Nuevo', tone: 'new' },
  recurrente: { label: 'Recurrente', tone: 'ret' },
  'sin-dato': { label: 'Sin dato', tone: 'nt' },
};
