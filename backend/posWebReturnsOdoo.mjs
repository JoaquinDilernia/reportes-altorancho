// Cambios y devoluciones web en Odoo (spec §5.3). Al aprobar: pedido de cambio
// confirmado en $0 (solo en cambio), evidencia en el chatter y devolución del
// EC/OUT original SIN validar. Al recibir: se valida esa devolución.
// Cada paso se guarda antes de seguir; un reintento sigue desde donde quedó y
// adopta lo que Odoo ya tiene (client_order_ref / origin) en vez de duplicar.
import { webReturnDestinationsOf, getSettings } from './posConfig.mjs';
import { buildOdooNoteLines } from './posWebReturns.mjs';
import { netOfIva, round2 } from './posPricing.mjs';
import { defaultOdoo } from './posOdoo.mjs';
import * as rOdoo from './posReturnsOdoo.mjs';
import * as store from './posWebReturnsStore.mjs';

export function defaultWebReturnDeps() {
  return {
    odoo: defaultOdoo,
    readMoves: rOdoo.readMoves, returnedQtyByMove: rOdoo.returnedQtyByMove, findPickingByOrigin: rOdoo.findPickingByOrigin,
    createReturnPicking: rOdoo.createReturnPicking, validatePicking: rOdoo.validatePicking,
    saveOdooSteps: store.saveOdooSteps,
    // Lazy: el módulo de evidencia (Storage) recién se carga al usarlo.
    readEvidence: async (storagePath) => (await import('./posWebReturnsEvidence.mjs')).readEvidenceFile(storagePath),
    store, getSettings,
  };
}

const firstId = (res) => (Array.isArray(res) ? res[0] : res);
const isDryId = (id) => Number(id) < 0;
// En dry no se adopta nada de Odoo: lo de producción no es de esta prueba.
const isDry = () => process.env.ODOO_WRITES === 'dry';
const validId = (id) => Number.isInteger(id) && id !== 0;

// Lotes de las líneas que vuelven, por producto (se suman por lote).
function lotsByProduct(lines) {
  const out = {};
  for (const l of lines) {
    if (!l.lots?.length) continue;
    const byLot = new Map((out[l.productId] ?? []).map((x) => [x.lotId, x.qty]));
    for (const { lotId, qty } of l.lots) byLot.set(lotId, (byLot.get(lotId) ?? 0) + qty);
    out[l.productId] = [...byLot].map(([lotId, qty]) => ({ lotId, qty }));
  }
  return out;
}

// Puro. Reparte cada línea entre los moves del EC/OUT original y agrupa por
// remito original + destino. Lo ya repartido en este plan cuenta como devuelto.
export function planWebReturnPickings(request, movesById, returnedByMove, settings) {
  const destinations = new Map(webReturnDestinationsOf(settings).map((d) => [d.id, d]));
  const used = new Map(returnedByMove);
  const groups = new Map();
  for (const l of request.returnLines ?? []) {
    const dest = destinations.get(l.destinationId);
    if (!dest) throw new Error(`${l.sku}: el destino ya no existe, elegí otro`);
    const moves = (l.moveIds ?? []).map((mid) => movesById.get(mid)).filter(Boolean);
    for (const part of rOdoo.allocateToMoves(l.qty, moves, used)) {
      used.set(part.moveId, (used.get(part.moveId) ?? 0) + part.qty);
      const m = movesById.get(part.moveId);
      const pickingId = m.picking_id[0];
      const key = `pick:${pickingId}:${dest.id}`;
      if (!groups.has(key)) groups.set(key, { key, pickingId, locationId: dest.locationId, items: [] });
      groups.get(key).items.push({ moveId: part.moveId, productId: m.product_id[0], uomId: m.product_uom[0], qty: part.qty });
    }
  }
  return [...groups.values()];
}

const noteLine = (name) => ({ display_type: 'line_note', name, product_id: false, product_uom_qty: 0, price_unit: 0 });

