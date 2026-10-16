// Confirmar lo que vuelve en Odoo (spec Fase 2 §6): devoluciones de remito o
// ingreso suelto → traslado a otro depósito si el destino lo pide → NC
// (parcial sobre la factura original, o suelta) → lo nuevo con el flujo de la
// Fase 1 → aplicación de la NC. Cada paso se guarda en returnSteps ANTES de
// seguir; un reintento sigue desde donde quedó y adopta lo que Odoo ya tiene
// (búsqueda por origen / referencia) en vez de duplicar.
import { returnDestinationsOf } from './posConfig.mjs';
import { activeLines } from './posLines.mjs';
import { invoiceGroups } from './posReturns.mjs';
import * as rOdoo from './posReturnsOdoo.mjs';
import * as orders from './posOrders.mjs';
import { postInvoice } from './feriaOdoo.mjs';
import { findOrCreatePosPartner } from './posOdoo.mjs';

export function defaultReturnDeps() {
  return {
    readMoves: rOdoo.readMoves, returnedQtyByMove: rOdoo.returnedQtyByMove, findPickingByOrigin: rOdoo.findPickingByOrigin,
    createReturnPicking: rOdoo.createReturnPicking, createManualReturn: rOdoo.createManualReturn, validatePicking: rOdoo.validatePicking,
    createInternalTransfer: rOdoo.createInternalTransfer, latestLotFor: rOdoo.latestLotFor,
    findPartnerId: (customer) => findOrCreatePosPartner(customer),
    findCreditNoteByRef: rOdoo.findCreditNoteByRef, createCreditNoteFromInvoice: rOdoo.createCreditNoteFromInvoice,
    createStandaloneCreditNote: rOdoo.createStandaloneCreditNote, trimCreditNote: rOdoo.trimCreditNote,
    readCreditNoteState: rOdoo.readCreditNoteState, readMoveResiduals: rOdoo.readMoveResiduals,
    postCreditNote: (ncId, journalId) => postInvoice(ncId, journalId),
    // Por defecto no se factura; posConfirm lo pisa con invoicingEnabledFor.
    invoicingEnabled: () => false,
    applyCreditNote: rOdoo.applyCreditNote, saveReturnSteps: orders.saveReturnSteps, saveAppliedCreditNotes: orders.saveAppliedCreditNotes,
    markOrderConfirmed: orders.markOrderConfirmed, clearPostConfirmPending: orders.clearPostConfirmPending, getOrder: orders.getOrder,
  };
}

const sumByProduct = (lines) => {
  const map = new Map();
  for (const l of lines) map.set(l.productId, (map.get(l.productId) ?? 0) + l.qty);
  return [...map].map(([productId, qty]) => ({ productId, qty }));
};

// Puro. `movesById`: moves de los remitos originales; `returnedByMove`: lo ya
// devuelto en Odoo por move (para repartir y para el tope).
export function planReturnSteps(order, movesById, returnedByMove, ctx) {
  const destinations = new Map(returnDestinationsOf(ctx.locale, ctx.settings).map((d) => [d.id, d]));
  const pickings = new Map();
  const manuals = new Map();
  for (const l of order.returnLines) {
    const dest = destinations.get(l.destinationId);
    if (!dest) throw new Error(`${l.sku}: el destino ya no existe, elegí otro`);
    if (l.source === 'manual') {
      const key = `manual:${dest.id}`;
      if (!manuals.has(key)) manuals.set(key, { key, locationId: dest.locationId, lines: [] });
      manuals.get(key).lines.push(l);
      continue;
    }
    const moves = l.moveIds.map((mid) => movesById.get(mid)).filter(Boolean);
    const parts = rOdoo.allocateToMoves(l.qty, moves, returnedByMove);
    for (const part of parts) {
      const move = movesById.get(part.moveId);
      const pickingId = move.picking_id[0];
      const key = `pick:${l.source}:${l.purchaseId}:${pickingId}:${dest.id}`;
      if (!pickings.has(key)) pickings.set(key, { key, pickingId, locationId: dest.locationId, items: [], lines: [] });
      const group = pickings.get(key);
      group.items.push({ moveId: part.moveId, productId: move.product_id[0], uomId: move.product_uom[0], qty: part.qty });
      group.lines.push({ ...l, qty: part.qty });
    }
  }
  const transfers = [...destinations.values()]
    .filter((d) => d.transferToLocationId && order.returnLines.some((l) => l.destinationId === d.id))
    .map((d) => ({
      key: `transfer:${d.id}`, fromLocationId: d.locationId, toLocationId: d.transferToLocationId,
      items: sumByProduct(order.returnLines.filter((l) => l.destinationId === d.id)),
    }));
  return { pickings: [...pickings.values()], manuals: [...manuals.values()], transfers };
}

