// Arma el borrador de una solicitud web desde lo que manda el panel o el bot.
// Lo que sale del pedido (valores, movimientos, fecha, plazo) lo pone el
// servidor: el cliente nunca manda unitValue, moveIds ni la compra.
import { validateDraft, isLate } from './posWebReturns.mjs';
import { resolveWebPurchase, resolveReturnLine } from './posWebReturnsPurchase.mjs';

const CUSTOMER_FIELDS = ['name', 'phone', 'email', 'doc', 'address', 'zone'];
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export async function buildDraftFromInput(input, { channel, settings, now = new Date(), resolve = resolveWebPurchase, evidence = [], logisticsExtra = {} } = {}) {
  const i = input || {};
  const tnNumber = String(i.tnNumber ?? '').trim();
  if (!tnNumber) throw new Error('Falta el número de pedido');
  const { tn, purchase } = await resolve(tnNumber);
  const returnLines = (Array.isArray(i.returnLines) ? i.returnLines : []).map((l) => ({
    ...resolveReturnLine(purchase, { purchaseLineId: l?.purchaseLineId, qty: l?.qty }),
    destinationId: l?.destinationId ?? null,
  }));
  const nowISO = (now instanceof Date ? now : new Date(now)).toISOString();
  const customer = {
    name: tn?.customer?.name ?? '', phone: tn?.customer?.phone ?? '', email: tn?.customer?.email ?? '',
    doc: tn?.customer?.identification ?? '', address: tn?.shippingAddress ?? '',
  };
  for (const k of CUSTOMER_FIELDS) if (nonEmpty(i.customer?.[k])) customer[k] = i.customer[k];
  const lg = i.logistics || {};
  const draft = {
    kind: i.kind, reason: i.reason, reasonLabel: i.reasonLabel, reasonNote: i.reasonNote, productOrigin: i.productOrigin,
    channel, botConversationId: i.botConversationId ?? null,
    customer,
    purchase: {
      source: 'web', purchaseId: purchase.purchaseId, ref: purchase.ref, tnOrderId: purchase.tnOrderId, date: purchase.date,
      late: purchase.date ? isLate(purchase.date, nowISO, settings) : false,
    },
    returnLines,
    newLines: i.newLines,
    evidence,
    logistics: { mode: lg.mode, payer: lg.payer, cost: lg.cost, shippingCharge: lg.shippingCharge, ...logisticsExtra },
  };
  return validateDraft(draft, { settings, requireEvidence: false });
}
