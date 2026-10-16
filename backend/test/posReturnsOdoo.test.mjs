import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateReturned, readTpvPurchase, readSaleOrderPurchase, searchTpvPurchases, searchWebPurchases,
  allocateToMoves, planCreditNoteCommands, createReturnPicking, validatePicking, createCreditNoteFromInvoice, applyCreditNote, trimCreditNote,
} from '../posReturnsOdoo.mjs';

// Odoo falso: responde por modelo+método con funciones (domain, kwargs) → filas.
function fakeOdoo(handlers) {
  const calls = [];
  const run = async (model, method, args = [], kwargs = {}) => {
    calls.push([model, method, structuredClone(args), structuredClone(kwargs)]);
    const h = handlers[`${model}.${method}`];
    if (!h) throw new Error(`sin handler: ${model}.${method}`);
    return h(args, kwargs);
  };
  return { odoo: { read: run, write: run }, calls };
}

test('allocateReturned: reparte lo devuelto de un producto entre sus líneas en orden', () => {
  const lines = [{ id: 1, productId: 5, qty: 2 }, { id: 2, productId: 5, qty: 3 }, { id: 3, productId: 6, qty: 1 }];
  assert.deepEqual([...allocateReturned(lines, new Map([[5, 3], [6, 0]]))], [[1, 2], [2, 1], [3, 0]]);
});

test('readTpvPurchase: líneas con valor pagado, reembolsado por el POS + devuelto por la app, lotes y factura', async () => {
  const { odoo } = fakeOdoo({
    'pos.order.read': () => [{ id: 48870, name: 'Alcorta/2301', date_order: '2026-10-15 23:59:26', partner_id: [92036, 'GENARO'], account_move: [368292, 'FA-B 00012-00001533'], picking_ids: [193125], lines: [92250] }],
    'res.partner.read': () => [{ id: 92036, vat: '20123456789', name: 'GENARO' }],
    'account.move.read': () => [{ id: 368292, name: 'FA-B 00012-00001533', state: 'posted', move_type: 'out_invoice' }],
    'pos.order.line.read': () => [{ id: 92250, product_id: [68926, '[IME031FS] LAMPARA'], qty: 2, price_subtotal_incl: 105980, refunded_qty: 1 }],
    'stock.move.search_read': (args) => (JSON.stringify(args).includes('origin_returned_move_id')
      ? [{ id: 900, origin_returned_move_id: [700, 'x'], quantity_done: 0 }]
      : [{ id: 700, product_id: [68926, 'x'], quantity_done: 2, move_line_ids: [800], picking_id: [193125, 'AL/POS/02628'] }]),
    'stock.move.line.read': () => [{ id: 800, move_id: [700, 'x'], lot_id: [17050, 'L1'], qty_done: 2 }],
    'product.product.read': () => [{ id: 68926, default_code: 'IME031FS', name: 'LAMPARA' }],
  });
  const p = await readTpvPurchase(48870, odoo);
  assert.equal(p.source, 'tpv');
  assert.equal(p.invoiceId, 368292);
  assert.equal(p.partnerVat, '20123456789');
  assert.equal(p.lines.length, 1);
  const [l] = p.lines;
  assert.equal(l.purchaseLineId, '92250');
  assert.equal(l.qtyBought, 2);
  assert.equal(l.qtyReturnedBefore, 1);
  assert.equal(l.unitValue, 52990);
  assert.deepEqual(l.moveIds, [700]);
  assert.deepEqual(l.lots, [{ lotId: 17050, qty: 2 }]);
  assert.equal(l.sku, 'IME031FS');
});