const lotsMap = (lines) => {
  const map = new Map();
  for (const l of lines) if (l.lots?.length) map.set(l.productId, l.lots);
  return map;
};

export async function runReturnSteps(order, ctx, deps = defaultReturnDeps()) {
  const steps = {
    pickings: { ...(order.returnSteps?.pickings ?? {}) }, transfers: { ...(order.returnSteps?.transfers ?? {}) },
    creditNotes: { ...(order.returnSteps?.creditNotes ?? {}) }, creditNotesSkipped: false,
  };
  const save = () => deps.saveReturnSteps(order.id, structuredClone(steps));
  const origin = (key) => `${order.number} · ${key}`;

  // El plan se arma UNA vez y se guarda antes de crear nada en Odoo: un
  // reintento lo reusa tal cual (repartir de nuevo entre remitos podría dar
  // otras claves y duplicar una devolución).
  let plan = order.returnSteps?.plan;
  if (!plan) {
    // Tope: lo devuelto en Odoo SIN contar los remitos de esta operación.
    const moveIds = [...new Set(order.returnLines.flatMap((l) => l.moveIds ?? []))];
    const moves = moveIds.length ? await deps.readMoves(moveIds) : [];
    const movesById = new Map(moves.map((m) => [m.id, m]));
    const pendingPlan = Object.keys(steps.pickings).length === 0;
    const returnedByMove = moveIds.length && pendingPlan ? await deps.returnedQtyByMove(moveIds) : new Map();
    plan = structuredClone(planReturnSteps(order, movesById, returnedByMove, ctx));
    steps.plan = plan;
    await save();
  } else {
    steps.plan = plan;
  }

  // 1. Devoluciones de remito.
  for (const group of plan.pickings) {
    let step = steps.pickings[group.key];
    if (step?.state === 'done') continue;
    if (!step) {
      const found = await deps.findPickingByOrigin(origin(group.key));
      const pickingId = found?.id ?? await deps.createReturnPicking({
        pickingId: group.pickingId, items: group.items, locationId: group.locationId,
        origin: origin(group.key),
      });
      step = { id: pickingId, name: found?.name ?? null, state: found?.state ?? 'draft' };
      steps.pickings[group.key] = step;
      await save();
    }
    steps.pickings[group.key] = await deps.validatePicking(step.id, lotsMap(group.lines));
    await save();
  }

  // 2. Ingresos sin ticket (lote: el más reciente del producto).
  for (const group of plan.manuals) {
    let step = steps.pickings[group.key];
    if (step?.state === 'done') continue;
    if (!step) {
      const found = await deps.findPickingByOrigin(origin(group.key));
      const partnerId = order.customer.odooPartnerId ?? await deps.findPartnerId(order.customer);
      const pickingId = found?.id ?? await deps.createManualReturn({
        pickingTypeId: ctx.locale.returnPickingTypeId, locationId: group.locationId, partnerId,
        items: sumByProduct(group.lines), origin: origin(group.key),
      });
      step = { id: pickingId, name: found?.name ?? null, state: found?.state ?? 'draft' };
      steps.pickings[group.key] = step;
      await save();
    }
    const lots = new Map();
    for (const l of group.lines) {
      const lotId = await deps.latestLotFor(l.productId);
      if (lotId) lots.set(l.productId, [{ lotId, qty: l.qty }]);
    }
    steps.pickings[group.key] = await deps.validatePicking(step.id, lots);
    await save();
  }

  // 3. Traslados a otro depósito: quedan pendientes para que logística los valide.
  for (const t of plan.transfers) {
    if (steps.transfers[t.key]) continue;
    const found = await deps.findPickingByOrigin(origin(t.key));
    steps.transfers[t.key] = found ?? await deps.createInternalTransfer({
      pickingTypeId: ctx.locale.internalPickingTypeId, fromLocationId: t.fromLocationId, toLocationId: t.toLocationId,
      items: t.items, origin: origin(t.key),
    });
    await save();
  }

  // 4. Notas de crédito (solo con la facturación del local habilitada).
  if (!deps.invoicingEnabled(ctx.locale)) {
    steps.creditNotesSkipped = true;
    await save();
    return steps;
  }
  const reason = `${order.number} devolución`;
  const ncGroups = invoiceGroups(order.returnLines).map((g) => ({ key: `nc:${g.invoiceId}`, invoiceId: g.invoiceId, lines: g.lines }));
  const manualLines = order.returnLines.filter((l) => l.source === 'manual');
  if (manualLines.length) ncGroups.push({ key: 'nc:manual', invoiceId: null, lines: manualLines });
  for (const g of ncGroups) {
    let step = steps.creditNotes[g.key];
    if (step?.state === 'posted') continue;
    // Termina con delimitador: "nc:3682 ·" no matchea "nc:36821 ·" (la búsqueda es ilike).
    const ref = `${reason} ${g.key} ·`;
    let fresh = false;
    if (!step) {
      const found = await deps.findCreditNoteByRef(ref);
      let ncId = found?.id;
      if (!ncId && g.invoiceId) {
        ncId = await deps.createCreditNoteFromInvoice({ invoiceId: g.invoiceId, journalId: ctx.locale.invoiceJournalId, reason: ref, items: sumByProduct(g.lines) });
        fresh = true;
      } else if (!ncId) {
        const partnerId = order.customer.odooPartnerId ?? await deps.findPartnerId(order.customer);
        ncId = await deps.createStandaloneCreditNote({
          journalId: ctx.locale.invoiceJournalId, partnerId, reason: ref,
          items: g.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitValue: l.unitValue })),
        });
        fresh = true;
      }
      step = { id: ncId, name: found?.name ?? null, state: found?.state ?? 'draft' };
      steps.creditNotes[g.key] = step;
      await save();
      // Adoptada ya publicada: no se vuelve a publicar.
      if (step.state === 'posted') continue;
    }
    // Guardada (o adoptada) en borrador: puede haberse publicado en Odoo y
    // perdido la respuesta. Si ya está publicada no se recorta ni se publica.
    if (!fresh && step.state === 'draft') {
      const current = await deps.readCreditNoteState(step.id);
      if (current?.state === 'posted') {
        steps.creditNotes[g.key] = { id: step.id, name: current.name ?? step.name ?? null, state: 'posted' };
        await save();
        continue;
      }
    }
    // Una NC sobre factura en borrador que no se acaba de crear puede ser la
    // reversión completa (falla entre reverse_moves y el recorte): se recorta de nuevo.
    if (g.invoiceId && !fresh && step.state === 'draft') await deps.trimCreditNote(step.id, sumByProduct(g.lines));
    steps.creditNotes[g.key] = await deps.postCreditNote(step.id, ctx.locale.invoiceJournalId);
    await save();
  }
  return steps;
}

