// Escrituras en Odoo del POS de locales. Reusa lo genérico de la feria
// (feriaOdoo/feriaPlacement no se modifican) y agrega: cliente con datos de
// ARCA, líneas con la cascada de descuentos, un pedido por depósito de origen
// (local / Rolón, spike S1b) y una sola factura para todos.
import { callKw } from './odoo.mjs';
import { ensureAuth, callKwReadWithRetry, docIdentityType, findIdentificationTypeIds } from './feriaOdoo.mjs';
import { planMoveLocations } from './feriaPlacement.mjs';
import { netOfIva, round2 } from './posPricing.mjs';
import { activeLines, shipsFromRolon, pickWebLots } from './posLines.mjs';

// Acceso a Odoo inyectable (los tests pasan uno falso): lecturas con
// reintento de sesión, escrituras sin reintento (ver callKwReadWithRetry).
export const defaultOdoo = {
  read: callKwReadWithRetry,
  write: async (model, method, args = [], kwargs = {}) => {
    await ensureAuth();
    return callKw(model, method, args, kwargs);
  },
};

export const AFIP_RESPONSIBILITY_NAMES = {
  responsable_inscripto: 'IVA Responsable Inscripto',
  consumidor_final: 'Consumidor Final',
  monotributo: 'Responsable Monotributo',
  exento: 'IVA Sujeto Exento',
};

let responsibilityCache = null;
export async function findResponsibilityIds() {
  if (responsibilityCache) return responsibilityCache;
  const rows = await callKwReadWithRetry('l10n_ar.afip.responsibility.type', 'search_read', [
    [['name', 'in', Object.values(AFIP_RESPONSIBILITY_NAMES)]],
  ], { fields: ['id', 'name'] });
  responsibilityCache = Object.fromEntries(Object.entries(AFIP_RESPONSIBILITY_NAMES)
    .map(([code, name]) => [code, rows.find((r) => r.name === name)?.id ?? null]));
  return responsibilityCache;
}

async function allIds() {
  const [types, responsibility] = await Promise.all([findIdentificationTypeIds(), findResponsibilityIds()]);
  return { ...types, responsibility };
}

function responsibilityCode(customer) {
  if (customer.afipResponsibility) return customer.afipResponsibility;
  return docIdentityType(customer.docNumber) === 'dni' ? 'consumidor_final' : null;
}

export function buildPartnerVals(customer, ids) {
  const vals = { name: customer.name, vat: customer.docNumber, phone: customer.phone, email: customer.email };
  const type = docIdentityType(customer.docNumber);
  if (type && ids[type]) vals.l10n_latam_identification_type_id = ids[type];
  const code = responsibilityCode(customer);
  if (code && ids.responsibility[code]) vals.l10n_ar_afip_responsibility_type_id = ids.responsibility[code];
  for (const field of ['street', 'city', 'zip']) if (customer[field]) vals[field] = customer[field];
  return vals;
}

// ARCA es la fuente de verdad de razón social, domicilio y condición de IVA;
// el email se pisa (la factura va ahí); el teléfono solo si faltaba.
export function partnerUpdate(existing, customer, ids) {
  const update = {};
  if (customer.fromArca) {
    if (customer.name && customer.name !== existing.name) update.name = customer.name;
    for (const field of ['street', 'city', 'zip']) {
      if (customer[field] && customer[field] !== (existing[field] || '')) update[field] = customer[field];
    }
  }
  const code = responsibilityCode(customer);
  const wanted = code ? ids.responsibility[code] : null;
  const current = existing.l10n_ar_afip_responsibility_type_id?.[0] ?? null;
  if (wanted && (customer.fromArca || !current) && wanted !== current) update.l10n_ar_afip_responsibility_type_id = wanted;
  if (customer.email && customer.email.toLowerCase() !== (existing.email || '').toLowerCase()) update.email = customer.email;
  if (!existing.phone && customer.phone) update.phone = customer.phone;
  return Object.keys(update).length ? update : null;
}

