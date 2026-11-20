// Compra web por número visible de Tienda Nube: traduce al pedido de Odoo (TN<id interno>)
// y lee la compra con el código de devoluciones del POS.

// Odoo devuelve 'YYYY-MM-DD HH:MM:SS' en UTC sin zona.
export function odooDateToISO(s) {
  if (!s || typeof s !== 'string') return s ?? null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}.000Z`;
  return s;
}

// Imports lazy: los módulos de Odoo/Firestore no se cargan hasta usarlos.
function defaultDeps() {
  return {
    findOrderByNumber: async (n) => (await import('./tiendanube.mjs')).findOrderByNumber(n),
    findSaleOrder: async (name) => {
      const { defaultOdoo } = await import('./posOdoo.mjs');
      const rows = await defaultOdoo.read('sale.order', 'search_read', [[['name', '=', name]]], { fields: ['id', 'name', 'warehouse_id'], limit: 1 });
      return rows?.[0] ?? null;
    },
    getPurchase: async (source, id) => (await import('./posReturnsService.mjs')).getPurchase(source, id),
    readReturnMoves: async (moveIds) => readReturnMoves(moveIds, (await import('./posOdoo.mjs')).defaultOdoo),
    activeRequests: async () => (await import('./posWebReturnsStore.mjs')).listActiveWebReturns(),
    settings: undefined,
  };
}

// Movimientos de devolución (no cancelados) de los moves dados, con el origin
// de su remito: devoluciones del local, de otras solicitudes web o de Odoo.
export async function readReturnMoves(moveIds, odoo) {
  if (!moveIds?.length) return [];
  const rows = await odoo.read('stock.move', 'search_read', [[
    ['origin_returned_move_id', 'in', moveIds], ['state', '!=', 'cancel'],
  ]], { fields: ['id', 'origin_returned_move_id', 'product_uom_qty', 'quantity_done', 'state', 'picking_id'] });
  const pickingIds = [...new Set(rows.map((r) => r.picking_id?.[0]).filter(Boolean))];
  const pickings = pickingIds.length ? await odoo.read('stock.picking', 'read', [pickingIds], { fields: ['id', 'origin'] }) : [];
  const originOf = new Map(pickings.map((p) => [p.id, p.origin || '']));
  return rows.map((r) => ({
    origMoveId: r.origin_returned_move_id?.[0] ?? null, pickingId: r.picking_id?.[0] ?? null,
    origin: originOf.get(r.picking_id?.[0]) ?? '', done: r.state === 'done',
    qty: Number(r.product_uom_qty) || 0, qtyDone: Number(r.quantity_done) || 0,
  }));
}

// ¿La devolución es de esta solicitud? Por el origin que le ponemos o por el id guardado.
export function ownsReturn(request, rm) {
  if (!request) return false;
  if (request.number && String(rm.origin ?? '').startsWith(`${request.number} · `)) return true;
  return Object.values(request.odoo?.steps?.pickings ?? {}).some((p) => p?.id != null && p.id === rm.pickingId);
}

// Unidades ya tomadas por línea, además de las devoluciones validadas (que ya
// vienen en qtyReturnedBefore): devoluciones abiertas de cualquier flujo y
// otras solicitudes web activas. Lo que en Odoo es de una solicitud activa se
// cuenta por sus líneas (una sola vez); lo de la propia solicitud no cuenta.
export function heldByLine(lines, returnMoves, others, self = null) {
  const lineOfMove = new Map();
  for (const l of lines) for (const mid of l.moveIds ?? []) lineOfMove.set(mid, String(l.purchaseLineId));
  const owners = self ? [...others, self] : others;
  const held = new Map();
  const add = (k, q) => held.set(k, (held.get(k) ?? 0) + q);
  for (const r of returnMoves) {
    const key = lineOfMove.get(r.origMoveId);
    if (key == null) continue;
    const owned = owners.some((o) => ownsReturn(o, r));
    if (!r.done && !owned) add(key, r.qty);
    else if (r.done && owned) add(key, -r.qtyDone);
  }
  for (const o of others) for (const rl of o.returnLines ?? []) add(String(rl.purchaseLineId), Number(rl.qty) || 0);
  return held;
}

const ACTIVE = ['pendiente_aprobacion', 'aprobada'];
const availableOf = (l) => (Number(l.qtyBought) || 0) - (Number(l.qtyReturnedBefore) || 0) - (Number(l.qtyHeld) || 0);

// excludeRequestId: la solicitud que se está editando (no cuenta contra sí misma).
export async function resolveWebPurchase(tnNumber, deps = defaultDeps(), { excludeRequestId = null } = {}) {
  const n = String(tnNumber ?? '').replace(/^[#\s]+/, '').trim();
  const tn = await deps.findOrderByNumber(n);
  if (!tn) throw new Error(`No encontramos el pedido #${n} en Tienda Nube`);
  const so = await deps.findSaleOrder(`TN${tn.id}`);
  if (!so) throw new Error(`El pedido #${n} todavía no está en Odoo`);
  const settings = deps.settings ?? (await (await import('./posConfig.mjs')).getSettings());
  if (so.warehouse_id?.[0] !== settings?.webReturns?.warehouseId) {
    throw new Error(`El pedido #${n} no salió del depósito E Commerce`);
  }
  const raw = await deps.getPurchase('web', so.id);
  const rawLines = raw.lines ?? [];
  const purchaseId = String(raw.purchaseId ?? so.id);
  const [returnMoves, active] = await Promise.all([
    deps.readReturnMoves([...new Set(rawLines.flatMap((l) => l.moveIds ?? []))]),
    deps.activeRequests(),
  ]);
  const mine = (active ?? []).filter((r) => ACTIVE.includes(r.status) && String(r.purchase?.purchaseId) === purchaseId);
  const self = excludeRequestId ? mine.find((r) => r.id === excludeRequestId) ?? null : null;
  const held = heldByLine(rawLines, returnMoves ?? [], mine.filter((r) => r.id !== excludeRequestId), self);
  const lines = rawLines.map((l) => ({ ...l, purchaseDate: odooDateToISO(l.purchaseDate), qtyHeld: held.get(String(l.purchaseLineId)) ?? 0 }));
  const purchase = { ...raw, date: odooDateToISO(raw.date), lines, ref: n, tnOrderId: tn.id };
  const returnable = lines.map((l) => ({ ...l, available: availableOf(l) })).filter((l) => l.available > 0);
  if (!returnable.length) throw new Error('Ese pedido ya no tiene productos para devolver');
  return { tn, purchase, returnable };
}

// taken: lo que ya pide la misma solicitud de esa línea (otra fila, otro destino).
export function resolveReturnLine(purchase, { purchaseLineId, qty }, taken = 0) {
  const l = (purchase?.lines ?? []).find((x) => String(x.purchaseLineId) === String(purchaseLineId));
  if (!l) throw new Error('Esa línea no está en la compra');
  const q = Number(qty);
  if (!Number.isInteger(q) || q < 1) throw new Error('Cantidad inválida');
  const available = Math.max(0, availableOf(l) - taken);
  if (q > available) throw new Error(`Solo se puede devolver ${available}`);
  return { purchaseLineId: l.purchaseLineId, productId: l.productId, sku: l.sku, name: l.name, qty: q, unitValue: l.unitValue, moveIds: l.moveIds, lots: l.lots };
}
