// Lo que vuelve en un cambio o devolución. Todo puro: la E/S vive en
// posReturnsService / posReturnsOdoo / posOrders. Una línea que vuelve se arma
// SIEMPRE desde la compra leída en el servidor (nunca con valores del cliente).
import { round2 } from './posPricing.mjs';
import { activeLines } from './posLines.mjs';

export const RETURN_SOURCES = ['app', 'tpv', 'web', 'manual'];
export const SOURCE_LABELS = { app: 'Local', tpv: 'TPV', web: 'Web', manual: 'Sin ticket' };
export const OTHER_REASON = 'Otro';

const pesos = (n) => `$ ${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;

export const maxReturnable = (pl) => Math.max(0, (pl.qtyBought ?? 0) - (pl.qtyReturnedBefore ?? 0));

const lineKey = (l) => `${l.source}:${l.purchaseLineId ?? `p${l.productId}`}`;

export function validateReturnLine(rl, { destinationIds, reasons }) {
  const errors = [];
  const sku = rl.sku ?? 'un producto';
  if (!RETURN_SOURCES.includes(rl.source)) errors.push(`${sku}: origen de la compra inválido`);
  if (!Number.isInteger(rl.qty) || rl.qty < 1) errors.push(`${sku}: cantidad inválida`);
  else if (rl.source !== 'manual' && rl.qty > maxReturnable(rl)) errors.push(`${sku}: se pueden devolver hasta ${maxReturnable(rl)}`);
  if (!Number.isFinite(rl.unitValue) || rl.unitValue < 0) errors.push(`${sku}: valor inválido`);
  if (!destinationIds.includes(rl.destinationId)) errors.push(`${sku}: elegí el destino`);
  if (!reasons.includes(rl.reason)) errors.push(`${sku}: elegí el motivo`);
  else if (rl.reason === OTHER_REASON && !String(rl.reasonNote ?? '').trim()) errors.push(`${sku}: con "Otro" escribí el motivo`);
  return errors;
}

export function nextReturnLineId(returnLines) {
  const max = returnLines.reduce((m, l) => Math.max(m, Number(String(l.rlId ?? '').replace('R', '')) || 0), 0);
  return `R${max + 1}`;
}

export function buildReturnLine(purchaseLine, { qty = 1, destinationId, reason, reasonNote = '' }, returnLines, ctx) {
  if (returnLines.some((l) => lineKey(l) === lineKey(purchaseLine))) {
    throw new Error(`${purchaseLine.sku} ya está en lo que vuelve: cambiá la cantidad`);
  }
  const rl = {
    ...purchaseLine, rlId: nextReturnLineId(returnLines), qty, destinationId, reason,
    reasonNote: String(reasonNote ?? '').trim().slice(0, 200),
  };
  const errors = validateReturnLine(rl, ctx);
  if (errors.length) throw new Error(errors.join('; '));
  return rl;
}

export function editReturnLine(rl, changes, ctx) {
  const next = { ...rl };
  for (const field of ['qty', 'destinationId', 'reason', 'reasonNote']) {
    if (changes[field] !== undefined) next[field] = field === 'reasonNote' ? String(changes[field]).trim().slice(0, 200) : changes[field];
  }
  const errors = validateReturnLine(next, ctx);
  if (errors.length) throw new Error(errors.join('; '));
  return next;
}

export const returnTotal = (returnLines) => round2((returnLines ?? []).reduce((s, l) => s + l.qty * l.unitValue, 0));

export function orderKind({ lines, returnLines }) {
  if (!returnLines?.length) return 'venta';
  return activeLines(lines).length ? 'cambio' : 'devolucion';
}

// Valor unitario con IVA de lo que pagó el cliente.
export const appUnitValue = (line, lineDiscountPct) => round2(line.basePrice * (1 - (lineDiscountPct ?? 0) / 100));
export const tpvUnitValue = (posLine) => (posLine.qty > 0 ? round2(posLine.price_subtotal_incl / posLine.qty) : 0);
export const webUnitValue = (saleLine) => (saleLine.product_uom_qty > 0 ? round2(saleLine.price_total / saleLine.product_uom_qty) : 0);

// Neto negativo: hay que devolverle al cliente -net, repartido entre reintegro
// (por medio) y saldo a favor. Tiene que sumar exacto.
export function validateRefund(refund, net, methodsById) {
  if (!(net < 0)) return null;
  const due = round2(-net);
  if (!refund) throw new Error('Elegí cómo se devuelve: reintegro y/o saldo a favor');
  const seen = new Set();
  const cashBack = (refund.cashBack ?? []).map(({ methodId, amount }) => {
    const method = methodsById.get(methodId);
    if (!method || method.active === false || methodId === 'saldo') throw new Error(`Medio de reintegro inválido: ${methodId}`);
    if (seen.has(methodId)) throw new Error(`${method.label} está repetido en el reintegro`);
    seen.add(methodId);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Monto de reintegro inválido para ${method.label}`);
    return { methodId, amount: round2(n) };
  });
  const credit = round2(Number(refund.credit ?? 0));
  if (!Number.isFinite(credit) || credit < 0) throw new Error('Saldo a favor inválido');
  const sum = round2(cashBack.reduce((s, c) => s + c.amount, 0) + credit);
  if (Math.abs(sum - due) >= 0.01) throw new Error(`El reintegro suma ${pesos(sum)} y hay que devolver ${pesos(due)}: corregí los montos`);
  return { cashBack, credit };
}

export function invoiceGroups(returnLines) {
  const groups = new Map();
  for (const l of returnLines ?? []) {
    if (!l.invoiceId) continue;
    if (!groups.has(l.invoiceId)) groups.set(l.invoiceId, { invoiceId: l.invoiceId, invoiceName: l.invoiceName, lines: [] });
    groups.get(l.invoiceId).lines.push(l);
  }
  return [...groups.values()];
}
