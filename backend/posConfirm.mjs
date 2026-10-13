// Confirmar una venta del POS en Odoo: un sale.order por depósito de origen
// (local / Rolón, spike S1b), todos con el equipo del local vendedor y el
// número interno como referencia. Reintentable POR GRUPO: cada pedido creado
// se guarda antes de crear el siguiente, y un reintento reusa los que ya
// existen. Lo que falla después de confirmar (Exhibición, entrega en el acto,
// factura) no deshace la venta: queda un aviso para resolverlo.
import {
  getLocale, getLocales, getSettings, getPaymentMethodsById, originLocationId, resolveOdooPaymentName,
} from './posConfig.mjs';
import { principalPayment } from './posPricing.mjs';
import { shouldAutoRetry } from './posLines.mjs';
import * as orders from './posOrders.mjs';
import * as odoo from './posOdoo.mjs';
import { validateTwoStep } from './posDelivery.mjs';
import { withOrderLock } from './feriaDelivery.mjs';
import { getDb } from './firestore.mjs';

const RETRY_EVERY_MS = 3 * 60 * 1000;
const RETRY_USER = 'Reintento automático';

export function invoicingEnabledFor(locale) {
  return process.env.POS_INVOICING_ENABLED === 'true' && Boolean(locale?.invoiceJournalId);
}

// Asigna los ids de sale.order.line por posición (Odoo los devuelve en el
// orden de creación; la de envío, si la hay, es la última).
export function pairOdooLineIds(lines, odooLineIds) {
  const active = lines.filter((l) => l.status !== 'eliminado');
  if (odooLineIds.length < active.length) {
    throw new Error(`Odoo devolvió ${odooLineIds.length} líneas y el pedido tiene ${active.length}`);
  }
  const byLine = new Map(active.map((l, i) => [l.lineId, odooLineIds[i]]));
  return lines.map((l) => (byLine.has(l.lineId) ? { ...l, odooLineId: byLine.get(l.lineId) } : l));
}

const odooIdsOf = (order) => (order.odooOrders?.length
  ? order.odooOrders.map((o) => o.odooOrderId)
  : [order.odooOrderId]).filter(Boolean);

// ---- Factura única para todos los pedidos de la venta ----

const invoiceDeps = () => ({
  findOrderInvoices: odoo.findOrderInvoices, createInvoiceForOrders: odoo.createInvoiceForOrders,
  postInvoice: odoo.postInvoice, markOrderInvoiced: orders.markOrderInvoiced, setInvoiceError: orders.setInvoiceError,
});

// Facturas de venta de cualquiera de los pedidos (sin repetir): una factura
// validada en cualquiera gana siempre y nunca se emite una segunda.
async function invoicesOf(orderIds, deps) {
  const byId = new Map();
  for (const id of orderIds) for (const inv of await deps.findOrderInvoices(id)) byId.set(inv.id, inv);
  return [...byId.values()];
}

// Factura la venta ya confirmada en el diario del local vendedor (el borrador
// toma un diario por defecto; postInvoice lo corrige antes de publicar).
// Nunca tira: el error queda en el pedido y se reintenta desde caja.
export function invoicePosOrder(order, locale, deps = invoiceDeps()) {
  const orderIds = odooIdsOf(order);
  return withOrderLock(orderIds[0], async () => {
    try {
      let step = odoo.planInvoiceStep(await invoicesOf(orderIds, deps));
      if (step.action === 'create') {
        await deps.createInvoiceForOrders(orderIds);
        step = odoo.planInvoiceStep(await invoicesOf(orderIds, deps));
        if (step.action === 'create') throw new Error('Odoo no creó la factura');
      }
      const invoice = step.action === 'done' ? step.invoice : await deps.postInvoice(step.invoiceId, locale.invoiceJournalId);
      const saved = { invoiceId: invoice.id, invoiceName: invoice.name };
      await deps.markOrderInvoiced(order.id, saved);
      return { status: 'invoiced', ...saved };
    } catch (err) {
      const error = `La venta está confirmada pero no se pudo facturar: ${err.message}`;
      try {
        await deps.setInvoiceError(order.id, error);
      } catch (saveErr) {
        console.error('[pos] no se pudo guardar el error de facturación:', saveErr.message);
      }
      return { status: 'error', error };
    }
  });
}