test('readSaleOrderPurchase: solo lo entregado se puede devolver; lo pendiente se informa; servicios fuera', async () => {
  const { odoo } = fakeOdoo({
    'sale.order.read': () => [{ id: 63677, name: 'TN2095995525', date_order: '2026-10-16 12:42:07', partner_id: [92052, 'Gabriel'], invoice_ids: [368698], order_line: [1, 2, 3] }],
    'res.partner.read': () => [{ id: 92052, vat: '30111222', name: 'Gabriel' }],
    'account.move.read': () => [{ id: 368698, name: 'FA-B 00009-00034244', state: 'posted', move_type: 'out_invoice' }],
    'sale.order.line.read': () => [
      { id: 1, product_id: [10, '[A] Vaso'], product_uom_qty: 3, price_total: 15000 },
      { id: 2, product_id: [11, '[B] Plato'], product_uom_qty: 1, price_total: 8000 },
      { id: 3, product_id: [4, '[Delivery_007] Envío'], product_uom_qty: 1, price_total: 9000 },
    ],
    'stock.move.search_read': (args) => {
      const s = JSON.stringify(args);
      if (s.includes('origin_returned_move_id')) return [{ id: 99, origin_returned_move_id: [71, 'x'], quantity_done: 1 }];
      return [
        { id: 71, sale_line_id: [1, 'x'], product_id: [10, 'x'], quantity_done: 2, state: 'done', location_dest_usage: 'customer', move_line_ids: [] },
        { id: 72, sale_line_id: [1, 'x'], product_id: [10, 'x'], quantity_done: 0, state: 'assigned', move_line_ids: [] },
        { id: 73, sale_line_id: [2, 'x'], product_id: [11, 'x'], quantity_done: 0, state: 'assigned', move_line_ids: [] },
      ];
    },
    'stock.move.line.read': () => [],
    'product.product.read': () => [{ id: 10, default_code: 'A', name: 'Vaso' }, { id: 11, default_code: 'B', name: 'Plato' }],
  });
  const p = await readSaleOrderPurchase({
    source: 'web', purchaseId: '63677', label: 'TN2095995525', saleOrderIds: [63677],
    unitValueFor: (sl) => Math.round(sl.price_total / sl.product_uom_qty),
  }, odoo);
  assert.equal(p.invoiceName, 'FA-B 00009-00034244');
  assert.deepEqual(p.lines.map((l) => [l.sku, l.qtyBought, l.qtyReturnedBefore, l.unitValue, l.moveIds]), [['A', 2, 1, 5000, [71]]]);
  assert.deepEqual(p.pending, [{ sku: 'A', name: 'Vaso', qty: 1 }, { sku: 'B', name: 'Plato', qty: 1 }]);
});

test('searchTpvPurchases: por documento busca el partner y trae tickets positivos del período', async () => {
  const { odoo, calls } = fakeOdoo({
    'res.partner.search': () => [92036],
    'pos.order.search_read': () => [{ id: 48870, name: 'Alcorta/2301', date_order: '2026-10-15 23:59:26', partner_id: [92036, 'GENARO'], amount_total: 52990, account_move: [368292, 'FA-B 00012-00001533 (Alcorta/2301)'] }],
  });
  const r = await searchTpvPurchases({ doc: '20123456789', sinceISO: '2025-10-16' }, odoo);
  assert.deepEqual(r, [{ source: 'tpv', purchaseId: '48870', label: 'Alcorta/2301', date: '2026-10-15 23:59:26', partnerName: 'GENARO', total: 52990, invoiceName: 'FA-B 00012-00001533' }]);
  const domain = JSON.stringify(calls.find((c) => c[0] === 'pos.order')[2]);
  assert.ok(domain.includes('"partner_id","child_of",[92036]'));
  assert.ok(domain.includes('"amount_total",">",0'));
});

test('searchWebPurchases: por número de Tiendanube con o sin "TN"', async () => {
  const { odoo, calls } = fakeOdoo({ 'sale.order.search_read': () => [] });
  await searchWebPurchases({ ref: '2095995525', sinceISO: '2025-10-16' }, odoo);
  await searchWebPurchases({ ref: 'TN2095995525', sinceISO: '2025-10-16' }, odoo);
  for (const c of calls) assert.ok(JSON.stringify(c[2]).includes('"name","=","TN2095995525"'));
});

test('readTpvPurchase: no lista líneas sin move entregado (servicios)', async () => {
  const { odoo } = fakeOdoo({
    'pos.order.read': () => [{ id: 1, name: 'T/1', date_order: '2026-10-15 10:00:00', partner_id: false, account_move: false, picking_ids: [5], lines: [10, 11] }],
    'pos.order.line.read': () => [
      { id: 10, product_id: [1, '[A] Vaso'], qty: 1, price_subtotal_incl: 1000, refunded_qty: 0 },
      { id: 11, product_id: [2, '[SRV] Servicio'], qty: 1, price_subtotal_incl: 500, refunded_qty: 0 },
    ],
    'stock.move.search_read': () => [{ id: 50, product_id: [1, 'x'], quantity_done: 1, move_line_ids: [], picking_id: [5, 'p'] }],
    'stock.move.line.read': () => [],
    'product.product.read': () => [{ id: 1, default_code: 'A', name: 'Vaso' }, { id: 2, default_code: 'SRV', name: 'Servicio' }],
  });
  const p = await readTpvPurchase(1, odoo);
  assert.deepEqual(p.lines.map((l) => l.sku), ['A']);
});

test('searchTpvPurchases: sin doc ni ref devuelve [] sin llamar a Odoo', async () => {
  const { odoo, calls } = fakeOdoo({});
  assert.deepEqual(await searchTpvPurchases({ sinceISO: '2025-10-16' }, odoo), []);
  assert.equal(calls.length, 0);
});

