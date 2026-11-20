// Reglas puras de cambios/devoluciones web (sin Firestore ni Odoo).
import { round2 } from './posPricing.mjs';

export const STATUSES = ['pendiente_aprobacion', 'rechazada', 'derivada_local', 'aprobada', 'recibida', 'reintegro_pendiente', 'reintegrada', 'cerrada'];

export const TRANSITIONS = {
  approve: { from: ['pendiente_aprobacion'], to: 'aprobada' },
  reject: { from: ['pendiente_aprobacion'], to: 'rechazada' },
  derive: { from: ['pendiente_aprobacion'], to: 'derivada_local' },
  receive: { from: ['aprobada'], to: 'recibida' },
  refundDone: { from: ['reintegro_pendiente'], to: 'reintegrada' },
  close: { from: ['recibida', 'reintegrada'], to: 'cerrada' },
};
const VERBS = { approve: 'aprobar', reject: 'rechazar', derive: 'derivar', receive: 'recibir', refundDone: 'marcar el reintegro de', close: 'cerrar' };

const KINDS = ['cambio', 'devolucion'];
const REASONS = ['falla', 'disconformidad'];
const CHANNELS = ['whatsapp', 'instagram', 'manual'];
const MODES = ['retiro_domicilio', 'envio_cliente', 'logistica_paga_cliente', 'derivado_local'];
const ZONES = ['amba', 'interior'];
const PAYERS = ['altorancho', 'cliente'];

export function assertTransition(request, action) {
  const t = TRANSITIONS[action];
  if (!t) throw new Error(`Acción desconocida: ${action}`);
  if (!t.from.includes(request?.status)) {
    throw new Error(`No se puede ${VERBS[action]} una solicitud ${String(request?.status ?? '').replace(/_/g, ' ')}`);
  }
  if (action === 'receive' && Number(request.money?.refundPending) > 0) return 'reintegro_pendiente';
  return t.to;
}

export const canEdit = (request) => request?.status === 'pendiente_aprobacion';

const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function suggestedDestination(reason, settings) {
  return settings?.webReturns?.defaultDestinationByReason?.[reason] ?? null;
}

export function validateDraft(input, { settings, requireEvidence = true } = {}) {
  const i = input || {};
  const reason = str(i.reason);
  if (!reason) throw new Error('Falta el motivo');
  if (!REASONS.includes(reason)) throw new Error('Motivo inválido');
  const kind = str(i.kind);
  if (!KINDS.includes(kind)) throw new Error('Tipo inválido: tiene que ser cambio o devolución');
  const channel = str(i.channel) || 'manual';
  if (!CHANNELS.includes(channel)) throw new Error('Canal inválido');
  const c = i.customer || {};
  const zone = str(c.zone) || 'amba';
  if (!ZONES.includes(zone)) throw new Error('Zona inválida');
  const p = i.purchase || {};
  const lg = i.logistics || {};
  const mode = str(lg.mode);
  const evidence = (Array.isArray(i.evidence) ? i.evidence : []).map((e) => ({ storagePath: str(e.storagePath), kind: str(e.kind), mimetype: str(e.mimetype) }));
  const dest = suggestedDestination(reason, settings);
  const returnLines = (Array.isArray(i.returnLines) ? i.returnLines : []).map((l) => ({
    purchaseLineId: l.purchaseLineId ?? null, productId: num(l.productId), sku: str(l.sku), name: str(l.name),
    qty: num(l.qty), unitValue: num(l.unitValue), destinationId: str(l.destinationId) || dest,
    moveIds: Array.isArray(l.moveIds) ? l.moveIds : [], lots: Array.isArray(l.lots) ? l.lots : [],
  }));
  const newLines = (Array.isArray(i.newLines) ? i.newLines : []).map((l) => ({
    productId: num(l.productId), sku: str(l.sku), name: str(l.name), qty: num(l.qty), price: num(l.price),
  }));
  if (requireEvidence && reason === 'falla' && !evidence.length) throw new Error('En una falla hacen falta fotos o video');
  if (!returnLines.length) throw new Error('Elegí qué producto vuelve');
  if (kind === 'cambio' && !newLines.length) throw new Error('Elegí el producto nuevo');
  if (!mode) throw new Error('Elegí cómo vuelve el producto');
  if (!MODES.includes(mode)) throw new Error('Modo de envío inválido');
  const payer = str(lg.payer) || (reason === 'falla' ? 'altorancho' : 'cliente');
  if (!PAYERS.includes(payer)) throw new Error('Pagador inválido');
  return {
    kind, reason, reasonLabel: str(i.reasonLabel) || reason.toUpperCase(), reasonNote: str(i.reasonNote),
    productOrigin: str(i.productOrigin), channel, botConversationId: i.botConversationId ?? null,
    customer: { name: str(c.name), phone: str(c.phone), email: str(c.email), doc: str(c.doc), address: str(c.address), zone },
    purchase: { source: 'web', purchaseId: p.purchaseId ?? null, ref: str(p.ref), tnOrderId: p.tnOrderId ?? null, date: p.date ?? null, late: !!p.late },
    returnLines, newLines, evidence,
    logistics: { mode, payer, cost: num(lg.cost), shippingCharge: num(lg.shippingCharge), labelPath: lg.labelPath ?? null, derivedLocalId: lg.derivedLocalId ?? null },
    number: i.number ?? null,
  };
}

