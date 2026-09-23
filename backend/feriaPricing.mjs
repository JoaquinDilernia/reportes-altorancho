export const PAYMENT_METHODS = {
  // odooName: nombre exacto del payment.method en Odoo (campo "Medio de
  // pago" del sale.order).
  transferencia: { label: 'Transferencia', discountPct: 15, odooName: 'Transferencia' },
  efectivo: { label: 'Efectivo', discountPct: 10, odooName: 'Efectivo' },
  mp_debito: { label: 'Mercado Pago Débito', discountPct: 0, odooName: 'Mercado Pago Debito' },
  mp_1_cuota: { label: 'Mercado Pago 1 cuota', discountPct: 0, odooName: 'Mercado Pago 1 cuota' },
  mp_3_cuotas: { label: 'Mercado Pago 3 cuotas', discountPct: 0, odooName: 'Mercado Pago 3 cuotas' },
};

// Precios que ve el cliente en el buscador público: los tres de Mercado Pago
// tienen el mismo precio, así que se muestran como uno solo (`method` es el
// medio de pago con el que se calcula ese precio).
export const PUBLIC_PRICE_OPTIONS = [
  { key: 'transferencia', label: 'Transferencia', method: 'transferencia' },
  { key: 'efectivo', label: 'Efectivo', method: 'efectivo' },
  { key: 'mercadopago', label: 'Mercado Pago (débito o cuotas)', method: 'mp_debito' },
];

const CONDITIONS = new Set(['falla', 'discontinuo']);

// Todos los productos de la feria tienen "IVA 21% Ventas" en Odoo con el
// impuesto NO incluido en el precio: si mandáramos el precio de la tabla
// (que ya incluye IVA) Odoo le sumaría el 21% arriba. Por eso a Odoo viaja
// el precio neto y Odoo recompone el total que paga el cliente.
export const IVA_RATE = 0.21;

// Cargo fijo de envío a domicilio, por pedido, con IVA incluido y sin
// descuento por medio de pago.
export const SHIPPING_COST = 10000;

export function netOfIva(price) {
  return Math.round((price / (1 + IVA_RATE)) * 100) / 100;
}

export function activeRebajaField(condition) {
  if (!CONDITIONS.has(condition)) throw new Error(`Condición inválida: ${condition}`);
  return condition === 'falla' ? 'rebajaFallaActiva' : 'rebajaDiscontinuoActiva';
}

// El producto con otra rebaja activa para esa condición (sin tocar el original).
export function withRebaja(product, condition, level) {
  const field = activeRebajaField(condition);
  if (![0, 1, 2].includes(level)) throw new Error(`Nivel de rebaja inválido: ${level}`);
  return { ...product, [field]: level };
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

// Lo que sale un producto en cada nivel de rebaja de una condición, con los
// tres precios que ve el cliente: para que Caja elija la rebaja sabiendo el
// precio final. Los niveles sin precio en el Excel no se ofrecen.
export function rebajaLevels(product, condition) {
  return [0, 1, 2]
    .map((level) => ({ level, precioTabla: tablePrice(product, condition, level) }))
    .filter((l) => l.precioTabla != null)
    .map((l) => ({
      ...l,
      precios: Object.fromEntries(PUBLIC_PRICE_OPTIONS.map(({ key, method }) => [
        key, computeFinalPrice(product, condition, l.level, method),
      ])),
    }));
}

// Precio y descuento de una línea tal como viajan a Odoo: price_unit es el
// precio de tabla completo (condición + rebaja, SIN el descuento del medio de
// pago) y SIN IVA — Odoo agrega el impuesto — y el descuento del medio de
// pago va en el campo discount de la línea.
// Los pedidos creados antes de guardar listPrice solo tienen el unitPrice ya
// descontado: se reconstruye el precio de tabla deshaciendo el porcentaje.
export function odooLinePricing(line, paymentMethod) {
  const method = PAYMENT_METHODS[paymentMethod];
  if (!method) throw new Error(`Método de pago inválido: ${paymentMethod}`);
  const grossListPrice = line.listPrice ?? Math.round(line.unitPrice / (1 - method.discountPct / 100));
  return { unitPrice: netOfIva(grossListPrice), discountPct: method.discountPct };
}