test('allocateToMoves: reparte entre los moves del remito descontando lo ya devuelto', () => {
  const moves = [{ id: 1, quantity_done: 2 }, { id: 2, quantity_done: 3 }];
  assert.deepEqual(allocateToMoves(3, moves, new Map([[1, 1]])), [{ moveId: 1, qty: 1 }, { moveId: 2, qty: 2 }]);
  assert.throws(() => allocateToMoves(5, moves, new Map([[1, 1]])), /ya se devolvió/);
});

test('planCreditNoteCommands: deja solo lo devuelto, con su cantidad; saca el resto (envío incluido)', () => {
  const ncLines = [
    { id: 11, product_id: [10, 'x'], quantity: 3 }, { id: 12, product_id: [10, 'x'], quantity: 2 },
    { id: 13, product_id: [4, 'envío'], quantity: 1 }, { id: 14, product_id: [11, 'y'], quantity: 1 },
  ];
  assert.deepEqual(planCreditNoteCommands(ncLines, [{ productId: 10, qty: 4 }, { productId: 11, qty: 1 }]), [
    [1, 11, { quantity: 3 }], [1, 12, { quantity: 1 }], [2, 13], [1, 14, { quantity: 1 }],
  ]);
  assert.throws(() => planCreditNoteCommands(ncLines, [{ productId: 99, qty: 1 }]), /no está en la factura/);
});

test('createReturnPicking: arma las líneas a mano, fija ubicación, tipo y origen', async () => {
  const { odoo, calls } = fakeOdoo({
    'stock.return.picking.create': () => [55],
    'stock.return.picking.create_returns': () => ({ res_id: 777 }),
    'stock.picking.write': () => true,
  });
  const id = await createReturnPicking({
    pickingId: 192311, items: [{ moveId: 612602, productId: 70417, uomId: 1, qty: 1 }], locationId: 324, pickingTypeId: 6, origin: 'LL-0042 · tpv:1',
  }, odoo);
  assert.equal(id, 777);
  const [, , [[vals]]] = calls.find((c) => c[1] === 'create');
  assert.equal(vals.picking_id, 192311);
  assert.equal(vals.location_id, 324);
  assert.deepEqual(vals.product_return_moves, [[0, 0, { product_id: 70417, move_id: 612602, uom_id: 1, quantity: 1, to_refund: true }]]);
  assert.ok(!('create_rma' in vals));
  const write = calls.find((c) => c[0] === 'stock.picking' && c[1] === 'write');
  assert.deepEqual(write[2], [[777], { picking_type_id: 6, origin: 'LL-0042 · tpv:1' }]);
});

test('validatePicking: con lote escribe el lote en la línea; sin lote, cantidad hecha; asistente = error', async () => {
  const { odoo, calls } = fakeOdoo({
    'stock.picking.read': () => [{ id: 777, name: 'LL/RET/1', state: 'assigned', move_ids: [1, 2] }],
    'stock.picking.action_assign': () => true,
    'stock.move.read': () => [
      { id: 1, product_id: [70417, 'x'], product_uom_qty: 1, move_line_ids: [] },
      { id: 2, product_id: [29175, 'y'], product_uom_qty: 2, move_line_ids: [31] },
    ],
    'stock.move.write': () => true,
    'stock.move.line.write': () => true,
    'stock.picking.button_validate': () => true,
  });
  await validatePicking(777, new Map([[29175, [{ lotId: 17050, qty: 2 }]]]), odoo);
  assert.ok(calls.some((c) => c[0] === 'stock.move' && c[1] === 'write' && JSON.stringify(c[2]) === '[[1],{"quantity_done":1}]'));
  assert.ok(calls.some((c) => c[0] === 'stock.move.line' && JSON.stringify(c[2]) === '[[31],{"lot_id":17050,"qty_done":2}]'));
});

test('createCreditNoteFromInvoice: reversión parcial en borrador en el diario del local', async () => {
  const { odoo, calls } = fakeOdoo({
    'account.move.reversal.create': () => [9],
    'account.move.reversal.reverse_moves': () => ({ res_id: 368705 }),
    'account.move.read': () => [{ id: 368705, invoice_line_ids: [1215806] }],
    'account.move.line.read': () => [{ id: 1215806, product_id: [68926, 'x'], quantity: 2 }],
    'account.move.write': () => true,
  });
  const id = await createCreditNoteFromInvoice({ invoiceId: 368292, journalId: 32, reason: 'LL-0042 devolución', items: [{ productId: 68926, qty: 1 }] }, odoo);
  assert.equal(id, 368705);
  const [, , [[vals]]] = calls.find((c) => c[0] === 'account.move.reversal' && c[1] === 'create');
  assert.deepEqual(vals, { move_ids: [[6, 0, [368292]]], refund_method: 'refund', journal_id: 32, reason: 'LL-0042 devolución', date_mode: 'entry' });
  assert.ok(!calls.some((c) => c[1] === 'action_post'));
  assert.deepEqual(calls.find((c) => c[0] === 'account.move' && c[1] === 'write')[2], [[368705], { invoice_line_ids: [[1, 1215806, { quantity: 1 }]] }]);
});