const PARTNER_FIELDS = ['id', 'name', 'email', 'phone', 'street', 'city', 'zip', 'category_id', 'l10n_ar_afip_responsibility_type_id'];
const CODE_BY_NAME = Object.fromEntries(Object.entries(AFIP_RESPONSIBILITY_NAMES).map(([code, name]) => [name, code]));

export async function findPartnerForLookup(docNumber) {
  const digits = String(docNumber ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const [p] = await callKwReadWithRetry('res.partner', 'search_read', [[['vat', '=', digits]]], { fields: PARTNER_FIELDS, limit: 1 });
  if (!p) return null;
  return {
    id: p.id, name: p.name, email: p.email || '', phone: p.phone || '', street: p.street || '', city: p.city || '', zip: p.zip || '',
    afipResponsibility: CODE_BY_NAME[p.l10n_ar_afip_responsibility_type_id?.[1]] ?? null, tagIds: p.category_id ?? [],
  };
}

export async function findOrCreatePosPartner(customer) {
  const ids = await allIds();
  const [existing] = await callKwReadWithRetry('res.partner', 'search_read', [[['vat', '=', customer.docNumber]]], { fields: PARTNER_FIELDS, limit: 1 });
  await ensureAuth();
  if (existing) {
    const update = partnerUpdate(existing, customer, ids);
    if (update) await callKw('res.partner', 'write', [[existing.id], update]);
    return existing.id;
  }
  const [id] = await callKw('res.partner', 'create', [[buildPartnerVals(customer, ids)]]);
  return id;
}

export async function createChildPartner(vals) {
  await ensureAuth();
  const [id] = await callKw('res.partner', 'create', [[vals]]);
  return id;
}

// Contacto hijo ya existente del cliente con los mismos datos (solo lectura):
// evita un contacto duplicado en cada venta. keys = campos que deben coincidir.
export async function findChildPartner(vals, keys = ['name', 'street']) {
  const domain = [['parent_id', '=', vals.parent_id], ['type', '=', vals.type], ...keys.map((k) => [k, '=', vals[k] || false])];
  const [found] = await callKwReadWithRetry('res.partner', 'search_read', [domain], { fields: ['id'], limit: 1 });
  return found?.id ?? null;
}

// Contacto de entrega para retiros: el remito muestra dónde lo busca.
export function buildPickupPartnerVals(parentId, customerName, label, address) {
  return { parent_id: parentId, type: 'delivery', name: `${customerName} — ${label}`, street: address || false };
}

export function pickupLabelFor(line, locale, locales) {
  if (line.delivery === 'retira_local') return `Retira en Local ${locale.name}`;
  if (line.delivery === 'retira_otro_local') return `Retira en Local ${locales.find((l) => l.id === line.pickupLocalId)?.name ?? line.pickupLocalId}`;
  if (line.delivery === 'retira_rolon') return 'Retira en Rolón';
  return null;
}

export function buildOdooOrderLines(lines, totals, shippingProductId) {
  const result = activeLines(lines).map((l) => ({
    productId: l.productId, qty: l.qty, unitPrice: round2(netOfIva(l.basePrice)), discountPct: round2(totals.lineDiscountPct),
  }));
  if (shippingProductId && totals.shipping > 0) {
    result.push({ productId: shippingProductId, qty: 1, unitPrice: round2(netOfIva(totals.shipping)), discountPct: 0 });
  }
  return result;
}

export function splitByOrigin(lines) {
  const active = activeLines(lines);
  return { local: active.filter((l) => !shipsFromRolon(l.origin)), rolon: active.filter((l) => shipsFromRolon(l.origin)) };
}

// Un pedido de Odoo por depósito de origen (spike S1b): primero el del local,
// después el de Rolón; los grupos vacíos no van. El costo de envío va como
// última línea del primer grupo que tiene una línea con envío (si ninguna lo
// tiene, del primer grupo). Puro.
export function planOdooOrders({ lines, totals, locale, settings, shippingProductId, homeServiceProductId = null }) {
  const { local, rolon } = splitByOrigin(lines);
  const groups = [
    { group: 'local', warehouseId: locale.warehouseId, lines: local },
    { group: 'rolon', warehouseId: settings.rolon.warehouseId, lines: rolon },
  ].filter((g) => g.lines.length)
    .map((g) => ({ ...g, odooLines: buildOdooOrderLines(g.lines, totals, null) }));
  const target = groups.find((g) => g.lines.some((l) => l.delivery === 'envio')) ?? groups[0];
  if (shippingProductId && totals.shipping > 0 && target) {
    target.odooLines.push({ productId: shippingProductId, qty: 1, unitPrice: netOfIva(totals.shipping), discountPct: 0 });
  }
  // Subida al domicilio: línea extra justo después del envío, mismo pedido.
  if (homeServiceProductId && totals.homeService > 0 && target) {
    target.odooLines.push({ productId: homeServiceProductId, qty: 1, unitPrice: netOfIva(totals.homeService), discountPct: 0 });
  }
  return groups;
}

// Qué contacto de entrega lleva el pedido de un grupo. Puro.
export function shippingPartnerKindFor(groupLines) {
  if (groupLines.some((l) => l.delivery === 'envio')) return 'envio';
  if (groupLines.some((l) => ['retira_local', 'retira_otro_local', 'retira_rolon'].includes(l.delivery))) return 'pickup';
  return null;
}

const MOVE_FIELDS = [
  'id', 'sale_line_id', 'move_orig_ids', 'picking_id', 'product_id', 'product_uom', 'location_id', 'location_dest_id',
  'state', 'company_id',
];

// Primer tramo de cada línea. En 2 pasos (todos los locales y Rolón) el move
// del PICK NO tiene sale_line_id en este Odoo: solo el del OUT, que lo apunta
// por move_orig_ids. Se le copia el sale_line_id del OUT para que los
// planificadores de la feria (que agrupan por sale_line_id) sirvan tal cual.
// En 1 paso (sin move_orig_ids) el move de la línea es su propio primer tramo.
// Puro.
export function firstLegMoves(lineMoves, origMoves) {
  const byId = new Map(origMoves.map((m) => [m.id, m]));
  const result = [];
  for (const m of lineMoves) {
    if (m.state === 'cancel') continue;
    if (!m.move_orig_ids?.length) {
      result.push(m);
      continue;
    }
    for (const origId of m.move_orig_ids) {
      const orig = byId.get(origId);
      if (orig && orig.state !== 'cancel') result.push({ ...orig, sale_line_id: m.sale_line_id });
    }
  }
  return result;
}

// Lee los moves de esas líneas (los del OUT) y sus primeros tramos.
export async function readLegMoves(odooLineIds, odoo = defaultOdoo) {
  const lineMoves = await odoo.read('stock.move', 'search_read', [[
    ['sale_line_id', 'in', odooLineIds], ['state', '!=', 'cancel'],
  ]], { fields: MOVE_FIELDS });
  const origIds = [...new Set(lineMoves.flatMap((m) => m.move_orig_ids ?? []))];
  const origMoves = origIds.length ? await odoo.read('stock.move', 'read', [origIds], { fields: MOVE_FIELDS }) : [];
  return { lineMoves, firstLeg: firstLegMoves(lineMoves, origMoves) };
}

// Exhibición: Odoo reserva el PICK desde el Stock del almacén. Se apunta el
// move del PICK a la ubicación real y se vuelve a reservar (spike S1b: el
// do_unreserve libera todo el PICK y action_assign re-reserva todas sus
// líneas). `items`: [{ odooLineId, locationId }].
export async function alignFirstLegMoves(items, odoo = defaultOdoo) {
  if (!items.length) return [];
  const { firstLeg } = await readLegMoves(items.map((i) => i.odooLineId), odoo);
  const plan = planMoveLocations(firstLeg, items.map((i) => ({ odooLineId: i.odooLineId, location: i.locationId })), (loc) => loc);
  if (!plan.length) return [];
  const pickingIds = [...new Set(plan.map((p) => p.pickingId).filter(Boolean))];
  if (pickingIds.length) await odoo.write('stock.picking', 'do_unreserve', [pickingIds]);
  for (const { moveId, locationId } of plan) await odoo.write('stock.move', 'write', [[moveId], { location_id: locationId }]);
  if (pickingIds.length) await odoo.write('stock.picking', 'action_assign', [pickingIds]);
  return plan;
}

// Pedidos de una venta que ya existen en Odoo para ese depósito (solo
// lectura). Si la respuesta de un create se perdió después de que Odoo lo
// guardó, el reintento lo encuentra acá en vez de crear otro.
export function findSaleOrdersByRef({ clientOrderRef, warehouseId, teamId }, odoo = defaultOdoo) {
  return odoo.read('sale.order', 'search_read', [[
    ['client_order_ref', '=', clientOrderRef], ['warehouse_id', '=', warehouseId], ['team_id', '=', teamId], ['state', '!=', 'cancel'],
  ]], { fields: ['id', 'name', 'state'] });
}

// Lotes con stock en la ubicación web para el traslado a Rolón.
export async function webLotsFor(productIds, locationId, odoo = defaultOdoo) {
  if (!productIds.length) return new Map();
  const quants = await odoo.read('stock.quant', 'search_read', [[
    ['product_id', 'in', productIds], ['location_id', '=', locationId], ['lot_id', '!=', false], ['quantity', '>', 0],
  ]], { fields: ['product_id', 'lot_id', 'quantity'] });
  return pickWebLots(quants);
}

// Traslado sin cajas físicas: motivo + "Sin bultos" (los dos obligatorios al validar).
export function markVirtualTransfer(pickingId, reason, odoo = defaultOdoo) {
  return odoo.write('stock.picking', 'write', [[pickingId], { x_motivo_transferencia: reason, x_sin_bultos: true }]);
}

export function readOrderStates(odooOrderIds, odoo = defaultOdoo) {
  return odoo.read('sale.order', 'read', [odooOrderIds], { fields: ['id', 'name', 'state'] });
}

// Una sola factura para todos los pedidos de la venta (spike S1b): el
// asistente con todos en sale_order_ids y en active_ids.
export async function createInvoiceForOrders(odooOrderIds) {
  await ensureAuth();
  const context = { active_model: 'sale.order', active_ids: odooOrderIds, active_id: odooOrderIds[0] };
  const [wizardId] = await callKw('sale.advance.payment.inv', 'create', [[{
    advance_payment_method: 'delivered', sale_order_ids: [[6, 0, odooOrderIds]],
  }]], { context });
  await callKw('sale.advance.payment.inv', 'create_invoices', [[wizardId]], { context });
}

// ¿Se validó algún remito del pedido (PICK u OUT)? hasDeliveredMoves solo ve
// los moves con sale_line_id (los del OUT); un PICK hecho ya movió stock.
export async function hasDoneTransfers(odooOrderId) {
  const count = await callKwReadWithRetry('stock.picking', 'search_count', [
    [['sale_id', '=', odooOrderId], ['state', '=', 'done']],
  ]);
  return count > 0;
}

export {
  findPaymentMethodId, findProductIdBySku, buildSaleOrderPayload, buildShippingPartnerVals, createSaleOrder,
  confirmSaleOrder, readOrderName, readOrderLineIds, cancelSaleOrder, hasDeliveredMoves,
  findOrderInvoices, createInvoiceFromOrder, postInvoice, planInvoiceStep, invoiceWizardContext,
} from './feriaOdoo.mjs';

// Opciones para los desplegables del Admin (solo lectura).
export async function listOdooOptions() {
  const read = (model, domain, fields) => callKwReadWithRetry(model, 'search_read', [domain], { fields });
  const [warehouses, locations, teams, journals, pricelists, pickingTypes, tags] = await Promise.all([
    read('stock.warehouse', [], ['id', 'name', 'code']),
    read('stock.location', [['usage', '=', 'internal']], ['id', 'complete_name']),
    read('crm.team', [], ['id', 'name']),
    read('account.journal', [['type', '=', 'sale']], ['id', 'name']),
    read('product.pricelist', [], ['id', 'name']),
    read('stock.picking.type', [['code', '=', 'outgoing']], ['id', 'name', 'warehouse_id']),
    read('res.partner.category', [], ['id', 'name']),
  ]);
  return { warehouses, locations, teams, journals, pricelists, pickingTypes, tags };
}