const DAY_MS = 86400000;
// Fecha calendario en Argentina (UTC-3), como medianoche UTC en ms.
function arDay(iso) {
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  const d = new Date(Date.parse(s) - 3 * 3600 * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function businessDaysBetween(fromISO, toISO, holidays = []) {
  const from = arDay(fromISO);
  const to = arDay(toISO);
  const hol = new Set((holidays || []).map(String));
  let n = 0;
  for (let t = from + DAY_MS; t <= to; t += DAY_MS) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (hol.has(d.toISOString().slice(0, 10))) continue;
    n += 1;
  }
  return n;
}

export const isLate = (purchaseDateISO, nowISO, settings) =>
  businessDaysBetween(purchaseDateISO, nowISO, settings?.webReturns?.holidays) > (settings?.webReturns?.windowBusinessDays ?? 30);

export function computeMoney({ kind, returnLines = [], newLines = [], shippingCharge = 0 }) {
  const returnValue = round2(returnLines.reduce((s, l) => s + num(l.qty) * num(l.unitValue), 0));
  const newValue = kind === 'cambio' ? round2(newLines.reduce((s, l) => s + num(l.qty) * num(l.price), 0)) : 0;
  const ship = num(shippingCharge);
  if (kind === 'cambio') {
    const net = round2(newValue - returnValue);
    return { returnValue, newValue, net, differenceToCollect: round2(Math.max(net, 0) + ship), refundPending: round2(Math.max(-net, 0)) };
  }
  return { returnValue, newValue, net: -returnValue, differenceToCollect: round2(ship), refundPending: returnValue };
}

export function buildOdooNoteLines(request) {
  const r = request || {};
  const mode = r.logistics?.mode;
  const ours = mode === 'retiro_domicilio' || mode === 'logistica_paga_cliente';
  const external = mode === 'envio_cliente';
  const label = str(r.reasonLabel) || str(r.reason);
  const long = [
    str(r.reasonNote), 'CAMBIO PEDIDO ORIGINAL', str(r.purchase?.ref),
    ours ? 'ENVIO NUESTRO' : external ? 'ENVIO NUBE' : '',
    str(r.customer?.name), str(r.customer?.phone),
    r.customer?.address ? `Dirección: ${str(r.customer.address)}` : '',
  ].filter(Boolean).join(' ');
  return [
    str(r.productOrigin).toUpperCase(), label.toUpperCase(),
    ours ? 'ENVIO NUESTRO' : external ? 'ENVIO EXTERNO' : '',
  ].filter(Boolean).concat(r.number ? `${long} · ${r.number}` : long);
}

export const historyEntry = (action, user, diff, now = new Date()) => ({ at: now, by: user, action, diff: diff ?? null });