// ---- Confirmación ----

function defaultDeps() {
  return {
    findOrCreatePosPartner: odoo.findOrCreatePosPartner, findPaymentMethodId: odoo.findPaymentMethodId,
    findProductIdBySku: odoo.findProductIdBySku, createChildPartner: odoo.createChildPartner,
    createSaleOrder: odoo.createSaleOrder, saveOdooOrders: orders.saveOdooOrders,
    readOrderLineIds: odoo.readOrderLineIds, saveOdooLineIds: orders.saveOdooLineIds,
    confirmSaleOrder: odoo.confirmSaleOrder, readOrderName: odoo.readOrderName,
    markOrderConfirmed: orders.markOrderConfirmed, getOrder: orders.getOrder,
    alignFirstLegMoves: odoo.alignFirstLegMoves, validateTwoStep,
    markLinesDelivered: orders.markLinesDelivered, setOrderWarning: orders.setOrderWarning,
    invoice: (order, locale) => invoicePosOrder(order, locale),
  };
}

// Contacto de entrega del pedido de un grupo: envío → dirección del cliente;
// retiro → "Retira en Local X"; todo "ahora" → ninguno (el cliente).
async function shippingPartnerFor(groupLines, order, partnerId, ctx, deps) {
  const kind = odoo.shippingPartnerKindFor(groupLines);
  if (kind === 'envio') {
    return deps.createChildPartner(odoo.buildShippingPartnerVals(partnerId, order.customer.name, order.shipping));
  }
  if (kind !== 'pickup') return null;
  const pickup = groupLines.find((l) => odoo.pickupLabelFor(l, ctx.locale, ctx.locales));
  const label = odoo.pickupLabelFor(pickup, ctx.locale, ctx.locales);
  const address = pickup.delivery === 'retira_otro_local'
    ? ctx.locales.find((l) => l.id === pickup.pickupLocalId)?.address
    : pickup.delivery === 'retira_local' ? ctx.locale.address : '';
  return deps.createChildPartner(odoo.buildPickupPartnerVals(partnerId, order.customer.name, label, address));
}

async function paymentMethodIdFor(order, ctx, deps) {
  const principal = principalPayment(order.payments, ctx.methodsById);
  const odooPaymentName = resolveOdooPaymentName(ctx.methodsById.get(principal.methodId), principal.detailId);
  const paymentMethodId = await deps.findPaymentMethodId(odooPaymentName);
  if (!paymentMethodId) throw new Error(`Medio de pago no encontrado en Odoo: "${odooPaymentName}"`);
  return paymentMethodId;
}

