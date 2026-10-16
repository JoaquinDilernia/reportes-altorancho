// Cambios y devoluciones en Odoo (spike Fase 2). Lectura: compras del POS
// nativo (pos.order), de Tiendanube y de la app (sale.order) con lo que se
// puede devolver. Escritura (Task 7): devoluciones de remito, ingreso suelto,
// transferencia, notas de crédito y su aplicación. Todo con `odoo` inyectable.
import { defaultOdoo } from './posOdoo.mjs';
import { tpvUnitValue } from './posReturns.mjs';
import { netOfIva } from './posPricing.mjs';

const id = (m2o) => (Array.isArray(m2o) ? m2o[0] : m2o || null);
const cleanName = (m2o) => (Array.isArray(m2o) ? String(m2o[1]).replace(/\s*\(.*\)$/, '') : null);
const skuOf = (display) => (/^\[([^\]]+)\]/.exec(display ?? '') ?? [])[1] ?? null;

// Lo devuelto de un producto se reparte entre sus líneas en el orden de la compra.
export function allocateReturned(lines, returnedByProduct) {
  const left = new Map(returnedByProduct);
  const result = new Map();
  for (const l of lines) {
    const take = Math.min(l.qty, left.get(l.productId) ?? 0);
    result.set(l.id, take);
    left.set(l.productId, (left.get(l.productId) ?? 0) - take);
  }
  return result;
}

export async function returnedQtyByMove(moveIds, odoo = defaultOdoo) {
  const result = new Map();
  if (!moveIds.length) return result;
  const returns = await odoo.read('stock.move', 'search_read', [[
    ['origin_returned_move_id', 'in', moveIds], ['state', '=', 'done'],
  ]], { fields: ['id', 'origin_returned_move_id', 'quantity_done'] });
  for (const r of returns) {
    const orig = id(r.origin_returned_move_id);
    result.set(orig, (result.get(orig) ?? 0) + r.quantity_done);
  }
  return result;
}

async function lotsByMove(moves, odoo) {
  const lineIds = moves.flatMap((m) => m.move_line_ids ?? []);
  const result = new Map();
  if (!lineIds.length) return result;
  const lines = await odoo.read('stock.move.line', 'read', [lineIds], { fields: ['id', 'move_id', 'lot_id', 'qty_done'] });
  for (const ml of lines) {
    if (!ml.lot_id) continue;
    const moveId = id(ml.move_id);
    if (!result.has(moveId)) result.set(moveId, []);
    result.get(moveId).push({ lotId: id(ml.lot_id), qty: ml.qty_done });
  }
  return result;
}

const mergeLots = (lists) => {
  const byLot = new Map();
  for (const { lotId, qty } of lists.flat()) byLot.set(lotId, (byLot.get(lotId) ?? 0) + qty);
  return [...byLot].map(([lotId, qty]) => ({ lotId, qty }));
};

async function postedInvoice(moveIds, odoo) {
  if (!moveIds.length) return null;
  const moves = await odoo.read('account.move', 'read', [moveIds], { fields: ['id', 'name', 'state', 'move_type'] });
  return moves.find((m) => m.move_type === 'out_invoice' && m.state === 'posted') ?? null;
}

async function productsById(productIds, odoo) {
  const rows = productIds.length ? await odoo.read('product.product', 'read', [[...new Set(productIds)]], { fields: ['id', 'default_code', 'name'] }) : [];
  return new Map(rows.map((p) => [p.id, p]));
}

async function partnerOf(partnerM2o, odoo) {
  if (!partnerM2o) return { partnerVat: null, partnerName: null };
  const [p] = await odoo.read('res.partner', 'read', [[id(partnerM2o)]], { fields: ['id', 'vat', 'name'] });
  return { partnerVat: p?.vat ? String(p.vat).replace(/\D/g, '') : null, partnerName: p?.name ?? partnerM2o[1] };
}

async function partnerDomain(doc, odoo) {
  const ids = await odoo.read('res.partner', 'search', [[['vat', '=', doc]]], { limit: 20 });
  return ids.length ? [['partner_id', 'child_of', ids]] : null;
}

// ---- Búsqueda ----

