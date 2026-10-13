// Precios del POS. Todo con IVA (lo que ve el cliente); a Odoo viaja sin IVA
// porque los productos tienen "IVA 21% Ventas" no incluido en el precio.
// Cascada: productos → descuento por medio de pago → subtotal → descuento
// extra sobre el subtotal → + envío (sin descuentos).
export const IVA_RATE = 0.21;
export const round2 = (n) => Math.round(n * 100) / 100;
export const withIva = (net) => round2(net * (1 + IVA_RATE));
export const netOfIva = (gross) => round2(gross / (1 + IVA_RATE));

export function basePriceOf({ fullPrice, promoPrice }) {
  if (typeof promoPrice === 'number' && promoPrice > 0 && promoPrice < fullPrice) return promoPrice;
  return fullPrice;
}

function methodOf(methodsById, methodId) {
  const method = methodsById.get(methodId);
  if (!method) throw new Error(`Medio de pago inválido: ${methodId}`);
  return method;
}

// Pago dividido: manda el medio con menos descuento (50 % transferencia +
// 50 % tarjeta → sin el descuento de transferencia).
export function paymentDiscountPct(payments, methodsById) {
  if (!payments?.length) return 0;
  return Math.min(...payments.map((p) => methodOf(methodsById, p.methodId).discountPct));
}

export function principalPayment(payments, methodsById) {
  if (!payments?.length) throw new Error('Cargá al menos un medio de pago');
  let best = payments[0];
  for (const p of payments) {
    if (methodOf(methodsById, p.methodId).discountPct < methodOf(methodsById, best.methodId).discountPct) best = p;
  }
  return { methodId: best.methodId, detailId: best.detailId ?? null };
}

export function extraDiscountAmount(extra, subtotal) {
  if (!extra || subtotal <= 0) return 0;
  if (extra.type === 'pct') return round2(subtotal * extra.value / 100);
  if (extra.type === 'amount') return round2(Math.min(extra.value, subtotal));
  throw new Error(`Tipo de descuento inválido: ${extra.type}`);
}

export function computeTotals({ lines, payments, methodsById, extraDiscount = null, shippingAmount = 0 }) {
  const active = (lines ?? []).filter((l) => l.status !== 'eliminado');
  const products = round2(active.reduce((sum, l) => sum + l.qty * l.basePrice, 0));
  const paymentPct = paymentDiscountPct(payments, methodsById);
  const paymentDiscount = round2(products * paymentPct / 100);
  const subtotal = round2(products - paymentDiscount);
  const extra = extraDiscountAmount(extraDiscount, subtotal);
  const shipping = round2(shippingAmount || 0);
  const total = round2(subtotal - extra + shipping);
  // Un solo % por línea en Odoo que reproduce la cascada (puede diferir en
  // centavos del total de la app por el redondeo de Odoo).
  const extraPct = subtotal > 0 ? extra / subtotal : 0;
  const lineDiscountPct = products > 0 ? round2(100 * (1 - (1 - paymentPct / 100) * (1 - extraPct))) : 0;
  return { products, paymentPct, paymentDiscount, subtotal, extraDiscount: extra, shipping, total, lineDiscountPct };
}
