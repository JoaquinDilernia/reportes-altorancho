export const PAYMENT_METHODS = {
  // odooName: nombre exacto del payment.method en Odoo (campo "Medio de
  // pago" del sale.order).
  transferencia: { label: 'Transferencia', discountPct: 20, odooName: 'Transferencia' },
  efectivo: { label: 'Efectivo', discountPct: 15, odooName: 'Efectivo' },
  cuotas: { label: '3 cuotas', discountPct: 0, odooName: 'Mercado Pago 3 cuotas' },
};

const CONDITIONS = new Set(['falla', 'discontinuo']);

export function activeRebajaField(condition) {
  if (!CONDITIONS.has(condition)) throw new Error(`Condición inválida: ${condition}`);
  return condition === 'falla' ? 'rebajaFallaActiva' : 'rebajaDiscontinuoActiva';
}

// Precio de tabla para una condición (falla/discontinuo) según el nivel de
// rebaja vigente para ESA condición en ese SKU. Devuelve null si el SKU no
// tiene precio cargado para esa condición (no todos los SKU tienen las dos).
export function tablePrice(product, condition, rebajaLevel) {
  if (!CONDITIONS.has(condition)) throw new Error(`Condición inválida: ${condition}`);
  if (rebajaLevel !== 0 && rebajaLevel !== 1 && rebajaLevel !== 2) {
    throw new Error(`Nivel de rebaja inválido: ${rebajaLevel}`);
  }
  const suffix = condition === 'falla' ? 'Falla' : 'Discontinuo';
  const field = rebajaLevel === 1 ? `precioRebaja1${suffix}`
    : rebajaLevel === 2 ? `precioRebaja2${suffix}`
    : `precio${suffix}`;
  return product[field] ?? null;
}

// Precio final que paga el cliente: precio de tabla (condición + rebaja
// activa de esa condición) con el descuento fijo del medio de pago elegido.
// Devuelve null si el SKU no tiene precio cargado para esa condición.
export function computeFinalPrice(product, condition, rebajaLevel, paymentMethod) {
  const method = PAYMENT_METHODS[paymentMethod];
  if (!method) throw new Error(`Método de pago inválido: ${paymentMethod}`);
  const base = tablePrice(product, condition, rebajaLevel);
  if (base == null) return null;
  return Math.round(base * (1 - method.discountPct / 100));
}

// Precio y descuento de una línea tal como viajan a Odoo: price_unit es el
// precio de tabla completo (condición + rebaja, SIN el descuento del medio de
// pago) y el descuento del medio de pago va en el campo discount de la línea,
// para que en Odoo se vea qué parte del precio es rebaja por medio de pago.
// Los pedidos creados antes de guardar listPrice solo tienen el unitPrice ya
// descontado: se reconstruye el precio de tabla deshaciendo el porcentaje.
export function odooLinePricing(line, paymentMethod) {
  const method = PAYMENT_METHODS[paymentMethod];
  if (!method) throw new Error(`Método de pago inválido: ${paymentMethod}`);
  const unitPrice = line.listPrice ?? Math.round(line.unitPrice / (1 - method.discountPct / 100));
  return { unitPrice, discountPct: method.discountPct };
}