export async function searchTpvPurchases({ doc, ref, sinceISO }, odoo = defaultOdoo) {
  if (!doc && !ref) return [];
  const domain = [['amount_total', '>', 0], ['date_order', '>=', sinceISO]];
  if (doc) {
    const byPartner = await partnerDomain(doc, odoo);
    if (!byPartner) return [];
    domain.push(...byPartner);
  } else {
    domain.push('|', ['name', 'ilike', ref], ['pos_reference', 'ilike', ref]);
  }
  const rows = await odoo.read('pos.order', 'search_read', [domain], {
    fields: ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'account_move'], limit: 30, order: 'date_order desc',
  });
  return rows.map((o) => ({
    source: 'tpv', purchaseId: String(o.id), label: o.name, date: o.date_order, partnerName: o.partner_id ? o.partner_id[1] : null,
    total: o.amount_total, invoiceName: cleanName(o.account_move),
  }));
}

export async function searchWebPurchases({ doc, ref, sinceISO }, odoo = defaultOdoo) {
  const domain = [['name', '=like', 'TN%'], ['state', 'in', ['sale', 'done']], ['date_order', '>=', sinceISO]];
  if (doc) {
    const byPartner = await partnerDomain(doc, odoo);
    if (!byPartner) return [];
    domain.push(...byPartner);
  } else {
    const digits = String(ref).replace(/\D/g, '');
    if (!digits) return [];
    domain.push(['name', '=', `TN${digits}`]);
  }
  const rows = await odoo.read('sale.order', 'search_read', [domain], {
    fields: ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'invoice_ids'], limit: 30, order: 'date_order desc',
  });
  return rows.map((o) => ({
    source: 'web', purchaseId: String(o.id), label: o.name, date: o.date_order, partnerName: o.partner_id ? o.partner_id[1] : null,
    total: o.amount_total, invoiceName: null,
  }));
}

// ---- Lectura de una compra ----

export async function readTpvPurchase(posOrderId, odoo = defaultOdoo) {
  const [order] = await odoo.read('pos.order', 'read', [[Number(posOrderId)]], {
    fields: ['id', 'name', 'date_order', 'partner_id', 'account_move', 'picking_ids', 'lines'],
  });
  if (!order) throw new Error('Ticket no encontrado');
  const [partner, invoice, posLines] = await Promise.all([
    partnerOf(order.partner_id, odoo),
    postedInvoice(order.account_move ? [id(order.account_move)] : [], odoo),
    odoo.read('pos.order.line', 'read', [order.lines], { fields: ['id', 'product_id', 'qty', 'price_subtotal_incl', 'refunded_qty'] }),
  ]);
  const moves = order.picking_ids.length ? await odoo.read('stock.move', 'search_read', [[
    ['picking_id', 'in', order.picking_ids], ['state', '=', 'done'],
  ]], { fields: ['id', 'product_id', 'quantity_done', 'move_line_ids', 'picking_id'] }) : [];
  const [returnedByMove, lots, products] = await Promise.all([
    returnedQtyByMove(moves.map((m) => m.id), odoo), lotsByMove(moves, odoo), productsById(posLines.map((l) => id(l.product_id)), odoo),
  ]);
  const returnedByProduct = new Map();
  for (const m of moves) returnedByProduct.set(id(m.product_id), (returnedByProduct.get(id(m.product_id)) ?? 0) + (returnedByMove.get(m.id) ?? 0));
  // Solo lo entregado: servicios/consumibles sin move hecho no se listan.
  const delivered = new Set(moves.map((m) => id(m.product_id)));
  const positive = posLines.filter((l) => l.qty > 0 && delivered.has(id(l.product_id)));
  const byApp = allocateReturned(positive.map((l) => ({ id: l.id, productId: id(l.product_id), qty: l.qty - (l.refunded_qty ?? 0) })), returnedByProduct);
  const lines = positive.map((l) => {
    const productId = id(l.product_id);
    const productMoves = moves.filter((m) => id(m.product_id) === productId);
    const product = products.get(productId);
    return {
      source: 'tpv', purchaseId: String(order.id), purchaseLabel: order.name, purchaseLineId: String(l.id), productId,
      sku: product?.default_code ?? skuOf(l.product_id[1]), name: product?.name ?? l.product_id[1],
      qtyBought: l.qty, qtyReturnedBefore: (l.refunded_qty ?? 0) + (byApp.get(l.id) ?? 0), unitValue: tpvUnitValue(l),
      lots: mergeLots(productMoves.map((m) => lots.get(m.id) ?? [])), moveIds: productMoves.map((m) => m.id),
      invoiceId: invoice?.id ?? null, invoiceName: invoice?.name ?? null, ...partner,
    };
  });
  return {
    source: 'tpv', purchaseId: String(order.id), label: order.name, date: order.date_order, ...partner,
    invoiceId: invoice?.id ?? null, invoiceName: invoice?.name ?? null, lines, pending: [],
  };
}

