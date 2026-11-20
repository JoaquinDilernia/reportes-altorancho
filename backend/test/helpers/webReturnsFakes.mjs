// Odoo falso, dependencias y solicitud de ejemplo para los tests de cambios web.
import * as rOdoo from '../../posReturnsOdoo.mjs';
import * as store from '../../posWebReturnsStore.mjs';
import { DEFAULT_SETTINGS } from '../../posConfig.mjs';

export const settings = DEFAULT_SETTINGS;
export const user = { uid: 'u1', name: 'Mili' };

export const rline = (o = {}) => ({
  purchaseLineId: '501', productId: 70417, sku: 'BCC104TR', name: 'Taza', qty: 1, unitValue: 10000,
  destinationId: 'fallas', moveIds: [612602], lots: [], ...o,
});
export const request = (o = {}) => ({
  id: 'r1', number: 'CW-000123', status: 'pendiente_aprobacion', kind: 'cambio', reason: 'falla', reasonLabel: 'ROTURA',
  reasonNote: 'Llegó rota', productOrigin: 'importado',
  customer: { name: 'Ana Perez', phone: '1155', address: 'Calle 1' },
  purchase: { source: 'web', purchaseId: '9001', ref: '41234', tnOrderId: 1700000000, date: '2026-11-01T10:00:00.000Z' },
  returnLines: [rline()],
  newLines: [{ productId: 70417, sku: 'BCC104TR', name: 'Taza', qty: 1, price: 10000 }],
  evidence: [{ storagePath: 'web_returns/r1/a.jpg', kind: 'photo', mimetype: 'image/jpeg' }],
  logistics: { mode: 'retiro_domicilio', payer: 'altorancho', cost: 0, shippingCharge: 0 },
  money: {}, odoo: { steps: {}, error: null },
  ...o,
});

export const move = (id, pickingId = 192311, qty = 1, productId = 70417) => ({
  id, product_id: [productId, 'x'], quantity_done: qty, product_uom: [1, 'u'], picking_id: [pickingId, 'EC/OUT/1'],
});

// Odoo falso: registra [model, method, args, kwargs]; responde por "model.method".
export function fakeOdoo(over = {}) {
  const calls = [];
  let nextId = 1000;
  const handlers = {
    'sale.order.search_read': () => [],
    'sale.order.read': ([ids], kw) => (kw.fields.includes('partner_id')
      ? [{ id: ids[0], partner_id: [77, 'Ana'], partner_shipping_id: [78, 'Ana envío'] }]
      : [{ id: ids[0], name: 'S12000', state: 'draft' }]),
    'sale.order.create': () => nextId++,
    'sale.order.action_confirm': () => true,
    'sale.order.message_post': () => 55,
    'ir.attachment.create': () => [nextId++],
    'stock.move.read': ([ids]) => ids.map((i) => move(i)),
    'stock.move.search_read': () => [],
    'stock.picking.search_read': () => [],
    'stock.return.picking.create': () => [nextId++],
    'stock.return.picking.create_returns': () => ({ res_id: 4321 }),
    'stock.picking.write': () => true,
    'stock.picking.read': ([ids]) => [{ id: ids[0], name: 'EC/RET/00100', state: 'assigned' }],
    ...over,
  };
  const run = async (model, method, args = [], kwargs = {}) => {
    calls.push([model, method, structuredClone(args), structuredClone(kwargs)]);
    const h = handlers[`${model}.${method}`];
    if (!h) throw new Error(`sin handler: ${model}.${method}`);
    return h(args, kwargs);
  };
  return { odoo: { read: run, write: run }, calls };
}

export function depsFor(odoo, { db, saved = [], validate } = {}) {
  return {
    odoo,
    readMoves: (ids) => rOdoo.readMoves(ids, odoo),
    returnedQtyByMove: (ids) => rOdoo.returnedQtyByMove(ids, odoo),
    findPickingByOrigin: (origin) => rOdoo.findPickingByOrigin(origin, odoo),
    createReturnPicking: (args) => rOdoo.createReturnPicking(args, odoo),
    validatePicking: validate ?? ((id, lots) => rOdoo.validatePicking(id, lots, odoo)),
    saveOdooSteps: async (id, steps) => {
      saved.push(structuredClone(steps));
      if (db) await store.saveOdooSteps(id, steps, db);
    },
    readEvidence: async (path) => ({ base64: 'QUJD', mimetype: 'image/jpeg', name: path.split('/').pop() }),
    getSettings: async () => settings,
    store: db && {
      getWebReturn: (id) => store.getWebReturn(id, db),
      claimTransition: (id, action, u, extra) => store.claimTransition(id, action, u, extra, undefined, db),
      finishTransition: (id, args) => store.finishTransition(id, args, db),
      failTransition: (id, err) => store.failTransition(id, err, db),
    },
  };
}

export const writes = (calls) => calls.filter(([, m]) => !['read', 'search_read', 'search'].includes(m)).map(([mo, me]) => `${mo}.${me}`);
export const callOf = (calls, key) => calls.find(([mo, me]) => `${mo}.${me}` === key);
