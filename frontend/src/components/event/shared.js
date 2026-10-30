// Small formatting bits shared by the live event components.
import { STATUS_LABELS } from '../../lib/eventLive.js';

const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function shortDate(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${Number(day)}/${Number(month)}`;
}

export function weekday(dateStr) {
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

export function dayLabel(dateStr) {
  return `${weekday(dateStr)} ${shortDate(dateStr)}`;
}

export const ratio = (value, spend) => (spend ? value / spend : null);

export function roasText(v) {
  return v == null ? '—' : `${v.toFixed(1).replace('.', ',')}x`;
}

export function pctText(v, { sign = false } = {}) {
  if (v == null) return '—';
  const r = Math.round(v);
  return `${sign && r > 0 ? '+' : ''}${r}%`;
}

// Status -> chip color. null means "nothing to compare": neutral, never green.
export function statusClass(status) {
  return { sobre: 'g', entre: 'y', bajo_piso: 'r' }[status] || '';
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || 'sin datos';
}

export const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

// Sums an ads block ({ meta:{spend,value}, google:{spend,value} }) over days.
export function sumAds(days, pick) {
  const t = { meta: { spend: 0, value: 0 }, google: { spend: 0, value: 0 } };
  for (const d of days) {
    const a = pick(d);
    if (!a) continue;
    for (const p of ['meta', 'google']) {
      t[p].spend += a[p]?.spend || 0;
      t[p].value += a[p]?.value || 0;
    }
  }
  return t;
}

export const VIEW_LABELS = { total: 'web + locales', web: 'web', locales: 'locales' };