// Pedido(s) de venta: Tiendanube (uno) o venta de la app (uno por depósito).
export async function readSaleOrderPurchase({ source, purchaseId, label, saleOrderIds, unitValueFor }, odoo = defaultOdoo) {
  const orders = await odoo.read('sale.order', 'read', [saleOrderIds], {
    fields: ['id', 'name', 'date_order', 'partner_id', 'invoice_ids', 'order_line'],
  });
  if (!orders.length) throw new Error('Pedido no encontrado');
  const lineIds = orders.flatMap((o) => o.order_line);
  const [partner, invoice, saleLines] = await Promise.all([
    partnerOf(orders[0].partner_id, odoo),
    postedInvoice([...new Set(orders.flatMap((o) => o.invoice_ids))], odoo),
    odoo.read('sale.order.line', 'read', [lineIds], { fields: ['id', 'product_id', 'product_uom_qty', 'price_total'] }),
  ]);
  const allMoves = await odoo.read('stock.move', 'search_read', [[
    ['sale_line_id', 'in', lineIds], ['state', '!=', 'cancel'], ['location_dest_id.usage', '=', 'customer'],
  ]], { fields: ['id', 'sale_line_id', 'product_id', 'quantity_done', 'state', 'move_line_ids', 'picking_id'] });
  const done = allMoves.filter((m) => m.state === 'done');
  const [returnedByMove, lots, products] = await Promise.all([
    returnedQtyByMove(done.map((m) => m.id), odoo), lotsByMove(done, odoo), productsById(saleLines.map((l) => id(l.product_id)), odoo),
  ]);
  const lines = [];
  const pending = [];
  for (const sl of saleLines) {
    const moves = allMoves.filter((m) => id(m.sale_line_id) === sl.id);
    if (!moves.length) continue; // servicio / envío: no se devuelve stock
    const lineDone = moves.filter((m) => m.state === 'done');
    const delivered = lineDone.reduce((s, m) => s + m.quantity_done, 0);
    const product = products.get(id(sl.product_id));
    const sku = product?.default_code ?? skuOf(sl.product_id[1]);
    const name = product?.name ?? sl.product_id[1];
    if (sl.product_uom_qty > delivered) pending.push({ sku, name, qty: sl.product_uom_qty - delivered });
    if (!delivered) continue;
    lines.push({
      source, purchaseId, purchaseLabel: label ?? orders[0].name, purchaseLineId: String(sl.id), productId: id(sl.product_id), sku, name,
      qtyBought: delivered, qtyReturnedBefore: lineDone.reduce((s, m) => s + (returnedByMove.get(m.id) ?? 0), 0),
      unitValue: unitValueFor(sl), lots: mergeLots(lineDone.map((m) => lots.get(m.id) ?? [])), moveIds: lineDone.map((m) => m.id),
      invoiceId: invoice?.id ?? null, invoiceName: invoice?.name ?? null, ...partner,
    });
  }
  return {
    source, purchaseId, label: label ?? orders[0].name, date: orders[0].date_order, ...partner,
    invoiceId: invoice?.id ?? null, invoiceName: invoice?.name ?? null, lines, pending,
  };
}

// ---- Escritura ----

const VALIDATE_CTX = { skip_sms: true, skip_immediate: true, skip_backorder: true, lang: 'es_AR' };

export function allocateToMoves(qty, moves, returnedByMove) {
  const result = [];
  let left = qty;
  for (const m of moves) {
    if (left <= 0) break;
    const free = m.quantity_done - (returnedByMove.get(m.id) ?? 0);
    if (free <= 0) continue;
    const take = Math.min(free, left);
    result.push({ moveId: m.id, qty: take });
    left -= take;
  }
  if (left > 0) throw new Error(`Faltan ${left} unidades: ya se devolvió parte de esa compra`);
  return result;
}

export function planCreditNoteCommands(ncLines, items) {
  const left = new Map();
  for (const { productId, qty } of items) left.set(productId, (left.get(productId) ?? 0) + qty);
  const commands = ncLines.map((l) => {
    const want = left.get(id(l.product_id)) ?? 0;
    if (want <= 0) return [2, l.id];
    const take = Math.min(want, l.quantity);
    left.set(id(l.product_id), want - take);
    return [1, l.id, { quantity: take }];
  });
  const missing = [...left].filter(([, q]) => q > 0);
  if (missing.length) throw new Error(`El producto ${missing.map(([p]) => p).join(', ')} no está en la factura original (o con menos cantidad)`);
  return commands;
}

