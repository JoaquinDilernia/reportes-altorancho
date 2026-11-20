// Regla dura de pausa automática: solo campañas de ventas, con gasto sobre el mínimo y cero compras.
const money = (v) => '$' + Math.round(Number(v) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export function checkAutoPause({ settings = {}, family, spend, purchases }) {
  const min = Number(settings.auto_pause_min_spend_ars) || 0;
  const days = settings.auto_pause_days ?? 7;
  if (!settings.autonomous) return { ok: false, reason: 'pausa automática apagada' };
  if (!(min > 0)) return { ok: false, reason: 'sin mínimo de gasto cargado' };
  if (!Number.isFinite(spend) || !Number.isFinite(purchases)) return { ok: false, reason: 'faltan datos de gasto o compras' };
  if (family !== 'sales') return { ok: false, reason: 'no es una campaña de ventas' };
  if (spend < min) return { ok: false, reason: `gastó ${money(spend)}, no llega al mínimo de ${money(min)} en ${days} días` };
  if (purchases > 0) return { ok: false, reason: `tuvo ${purchases} compras` };
  return { ok: true, reason: `gastó ${money(spend)} sin compras en ${days} días (mínimo ${money(min)})` };
}