// Líneas del pedido de cambio: productos nuevos en $0 (la primera lleva la
// diferencia si el cambio es a algo más caro), envío y notas.
export function buildExchangeLines(request, settings) {
  const net = Number(request.money?.net) || 0;
  const newLines = request.newLines ?? [];
  // Lleva la diferencia la primera línea nueva con cantidad; nunca se pierde.
  const carrier = net > 0 ? newLines.findIndex((l) => Number(l.qty) >= 1) : -1;
  if (net > 0 && carrier < 0) throw new Error('No hay producto nuevo para cargar la diferencia');
  const lines = newLines.map((l, i) => ({
    product_id: l.productId, product_uom_qty: l.qty,
    price_unit: i === carrier ? round2(netOfIva(net) / l.qty) : 0,
  }));
  const ship = Number(request.logistics?.shippingCharge) || 0;
  if (ship > 0) lines.push({ product_id: settings.webReturns.shippingProductId, product_uom_qty: 1, price_unit: round2(netOfIva(ship)) });
  return [...lines, ...buildOdooNoteLines(request).map(noteLine)];
}

async function readOrderState(odoo, id) {
  const [so] = await odoo.read('sale.order', 'read', [[id]], { fields: ['id', 'name', 'state'] });
  if (!so) throw new Error(`No se encontró el pedido de cambio ${id} en Odoo`);
  return so;
}

async function saleOrderStep(request, settings, steps, deps, save) {
  const { odoo } = deps;
  const w = settings.webReturns;
  let state = null;
  if (!steps.saleOrder) {
    const [found] = isDry() ? [] : await odoo.read('sale.order', 'search_read', [[['client_order_ref', '=', request.number]]], { fields: ['id', 'name', 'state'], limit: 1 });
    if (found) {
      steps.saleOrder = { id: found.id, name: found.name ?? null, confirmed: false };
      state = found.state;
      await save();
    } else {
      const [orig] = await odoo.read('sale.order', 'read', [[Number(request.purchase.purchaseId)]], { fields: ['partner_id', 'partner_shipping_id'] });
      if (!orig?.partner_id) throw new Error('No se encontró el pedido original en Odoo');
      const partnerId = orig.partner_id[0];
      const id = firstId(await odoo.write('sale.order', 'create', [{
        partner_id: partnerId, partner_shipping_id: orig.partner_shipping_id?.[0] ?? partnerId,
        warehouse_id: w.warehouseId, team_id: w.teamId, tag_ids: [[6, 0, [w.tagId]]], client_order_ref: request.number,
        order_line: buildExchangeLines(request, settings).map((l) => [0, 0, l]),
      }]));
      if (!id) throw new Error('Odoo no creó el pedido de cambio');
      steps.saleOrder = { id, name: null, confirmed: false };
      await save();
    }
  }
  const so = steps.saleOrder;
  if (so.confirmed) return;
  if (isDryId(so.id)) {
    so.name = so.name ?? request.number;
    state = 'draft';
  } else if (!state || !so.name) {
    const cur = await readOrderState(odoo, so.id);
    so.name = cur.name ?? so.name;
    state = cur.state;
  }
  if (state === 'cancel') throw new Error(`El pedido de cambio ${so.name} está cancelado en Odoo`);
  if (!['sale', 'done'].includes(state)) await odoo.write('sale.order', 'action_confirm', [[so.id]]);
  so.confirmed = true;
  await save();
}

async function evidenceStep(request, steps, deps, save) {
  const evidence = request.evidence ?? [];
  if (!evidence.length) return;
  const resId = request.kind === 'cambio' ? steps.saleOrder.id : Number(request.purchase.purchaseId);
  steps.evidence = { attachmentIds: [...(steps.evidence?.attachmentIds ?? [])], posted: !!steps.evidence?.posted };
  const ev = steps.evidence;
  if (ev.posted) return;
  for (let i = ev.attachmentIds.length; i < evidence.length; i += 1) {
    const file = await deps.readEvidence(evidence[i].storagePath);
    const id = firstId(await deps.odoo.write('ir.attachment', 'create', [{
      name: file.name, datas: file.base64, mimetype: file.mimetype ?? evidence[i].mimetype, res_model: 'sale.order', res_id: resId,
    }]));
    if (!validId(id)) throw new Error(`Odoo no creó el adjunto de ${file.name}`);
    ev.attachmentIds.push(id);
    await save();
  }
  await deps.odoo.write('sale.order', 'message_post', [[resId]], {
    body: `Evidencia del cambio ${request.number}`, attachment_ids: ev.attachmentIds,
    subtype_xmlid: 'mail.mt_note', // nota interna: nunca un mail al cliente
  });
  ev.posted = true;
  await save();
}