export function readMoves(moveIds, odoo = defaultOdoo) {
  return odoo.read('stock.move', 'read', [moveIds], { fields: ['id', 'product_id', 'quantity_done', 'product_uom', 'picking_id'] });
}

// v16: las líneas y la ubicación del asistente salen de un onchange, por eso
// se arman a mano (spike Fase 2). Nunca create_rma.
export async function createReturnPicking({ pickingId, items, locationId, pickingTypeId, origin }, odoo = defaultOdoo) {
  const context = { active_model: 'stock.picking', active_id: pickingId, active_ids: [pickingId] };
  const [wizardId] = await odoo.write('stock.return.picking', 'create', [[{
    picking_id: pickingId, location_id: locationId,
    product_return_moves: items.map((i) => [0, 0, { product_id: i.productId, move_id: i.moveId, uom_id: i.uomId, quantity: i.qty, to_refund: true }]),
  }]], { context });
  const action = await odoo.write('stock.return.picking', 'create_returns', [[wizardId]], { context });
  const returnId = action?.res_id;
  if (!returnId) throw new Error('Odoo no creó la devolución');
  await odoo.write('stock.picking', 'write', [[returnId], { ...(pickingTypeId ? { picking_type_id: pickingTypeId } : {}), origin }]);
  return returnId;
}

export async function validatePicking(pickingId, lotsByProduct = new Map(), odoo = defaultOdoo) {
  const [picking] = await odoo.read('stock.picking', 'read', [[pickingId]], { fields: ['id', 'name', 'state', 'move_ids'] });
  if (picking.state === 'done') return picking;
  if (picking.state === 'draft') await odoo.write('stock.picking', 'action_confirm', [[pickingId]]);
  await odoo.write('stock.picking', 'action_assign', [[pickingId]]);
  const moves = await odoo.read('stock.move', 'read', [picking.move_ids], { fields: ['id', 'product_id', 'product_uom', 'location_id', 'location_dest_id', 'picking_id', 'product_uom_qty', 'move_line_ids'] });
  for (const m of moves) {
    const lots = lotsByProduct.get(id(m.product_id)) ?? [];
    if (!lots.length) {
      await odoo.write('stock.move', 'write', [[m.id], { quantity_done: m.product_uom_qty }]);
      continue;
    }
    // Con lote: se pone en cero lo que haya (un reintento no suma doble), se
    // reusan las líneas existentes en orden y las que faltan se crean completas.
    const existing = m.move_line_ids ?? [];
    if (existing.length) await odoo.write('stock.move.line', 'write', [existing, { qty_done: 0 }]);
    let left = m.product_uom_qty;
    for (const [i, lot] of lots.entries()) {
      if (left <= 0) break;
      const qty = Math.min(lot.qty, left);
      if (i < existing.length) await odoo.write('stock.move.line', 'write', [[existing[i]], { lot_id: lot.lotId, qty_done: qty }]);
      else {
        await odoo.write('stock.move.line', 'create', [[{
          move_id: m.id, picking_id: id(m.picking_id) ?? pickingId, product_id: id(m.product_id), product_uom_id: id(m.product_uom),
          location_id: id(m.location_id), location_dest_id: id(m.location_dest_id), lot_id: lot.lotId, qty_done: qty,
        }]]);
      }
      left -= qty;
    }
  }
  const res = await odoo.write('stock.picking', 'button_validate', [[pickingId]], { context: VALIDATE_CTX });
  if (res && typeof res === 'object' && res.res_model) throw new Error(`Odoo pidió confirmar algo al validar ${picking.name} (${res.res_model}): validalo en Odoo`);
  const [done] = await odoo.read('stock.picking', 'read', [[pickingId]], { fields: ['id', 'name', 'state'] });
  return done;
}

export async function createManualReturn({ pickingTypeId, locationId, partnerId, items, origin }, odoo = defaultOdoo) {
  const [pickingId] = await odoo.write('stock.picking', 'create', [[{
    picking_type_id: pickingTypeId, location_id: 5, location_dest_id: locationId, partner_id: partnerId, origin,
    move_ids_without_package: items.map((i) => [0, 0, { name: origin, product_id: i.productId, product_uom_qty: i.qty, location_id: 5, location_dest_id: locationId }]),
  }]]);
  await odoo.write('stock.picking', 'action_confirm', [[pickingId]]);
  return pickingId;
}