test('applyCreditNote: usa la línea a cobrar abierta de la NC', async () => {
  const { odoo, calls } = fakeOdoo({
    'account.move.line.search_read': () => [{ id: 5001 }],
    'account.move.js_assign_outstanding_line': () => true,
  });
  assert.equal(await applyCreditNote(400, 368705, odoo), true);
  assert.deepEqual(calls.at(-1).slice(0, 3), ['account.move', 'js_assign_outstanding_line', [[400], 5001]]);
  const empty = fakeOdoo({ 'account.move.line.search_read': () => [] });
  assert.equal(await applyCreditNote(400, 368705, empty.odoo), false);
});

test('validatePicking: varios lotes en un move — pone en cero las líneas, reusa la existente y crea la que falta completa', async () => {
  const { odoo, calls } = fakeOdoo({
    'stock.picking.read': () => [{ id: 777, name: 'LL/RET/1', state: 'assigned', move_ids: [1] }],
    'stock.picking.action_assign': () => true,
    'stock.move.read': () => [{
      id: 1, product_id: [29175, 'y'], product_uom: [1, 'Unidades'], location_id: [5, 'Clientes'], location_dest_id: [324, 'Stock'],
      picking_id: [777, 'LL/RET/1'], product_uom_qty: 3, move_line_ids: [31],
    }],
    'stock.move.line.write': () => true,
    'stock.move.line.create': () => [32],
    'stock.picking.button_validate': () => true,
  });
  await validatePicking(777, new Map([[29175, [{ lotId: 17050, qty: 2 }, { lotId: 17051, qty: 1 }]]]), odoo);
  const lineCalls = calls.filter((c) => c[0] === 'stock.move.line').map((c) => [c[1], JSON.stringify(c[2])]);
  assert.deepEqual(lineCalls, [
    ['write', '[[31],{"qty_done":0}]'],
    ['write', '[[31],{"lot_id":17050,"qty_done":2}]'],
    ['create', JSON.stringify([[{ move_id: 1, picking_id: 777, product_id: 29175, product_uom_id: 1, location_id: 5, location_dest_id: 324, lot_id: 17051, qty_done: 1 }]])],
  ]);
});

test('validatePicking: si Odoo pide confirmar un asistente, falla con aviso', async () => {
  const { odoo } = fakeOdoo({
    'stock.picking.read': () => [{ id: 777, name: 'LL/RET/1', state: 'assigned', move_ids: [] }],
    'stock.picking.action_assign': () => true,
    'stock.move.read': () => [],
    'stock.picking.button_validate': () => ({ res_model: 'stock.backorder.confirmation' }),
  });
  await assert.rejects(() => validatePicking(777, new Map(), odoo), /Odoo pidió confirmar/);
});

test('trimCreditNote: idempotente; una reversión completa queda solo con lo devuelto, y una ya recortada no cambia', async () => {
  const full = fakeOdoo({
    'account.move.read': () => [{ id: 368705, invoice_line_ids: [1215806, 1215807] }],
    'account.move.line.read': () => [{ id: 1215806, product_id: [68926, 'x'], quantity: 2 }, { id: 1215807, product_id: [11, 'envío'], quantity: 1 }],
    'account.move.write': () => true,
  });
  await trimCreditNote(368705, [{ productId: 68926, qty: 1 }], full.odoo);
  assert.deepEqual(full.calls.find((c) => c[1] === 'write')[2], [[368705], { invoice_line_ids: [[1, 1215806, { quantity: 1 }], [2, 1215807]] }]);
  const trimmed = fakeOdoo({
    'account.move.read': () => [{ id: 368705, invoice_line_ids: [1215806] }],
    'account.move.line.read': () => [{ id: 1215806, product_id: [68926, 'x'], quantity: 1 }],
    'account.move.write': () => true,
  });
  await trimCreditNote(368705, [{ productId: 68926, qty: 1 }], trimmed.odoo);
  assert.deepEqual(trimmed.calls.find((c) => c[1] === 'write')[2], [[368705], { invoice_line_ids: [[1, 1215806, { quantity: 1 }]] }]);
});