export async function confirmPosOrder(order, user, ctx, deps = defaultDeps()) {
  const odooOrders = (order.odooOrders ?? []).map((o) => ({ ...o }));
  // Un pedido en Odoo sin el detalle por grupo no se sabe a qué grupo
  // corresponde: crear otro podría duplicar la venta.
  if (order.odooOrderId && !odooOrders.length) {
    throw new Error(`El pedido ya existe en Odoo (id ${order.odooOrderId}) sin detalle por depósito: resolvelo en Odoo`);
  }
  const existingFor = (group) => odooOrders.find((o) => o.group === group && o.odooOrderId);

  const partnerId = await deps.findOrCreatePosPartner(order.customer);
  const pending = odoo.planOdooOrders({ lines: order.lines, totals: order.totals, locale: ctx.locale, settings: ctx.settings, shippingProductId: null })
    .filter((g) => !existingFor(g.group));
  let paymentMethodId = null;
  let shippingProductId = null;
  if (pending.length) {
    paymentMethodId = await paymentMethodIdFor(order, ctx, deps);
    if (order.totals.shipping > 0) {
      shippingProductId = await deps.findProductIdBySku(ctx.settings.shippingProductSku);
      if (!shippingProductId) throw new Error(`Producto de envío no encontrado en Odoo: ${ctx.settings.shippingProductSku}`);
    }
  }
  const plan = odoo.planOdooOrders({ lines: order.lines, totals: order.totals, locale: ctx.locale, settings: ctx.settings, shippingProductId });

  // 1. Un pedido por grupo, en orden; cada uno se guarda ANTES de seguir.
  for (const group of plan) {
    if (existingFor(group.group)) continue;
    const partnerShippingId = await shippingPartnerFor(group.lines, order, partnerId, ctx, deps);
    const vals = odoo.buildSaleOrderPayload({
      partnerId, pricelistId: ctx.settings.fullPricelistId || undefined, teamId: ctx.locale.teamId, paymentMethodId,
      warehouseId: group.warehouseId, partnerShippingId, clientOrderRef: order.number, lines: group.odooLines,
    });
    if (!vals.pricelist_id) delete vals.pricelist_id;
    const odooOrderId = await deps.createSaleOrder(vals);
    odooOrders.push({ group: group.group, odooOrderId, odooOrderName: null });
    await deps.saveOdooOrders(order.id, odooOrders.map((o) => ({ ...o })));
  }

  // 2. Ids de línea de Odoo, por grupo.
  let lines = order.lines;
  let paired = false;
  for (const group of plan) {
    const groupLines = lines.filter((l) => group.lines.some((g) => g.lineId === l.lineId));
    if (!groupLines.some((l) => !l.odooLineId)) continue;
    const groupPaired = pairOdooLineIds(groupLines, await deps.readOrderLineIds(existingFor(group.group).odooOrderId));
    const byLine = new Map(groupPaired.map((l) => [l.lineId, l.odooLineId]));
    lines = lines.map((l) => (byLine.has(l.lineId) ? { ...l, odooLineId: byLine.get(l.lineId) } : l));
    paired = true;
  }
  if (paired) await deps.saveOdooLineIds(order.id, lines);

  // 3. Confirmar todos (reconfirmar uno ya confirmado no crea nada nuevo).
  for (const o of odooOrders) {
    await deps.confirmSaleOrder(o.odooOrderId);
    o.odooOrderName = await deps.readOrderName(o.odooOrderId);
  }
  await deps.markOrderConfirmed(order.id, { odooOrders: odooOrders.map((o) => ({ ...o })), user });

  const localOrderId = odooOrders.find((o) => o.group === 'local')?.odooOrderId ?? null;
  const { local } = odoo.splitByOrigin(lines);
  const warnings = [];

  // 4. Exhibición: el PICK tiene que salir de la exhibición, no del Stock.
  const exhibicion = local.filter((l) => l.origin === 'exhibicion');
  if (localOrderId && exhibicion.length) {
    try {
      await deps.alignFirstLegMoves(localOrderId, exhibicion.map((l) => ({
        odooLineId: l.odooLineId, locationId: originLocationId(ctx.locale, ctx.settings, l.origin),
      })));
    } catch (err) {
      warnings.push(`No se pudo apuntar el PICK a Exhibición (${err.message}): corregilo en Odoo`);
    }
  }

  // 5. "Se lo lleva ahora": PICK y OUT validados en el acto.
  const ahora = local.filter((l) => l.delivery === 'ahora' && l.status === 'activo');
  if (localOrderId && ahora.length) {
    try {
      await deps.validateTwoStep(localOrderId, ahora.map((l) => ({
        odooLineId: l.odooLineId, qty: l.qty, locationId: originLocationId(ctx.locale, ctx.settings, l.origin),
      })));
      await deps.markLinesDelivered(order.id, ahora.map((l) => l.lineId), user);
    } catch (err) {
      warnings.push(`Venta confirmada, pero no se pudo validar la entrega en el acto (${err.message}): validá PICK y OUT en Odoo`);
    }
  }
  if (warnings.length) await deps.setOrderWarning(order.id, warnings.join(' · '));

  // 6. Factura (nunca tira).
  if (order.wantsInvoice && invoicingEnabledFor(ctx.locale)) {
    await deps.invoice({ ...order, lines, odooOrders, odooOrderId: odooOrders[0].odooOrderId }, ctx.locale);
  }
  return deps.getOrder(order.id);
}