export async function createInternalTransfer({ pickingTypeId, fromLocationId, toLocationId, items, origin }, odoo = defaultOdoo) {
  const [pickingId] = await odoo.write('stock.picking', 'create', [[{
    picking_type_id: pickingTypeId, location_id: fromLocationId, location_dest_id: toLocationId, origin,
    move_ids_without_package: items.map((i) => [0, 0, { name: origin, product_id: i.productId, product_uom_qty: i.qty, location_id: fromLocationId, location_dest_id: toLocationId }]),
  }]]);
  await odoo.write('stock.picking', 'action_confirm', [[pickingId]]);
  await odoo.write('stock.picking', 'action_assign', [[pickingId]]);
  const [picking] = await odoo.read('stock.picking', 'read', [[pickingId]], { fields: ['id', 'name', 'state'] });
  return picking;
}

export async function findPickingByOrigin(origin, odoo = defaultOdoo) {
  const [found] = await odoo.read('stock.picking', 'search_read', [[['origin', '=', origin], ['state', '!=', 'cancel']]], { fields: ['id', 'name', 'state'], limit: 1 });
  return found ?? null;
}

export async function latestLotFor(productId, odoo = defaultOdoo) {
  const [lot] = await odoo.read('stock.lot', 'search_read', [[['product_id', '=', productId]]], { fields: ['id'], limit: 1, order: 'create_date desc' });
  return lot?.id ?? null;
}

// NC parcial: se revierte la factura original y, en borrador, se dejan solo
// las líneas y cantidades devueltas (spike Fase 2). Se publica aparte.
export async function createCreditNoteFromInvoice({ invoiceId, journalId, reason, items }, odoo = defaultOdoo) {
  const context = { active_model: 'account.move', active_ids: [invoiceId], active_id: invoiceId };
  const [wizardId] = await odoo.write('account.move.reversal', 'create', [[{
    move_ids: [[6, 0, [invoiceId]]], refund_method: 'refund', journal_id: journalId, reason, date_mode: 'entry',
  }]], { context });
  const action = await odoo.write('account.move.reversal', 'reverse_moves', [[wizardId]], { context });
  const creditNoteId = action?.res_id;
  if (!creditNoteId) throw new Error('Odoo no creó la nota de crédito');
  await trimCreditNote(creditNoteId, items, odoo);
  return creditNoteId;
}

// Deja en la NC en borrador solo las líneas y cantidades devueltas. Idempotente:
// sobre una ya recortada reescribe las mismas cantidades. Sirve también para una
// NC adoptada que quedó como reversión completa (falla entre reverse_moves y el recorte).
export async function trimCreditNote(creditNoteId, items, odoo = defaultOdoo) {
  const [nc] = await odoo.read('account.move', 'read', [[creditNoteId]], { fields: ['id', 'invoice_line_ids'] });
  const lines = await odoo.read('account.move.line', 'read', [nc.invoice_line_ids], { fields: ['id', 'product_id', 'quantity'] });
  await odoo.write('account.move', 'write', [[creditNoteId], { invoice_line_ids: planCreditNoteCommands(lines, items) }]);
}

export async function createStandaloneCreditNote({ journalId, partnerId, reason, items }, odoo = defaultOdoo) {
  const [creditNoteId] = await odoo.write('account.move', 'create', [[{
    move_type: 'out_refund', journal_id: journalId, partner_id: partnerId, ref: reason,
    invoice_line_ids: items.map((i) => [0, 0, { product_id: i.productId, quantity: i.qty, price_unit: netOfIva(i.unitValue) }]),
  }]]);
  return creditNoteId;
}

export async function findCreditNoteByRef(ref, odoo = defaultOdoo) {
  const [found] = await odoo.read('account.move', 'search_read', [[
    ['move_type', '=', 'out_refund'], ['ref', 'ilike', ref], ['state', '!=', 'cancel'],
  ]], { fields: ['id', 'name', 'state'], limit: 1 });
  return found ?? null;
}

// Aplica (concilia) la NC a la factura nueva: Odoo concilia hasta lo menor
// entre lo abierto de la NC y lo abierto de la factura.
export async function applyCreditNote(invoiceId, creditNoteId, odoo = defaultOdoo) {
  const [line] = await odoo.read('account.move.line', 'search_read', [[
    ['move_id', '=', creditNoteId], ['account_id.account_type', '=', 'asset_receivable'], ['reconciled', '=', false],
  ]], { fields: ['id'], limit: 1 });
  if (!line) return false;
  await odoo.write('account.move', 'js_assign_outstanding_line', [[invoiceId], line.id]);
  return true;
}
