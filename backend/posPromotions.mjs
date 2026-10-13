// Descuentos extra sobre el subtotal (después del descuento por medio de
// pago). Uno solo por pedido: el que elige caja (cupón o motivo) o, si no
// eligió nada, el automático que corresponda (decorador/arquitecto).
import { getDb } from './firestore.mjs';

const COLLECTION = 'pos_promotions';
const KINDS = ['cupon', 'motivo', 'auto'];

// Fechas 'YYYY-MM-DD' en hora de Argentina; "hasta" incluye el día entero.
const dayStart = (ymd) => new Date(`${ymd}T00:00:00-03:00`).getTime();
const dayEnd = (ymd) => new Date(`${ymd}T23:59:59.999-03:00`).getTime();

export function isPromotionActive(promo, now = Date.now()) {
  if (promo.active === false) return false;
  if (promo.from && now < dayStart(promo.from)) return false;
  if (promo.to && now > dayEnd(promo.to)) return false;
  return true;
}

export function promotionApplies(promo, { paymentMethodIds = [], customerTagIds = [], now = Date.now() }) {
  if (!isPromotionActive(promo, now)) return { ok: false, reason: `${promo.name} no está vigente` };
  if (promo.requiresPaymentMethodId && (paymentMethodIds.length === 0 || paymentMethodIds.some((m) => m !== promo.requiresPaymentMethodId))) {
    return { ok: false, reason: `${promo.name} vale solo con ${promo.requiresPaymentMethodId}` };
  }
  if (promo.requiresCustomerTagId && !customerTagIds.includes(promo.requiresCustomerTagId)) {
    return { ok: false, reason: `${promo.name} es solo para clientes con esa etiqueta en Odoo` };
  }
  return { ok: true };
}

const asDiscount = (p) => ({ promotionId: p.id, name: p.name, type: p.type, value: p.value });

export function resolveExtraDiscount(promotions, { code, promotionId } = {}, ctx) {
  let chosen = null;
  if (code) {
    const wanted = String(code).trim().toUpperCase();
    const matches = promotions.filter((p) => p.kind === 'cupon' && String(p.code ?? '').toUpperCase() === wanted);
    if (!matches.length) throw new Error(`El cupón ${wanted} no existe`);
    chosen = matches.find((p) => isPromotionActive(p, ctx.now)) ?? matches[0];
  } else if (promotionId) {
    chosen = promotions.find((p) => p.id === promotionId && p.kind !== 'cupon');
    if (!chosen) throw new Error('Ese descuento no existe');
  }
  if (chosen) {
    const check = promotionApplies(chosen, ctx);
    if (!check.ok) throw new Error(check.reason);
    return asDiscount(chosen);
  }
  const auto = promotions.find((p) => p.kind === 'auto' && promotionApplies(p, ctx).ok);
  return auto ? asDiscount(auto) : null;
}

export function validatePromotion(input, others) {
  const errors = [];
  if (!String(input.name ?? '').trim()) errors.push('Falta el nombre');
  if (!KINDS.includes(input.kind)) errors.push('Tipo de promoción inválido');
  if (input.type === 'pct') {
    if (!(input.value >= 1 && input.value <= 100)) errors.push('El porcentaje tiene que estar entre 1 y 100');
  } else if (input.type === 'amount') {
    if (!(typeof input.value === 'number' && input.value > 0)) errors.push('El monto tiene que ser mayor a 0');
  } else {
    errors.push('Elegí porcentaje o monto');
  }
  if (input.kind === 'cupon') {
    const code = String(input.code ?? '').trim().toUpperCase();
    if (!code) errors.push('El cupón necesita un código');
    else if (others.some((p) => p.id !== input.id && p.kind === 'cupon' && p.active !== false && String(p.code).toUpperCase() === code)) {
      errors.push('Ya hay un cupón activo con ese código');
    }
  }
  if (input.from && input.to && input.from > input.to) errors.push('La fecha "desde" es posterior a "hasta"');
  return errors;
}

export async function listPromotions() {
  const snap = await getDb().collection(COLLECTION).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function listActivePromotions(now = Date.now()) {
  return (await listPromotions()).filter((p) => isPromotionActive(p, now));
}

export async function savePromotion(id, input) {
  const all = await listPromotions();
  const clean = {
    name: String(input.name ?? '').trim(), kind: input.kind, type: input.type, value: Number(input.value),
    code: input.kind === 'cupon' ? String(input.code ?? '').trim().toUpperCase() : null,
    active: input.active !== false, from: input.from || null, to: input.to || null,
    requiresPaymentMethodId: input.requiresPaymentMethodId || null,
    requiresCustomerTagId: input.requiresCustomerTagId ? Number(input.requiresCustomerTagId) : null,
  };
  const errors = validatePromotion({ ...clean, id }, all);
  if (errors.length) throw new Error(errors.join('; '));
  const col = getDb().collection(COLLECTION);
  if (id) {
    await col.doc(id).set({ ...clean, updatedAt: new Date() });
    return id;
  }
  const ref = await col.add({ ...clean, createdAt: new Date(), updatedAt: new Date() });
  return ref.id;
}