async function loadCtx(localId) {
  const [locale, locales, settings, methodsById] = await Promise.all([
    getLocale(localId), getLocales(), getSettings(), getPaymentMethodsById(),
  ]);
  return { locale, locales, settings, methodsById };
}

export async function claimAndConfirmPos(orderId, user) {
  let order;
  try {
    const claim = await orders.claimOrderForConfirm(orderId, user);
    if (claim.alreadyConfirmed) return claim.order;
    order = claim.order;
  } catch (err) {
    err.stage = 'claim';
    throw err;
  }
  try {
    return await confirmPosOrder(order, user.name, await loadCtx(order.localId));
  } catch (err) {
    try {
      await orders.markOrderError(order.id, err.message);
    } catch (markErr) {
      console.error('[pos] no se pudo marcar el pedido como error:', markErr.message);
    }
    err.stage = 'odoo';
    throw err;
  }
}

export async function retryFailedPosOrders(now = Date.now()) {
  const locales = await getLocales();
  const snap = await getDb().collection(orders.COLLECTION).where('queueKey', 'in', locales.map((l) => `${l.id}_error`)).get();
  const due = snap.docs.filter((d) => shouldAutoRetry(d.data(), now));
  let confirmed = 0;
  for (const doc of due) {
    try {
      const localId = doc.data().localId;
      // Con la caja del local cerrada no se confirma: no se gastan intentos.
      const pointer = await orders.cashPointerRef(getDb(), localId).get();
      if (!pointer.data()?.openSessionId) continue;
      if (!(await orders.recordAutoRetry(doc.id))) continue;
      await claimAndConfirmPos(doc.id, { id: 'auto', name: RETRY_USER, role: 'caja', localId });
      confirmed += 1;
    } catch (err) {
      console.error(`[posRetry] ${doc.id} sigue sin confirmar (${err.stage ?? 'error'}): ${err.message}`);
    }
  }
  return { due: due.length, confirmed };
}

export function startPosAutoRetry() {
  const run = () => retryFailedPosOrders().catch((err) => console.error('[posRetry] error:', err.message));
  setInterval(run, RETRY_EVERY_MS);
}

// ---- Anulación ----

const annulDeps = () => ({
  getOrder: orders.getOrder, hasDeliveredMoves: odoo.hasDeliveredMoves, hasDoneTransfers: odoo.hasDoneTransfers,
  cancelSaleOrder: odoo.cancelSaleOrder, markOrderAnnulled: orders.markOrderAnnulled,
});

// Anular una venta confirmada sin factura y sin nada movido. Con factura hace
// falta nota de crédito (Fase 2): se deriva a facturación. Se revisan TODOS
// los pedidos de Odoo antes de cancelar alguno.
export async function annulPosOrder(orderId, user, reason, deps = annulDeps()) {
  const order = await deps.getOrder(orderId);
  if (order.localId !== user.localId) throw Object.assign(new Error('No tenés acceso a ese local'), { status: 403 });
  const odooIds = odooIdsOf(order);
  if (order.status !== 'confirmado' || !odooIds.length) throw new Error('Solo se anulan ventas confirmadas');
  if (order.invoiceName) throw new Error(`La venta tiene la factura ${order.invoiceName}: la anulación con nota de crédito la hace facturación`);
  return withOrderLock(odooIds[0], async () => {
    let moved = order.lines.some((l) => l.status === 'entregado');
    for (const id of odooIds) {
      if (moved) break;
      // hasDeliveredMoves ve el OUT; hasDoneTransfers además un PICK validado.
      moved = (await deps.hasDeliveredMoves(id)) || (await deps.hasDoneTransfers(id));
    }
    if (moved) throw new Error('Parte del pedido ya se entregó o se preparó: la devolución se hace en Odoo');
    for (const id of odooIds) await deps.cancelSaleOrder(id);
    return deps.markOrderAnnulled(orderId, user.name, reason);
  });
}