const sumQty = (rows, qtyOf) => {
  const m = new Map();
  for (const r of rows) m.set(r.productId, (m.get(r.productId) ?? 0) + qtyOf(r));
  return m;
};

async function readPicking(odoo, id) {
  const [p] = await odoo.read('stock.picking', 'read', [[id]], { fields: ['id', 'name', 'state', 'origin'] });
  return p ?? null;
}

// Deja nuestro origin en la devolución si no lo tiene ya (vacío o el del asistente).
async function ensureOrigin(odoo, picking, origin) {
  if (picking.origin === origin) return;
  await odoo.write('stock.picking', 'write', [[picking.id], { origin }]);
  picking.origin = origin;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Origin adoptable: vacío, el nuestro, o el que pone el asistente de Odoo al
// crear la devolución ("Retorno de EC/OUT/47954" con es_AR).
export function adoptableOrigin(current, ours, originalPickingName) {
  const o = String(current || '').trim();
  if (!o || o === ours) return true;
  if (!originalPickingName) return false;
  return new RegExp(`^(Retorno de|Return of|Devolución de) ${escapeRe(originalPickingName)}$`).test(o);
}

// Una devolución abierta de los moves del grupo que quedó sin nuestro origin
// (se perdió la respuesta o falló el write del origin): se adopta solo si trae
// exactamente los mismos productos y cantidades (nunca más stock del pedido).
async function findOpenReturn(group, origin, odoo) {
  const moveIds = group.items.map((i) => i.moveId);
  const moves = await odoo.read('stock.move', 'search_read', [[
    ['origin_returned_move_id', 'in', moveIds], ['state', 'not in', ['done', 'cancel']],
  ]], { fields: ['picking_id', 'product_id', 'product_uom_qty'] });
  const need = sumQty(group.items, (i) => i.qty);
  const byPicking = new Map();
  for (const m of moves) {
    const pid = m.picking_id?.[0];
    if (!pid) continue;
    if (!byPicking.has(pid)) byPicking.set(pid, []);
    byPicking.get(pid).push({ productId: m.product_id?.[0], qty: Number(m.product_uom_qty) || 0 });
  }
  let originalName;
  for (const [pid, rows] of byPicking) {
    const have = sumQty(rows, (r) => r.qty);
    if (have.size !== need.size || ![...need].every(([prod, q]) => have.get(prod) === q)) continue;
    if (originalName === undefined) originalName = (await readPicking(odoo, group.pickingId))?.name ?? null;
    const picking = await readPicking(odoo, pid);
    if (!picking || !adoptableOrigin(picking.origin, origin, originalName)) continue;
    await ensureOrigin(odoo, picking, origin);
    return picking;
  }
  return null;
}

const CREATED_RE = /Se creó la devolución (-?\d+)/;

async function pickingsStep(request, steps, deps, save) {
  const { odoo } = deps;
  const origin = (key) => `${request.number} · ${key}`;
  for (const group of steps.plan) {
    const moveIds = new Set(group.items.map((i) => i.moveId));
    const lines = (request.returnLines ?? []).filter((l) => group.key.endsWith(`:${l.destinationId}`) && (l.moveIds ?? []).some((mid) => moveIds.has(mid)));
    const lots = lotsByProduct(lines);
    const saved = steps.pickings[group.key];
    if (saved) {
      // Creada sin saber su estado (falló el origin): se lee y se marca.
      if (saved.state == null && !isDryId(saved.id)) {
        const p = await readPicking(odoo, saved.id);
        if (!p) throw new Error(`No se encontró la devolución ${saved.id} en Odoo`);
        await ensureOrigin(odoo, p, origin(group.key));
        steps.pickings[group.key] = { ...saved, name: p.name ?? null, state: p.state ?? null };
        await save();
      }
      continue;
    }
    const found = isDry() ? null
      : (await deps.findPickingByOrigin(origin(group.key))) ?? (await findOpenReturn(group, origin(group.key), odoo));
    let step;
    if (found) step = { id: found.id, name: found.name ?? null, state: found.state ?? null };
    else {
      let id;
      try {
        id = await deps.createReturnPicking({ pickingId: group.pickingId, items: group.items, locationId: group.locationId, origin: origin(group.key) });
      } catch (err) {
        const created = CREATED_RE.exec(err?.message ?? '');
        if (created) {
          steps.pickings[group.key] = { id: Number(created[1]), name: null, state: null, lots };
          await save();
        }
        throw err;
      }
      step = { id, name: null, state: 'draft' };
      // Guardado ya: si la lectura falla, el reintento no la recrea.
      steps.pickings[group.key] = { ...step, lots };
      await save();
      if (!isDryId(id)) {
        const p = await readPicking(odoo, id);
        if (p) step = { id, name: p.name ?? null, state: p.state ?? 'draft' };
      }
    }
    steps.pickings[group.key] = { ...step, lots };
    await save();
  }
}

export async function runApprovalSteps(request, settings, deps = defaultWebReturnDeps()) {
  const prev = request.odoo?.steps ?? {};
  const steps = structuredClone({ ...prev, pickings: prev.pickings ?? {} });
  const save = () => deps.saveOdooSteps(request.id, structuredClone(steps));

  // El plan se arma UNA vez, antes de escribir nada, y se guarda: un reintento
  // lo reusa tal cual (repartir de nuevo podría dar otras claves y duplicar).
  if (!steps.plan) {
    const moveIds = [...new Set((request.returnLines ?? []).flatMap((l) => l.moveIds ?? []))];
    const moves = moveIds.length ? await deps.readMoves(moveIds) : [];
    const returned = moveIds.length ? await deps.returnedQtyByMove(moveIds) : new Map();
    steps.plan = structuredClone(planWebReturnPickings(request, new Map(moves.map((m) => [m.id, m])), returned, settings));
    await save();
  }

  if (request.kind === 'cambio') await saleOrderStep(request, settings, steps, deps, save);
  await evidenceStep(request, steps, deps, save);
  await pickingsStep(request, steps, deps, save); // nunca se valida al aprobar
  return steps;
}

const toLotsMap = (lots) => new Map(Object.entries(lots ?? {}).map(([pid, list]) => [Number(pid), list]));

export async function runReceiveSteps(request, deps = defaultWebReturnDeps()) {
  const prev = request.odoo?.steps ?? {};
  const steps = structuredClone({ ...prev, pickings: prev.pickings ?? {} });
  const save = () => deps.saveOdooSteps(request.id, structuredClone(steps));
  const keys = steps.plan ? steps.plan.map((g) => g.key) : Object.keys(steps.pickings);
  for (const key of keys) {
    const step = steps.pickings[key];
    if (!step) throw new Error(`Falta la devolución ${key} en Odoo`);
    if (process.env.ODOO_WRITES === 'dry' && isDryId(step.id)) {
      steps.pickings[key] = { ...step, state: 'done' };
      await save();
      continue;
    }
    const [cur] = await deps.odoo.read('stock.picking', 'read', [[step.id]], { fields: ['state', 'name'] });
    if (!cur) throw new Error(`No se encontró la devolución ${step.name ?? step.id} en Odoo`);
    const name = cur.name ?? step.name ?? String(step.id);
    if (cur.state === 'cancel') throw new Error(`La devolución ${name} está cancelada en Odoo: recreala desde el detalle`);
    let state = cur.state;
    if (state !== 'done') {
      const done = await deps.validatePicking(step.id, toLotsMap(step.lots));
      state = done?.state;
      if (state !== 'done') throw new Error(`La devolución ${name} no quedó validada en Odoo (${state ?? 'sin estado'}): validala en Odoo`);
    }
    steps.pickings[key] = { ...step, name, state };
    await save();
  }
  return steps;
}
