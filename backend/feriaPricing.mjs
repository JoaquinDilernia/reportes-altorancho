export const PAYMENT_METHODS = {
  transferencia: { label: 'Transferencia', discountPct: 20 },
  efectivo: { label: 'Efectivo', discountPct: 15 },
  cuotas: { label: '3 cuotas', discountPct: 0 },
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
