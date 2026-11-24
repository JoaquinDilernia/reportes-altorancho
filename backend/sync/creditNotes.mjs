// Notas de crédito (devoluciones, anulaciones y descuentos posteriores a la
// venta). Los pedidos quedan confirmados por su total aunque después se emita
// una NC contra su factura, así que sin esto el reporte sumaba de más contra
// la facturación neta de administración. Cada NC se guarda como una "venta
// negativa" (kind 'refund') del canal de su pedido original.
import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooCreditNote } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';
import { TIENDANUBE_TEAM_ID } from './ecommerce.mjs';
import { MAYORISTA_TEAM_ID } from './mayorista.mjs';
import { FERIA_TEAM_IDS } from './feria.mjs';
import { POS_STORES } from './posLocales.mjs';

const CHUNK_SIZE = 2000;
const META_KEY = 'credit_notes';

const id = (m2o) => (Array.isArray(m2o) ? m2o[0] : null);

// Mismo criterio que cada sync de ventas para decidir si un pedido cuenta y en
// qué canal. null = ese pedido no se cuenta en el reporte (cambios, ventas
// internas, etc.), así que su NC tampoco.
export function channelOfOrder(order) {
  const team = id(order.team_id);
  if (team === TIENDANUBE_TEAM_ID) return order.tiendanube_order_id ? 'ecommerce' : null;
  if (team === MAYORISTA_TEAM_ID) return 'mayorista';
  if (FERIA_TEAM_IDS.includes(team)) return 'feria';
  const store = POS_STORES.find((s) => s.teamId === team);
  if (store) return (order.client_order_ref || '').startsWith(store.prefix) ? store.channel : null;
  return null;
}

// NC sin pedido vinculado (p. ej. un descuento cargado a mano, o la NC manual de
// una venta del Punto de Venta viejo): va al canal de su equipo de ventas.
function channelOfTeam(team) {
  if (team === TIENDANUBE_TEAM_ID) return 'ecommerce';
  if (team === MAYORISTA_TEAM_ID) return 'mayorista';
  if (FERIA_TEAM_IDS.includes(team)) return 'feria';
  return POS_STORES.find((s) => s.teamId === team)?.channel ?? null;
}

// { channel, team } o null si la NC no se cuenta. Las NC del Punto de Venta de
// Odoo (pos_order_ids) se saltean: ese reembolso ya es un pos.order negativo
// que sync/locales.mjs trae, sumarla de nuevo lo restaría dos veces.
export function creditNoteChannel(move, linkedOrders) {
  if (move.pos_order_ids?.length) return null;
  if (linkedOrders.length) {
    for (const o of linkedOrders) {
      const channel = channelOfOrder(o);
      if (channel) return { channel, team: o.team_id || null };
    }
    return null;
  }
  const channel = channelOfTeam(id(move.team_id));
  return channel ? { channel, team: move.team_id || null } : null;
}

async function readChunked(model, ids, fields) {
  const out = [];
  for (const idChunk of chunk(ids, CHUNK_SIZE)) out.push(...await callKw(model, 'read', [idChunk], { fields }));
  return out;
}

export async function syncCreditNotes(categoryBySku, sinceOverride) {
  await authenticate();
  // Cursor taken before querying Odoo, minus a 2-min overlap (same as the other syncs).
  const cursor = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const meta = await getSyncMetadata(META_KEY);
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  // write_date, no fecha: una NC publicada, anulada o vuelta a borrador después
  // se vuelve a leer y actualiza su doc (void si ya no está publicada).
  const moves = await fetchAll('account.move', [['move_type', '=', 'out_refund'], ['write_date', '>=', since]], [
    'id', 'name', 'state', 'invoice_date', 'date', 'create_date', 'amount_total', 'amount_untaxed',
    'amount_residual', 'team_id', 'pos_order_ids', 'invoice_line_ids',
  ]);

  const lines = await readChunked('account.move.line', moves.flatMap((m) => m.invoice_line_ids), [
    'move_id', 'product_id', 'quantity', 'price_unit', 'price_subtotal', 'display_type', 'sale_line_ids',
  ]);
  const saleLines = await readChunked('sale.order.line', [...new Set(lines.flatMap((l) => l.sale_line_ids))], ['order_id']);
  const orderIdBySaleLine = new Map(saleLines.map((sl) => [sl.id, id(sl.order_id)]));
  const orders = await readChunked('sale.order', [...new Set(orderIdBySaleLine.values())], ['team_id', 'tiendanube_order_id', 'client_order_ref']);
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const linesByMove = new Map();
  for (const l of lines) {
    const moveId = id(l.move_id);
    if (!linesByMove.has(moveId)) linesByMove.set(moveId, []);
    linesByMove.get(moveId).push(l);
  }

  const docs = [];
  for (const move of moves) {
    const moveLines = linesByMove.get(move.id) || [];
    const orderIds = [...new Set(moveLines.flatMap((l) => l.sale_line_ids).map((sl) => orderIdBySaleLine.get(sl)).filter(Boolean))];
    const target = creditNoteChannel(move, orderIds.map((oid) => orderById.get(oid)).filter(Boolean));
    if (!target) continue;
    docs.push(normalizeOdooCreditNote(move, moveLines, target.channel, categoryBySku, {
      team: target.channel === 'feria' ? target.team : null,
    }));
  }

  await saveSalesDocs(docs);
  await setSyncMetadata(META_KEY, { lastSyncedAt: cursor, count: docs.length });
  console.log(`[sync:creditNotes] ${docs.length} notas de crédito (${moves.length} leídas)`);
  return { count: docs.length, read: moves.length };
}
