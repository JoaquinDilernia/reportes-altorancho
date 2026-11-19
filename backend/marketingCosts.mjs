// Costos de canales que no tienen API conectada: gasto de Pinterest (a mano,
// por mes, hasta que se conecte su API) y el abono de Perfit (fijo por mes).
// Se guardan por mes y se prorratean por día para cualquier período.
import { getDb } from './firestore.mjs';

const DOC = ['config', 'marketing_costs'];
export const COST_KEYS = ['pinterest', 'perfit'];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_PERFIT = Number(process.env.PERFIT_MONTHLY_COST || 500000);

const daysInMonth = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const addDay = (ymd) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

// Valor del mes: lo cargado; para Perfit, si no se cargó, el abono por defecto.
export function monthlyCost(costs, key, ym) {
  const v = costs?.[key]?.[ym];
  if (typeof v === 'number' && v >= 0) return v;
  return key === 'perfit' ? DEFAULT_PERFIT : null;
}

// Costo prorrateado de [start, end] (YYYY-MM-DD), sin pasar de `today`.
// null si algún mes del rango no tiene valor (no se inventa un gasto).
export function costForRange(costs, key, { start, end }, today) {
  const last = today && end > today ? today : end;
  if (last < start) return { cost: 0, months: [], missing: [] };
  let cost = 0;
  const months = new Set();
  const missing = new Set();
  for (let d = start; d <= last; d = addDay(d)) {
    const ym = d.slice(0, 7);
    months.add(ym);
    const m = monthlyCost(costs, key, ym);
    if (m == null) { missing.add(ym); continue; }
    cost += m / daysInMonth(ym);
  }
  return { cost: missing.size ? null : Math.round(cost), months: [...months], missing: [...missing] };
}

export async function getMarketingCosts() {
  const snap = await getDb().collection(DOC[0]).doc(DOC[1]).get();
  return snap.exists ? snap.data() : {};
}

// patch: { key, month, value } — value null borra el mes
export async function setMarketingCost({ key, month, value }) {
  if (!COST_KEYS.includes(key)) throw Object.assign(new Error('canal inválido'), { status: 400 });
  if (!MONTH.test(month || '')) throw Object.assign(new Error('mes inválido (AAAA-MM)'), { status: 400 });
  if (value !== null && !(Number.isFinite(value) && value >= 0 && value <= 1e10)) throw Object.assign(new Error('monto inválido'), { status: 400 });
  const ref = getDb().collection(DOC[0]).doc(DOC[1]);
  const cur = (await ref.get()).data() || {};
  const byMonth = { ...(cur[key] || {}) };
  if (value === null) delete byMonth[month];
  else byMonth[month] = Math.round(value);
  await ref.set({ ...cur, [key]: byMonth, updatedAt: new Date().toISOString() });
  return { [key]: byMonth };
}