const pesos = (n) => `$ ${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;

// Puro. ¿Se aplica sola la NC de un saldo? Odoo concilia lo menor entre lo
// abierto de la NC y lo abierto de la factura: solo si eso no pasa del saldo
// usado en este pedido (si no, se aplicaría saldo que el cliente no usó).
export const saldoNcAutoApplies = ({ ncResidual, invoiceResidual, saldoLeft }) =>
  Math.min(ncResidual, invoiceResidual) <= saldoLeft + 0.01;

// Después de facturar lo nuevo: aplica las NC de esta operación (`own`) y las
// de los saldos usados (`saldo`, con tope en lo usado). Nunca tira: devuelve avisos.
export async function applyCreditNotesStep(order, invoiceId, { own = [], saldo = [] }, deps = defaultReturnDeps()) {
  const warnings = [];
  const applied = [...(order.appliedCreditNoteIds ?? [])];
  const ownIds = new Set(own);
  let saldoLeft = orders.saldoAmount(order.payments, order.totals);
  for (const ncId of [...own, ...saldo.filter((id) => !ownIds.has(id))]) {
    if (applied.includes(ncId)) continue;
    try {
      if (!ownIds.has(ncId)) {
        const residuals = await deps.readMoveResiduals([ncId, invoiceId]);
        const nc = residuals.get(ncId);
        const ncResidual = nc?.residual ?? 0;
        const invoiceResidual = residuals.get(invoiceId)?.residual ?? 0;
        if (!saldoNcAutoApplies({ ncResidual, invoiceResidual, saldoLeft })) {
          warnings.push(`Aplicá en Odoo la nota de crédito ${nc?.name ?? ncId} por ${pesos(Math.max(saldoLeft, 0))} a la factura`);
          continue;
        }
        saldoLeft -= Math.min(ncResidual, invoiceResidual);
      }
      await deps.applyCreditNote(invoiceId, ncId);
      applied.push(ncId);
      await deps.saveAppliedCreditNotes(order.id, applied);
    } catch (err) {
      warnings.push(`No se pudo aplicar la nota de crédito ${ncId} a la factura (${err.message}): aplicala en Odoo`);
    }
  }
  return warnings;
}

export async function confirmReturnOrder(order, user, ctx, deps) {
  const returnSteps = await runReturnSteps(order, ctx, deps);
  const withSteps = { ...order, returnSteps };
  if (activeLines(order.lines).length) return deps.confirmPosOrder(withSteps, user, ctx);
  await deps.markOrderConfirmed(order.id, { odooOrders: [], user });
  await deps.clearPostConfirmPending(order.id);
  return deps.getOrder(order.id);
}
