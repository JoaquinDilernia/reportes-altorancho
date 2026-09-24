import {
  findOrCreatePartner, findSalesTeamId, findPricelistId, findProductIdBySku, findPaymentMethodId,
  findShippingProductId, createShippingPartner, buildSaleOrderPayload, createSaleOrder, confirmSaleOrder,
  readOrderLineIds, readOrderName,
} from './feriaOdoo.mjs';
import { PAYMENT_METHODS, odooLinePricing, netOfIva, SHIPPING_COST } from './feriaPricing.mjs';
import { needsShipping, RESERVING_STATUSES } from './feriaLines.mjs';
import { feriaLocationIds } from './feriaStock.mjs';
import { deliverLines } from './feriaDelivery.mjs';
import { invoiceOrder } from './feriaInvoice.mjs';
import {
  getOrderById, saveOdooOrderId, saveOdooLineIds, markOrderConfirmed, applyOrderLineActions, setOrderErrorDetail,
} from './feriaOrders.mjs';

export function buildOdooLines(activeLines, paymentMethod, productIds, shippingProductId) {
  const lines = activeLines.map((line, i) => ({
    productId: productIds[i], qty: line.qty, ...odooLinePricing(line, paymentMethod),
  }));
  if (shippingProductId) {
    lines.push({ productId: shippingProductId, qty: 1, unitPrice: netOfIva(SHIPPING_COST), discountPct: 0 });
  }
  return lines;
}

// La línea de envío (si hay) va siempre última, así que alcanza con
// emparejar por posición.
export function pairOdooLineIds(activeLines, odooLineIds) {
  if (odooLineIds.length < activeLines.length) {
    throw new Error(`Odoo devolvió ${odooLineIds.length} líneas y el pedido tiene ${activeLines.length}`);
  }
  return Object.fromEntries(activeLines.map((line, i) => [line.lineId, odooLineIds[i]]));
}

// Crea (si hace falta) y confirma el pedido en Odoo, y entrega en el acto lo
// que el cliente se lleva ahora. Es reintentable: si un intento anterior ya
// creó el sale.order, no se crea otro (ver comentario en la ruta).
export async function confirmOrder(order, user) {
  let odooOrderId = order.odooOrderId;
  // Las eliminadas no viajan. Líneas de pedidos viejos (sin status) sí.
  const activeLines = order.lines.filter((l) => l.status !== 'eliminado');

  if (!odooOrderId) {
    const partnerId = await findOrCreatePartner({
      name: order.customer.name, docNumber: order.customer.docNumber, phone: order.customer.phone,
    });
    const teamId = await findSalesTeamId(process.env.ODOO_FERIA_TEAM_NAME);
    const pricelistId = await findPricelistId(process.env.ODOO_FERIA_PRICELIST_NAME);
    if (!pricelistId) throw new Error(`Pricelist de feria no encontrada en Odoo: "${process.env.ODOO_FERIA_PRICELIST_NAME}"`);
    const odooPaymentName = PAYMENT_METHODS[order.paymentMethod]?.odooName;
    const paymentMethodId = await findPaymentMethodId(odooPaymentName);
    if (!paymentMethodId) throw new Error(`Medio de pago no encontrado en Odoo: "${odooPaymentName ?? order.paymentMethod}"`);

    const productIds = [];
    for (const line of activeLines) {
      const productId = await findProductIdBySku(line.sku);
      if (!productId) throw new Error(`SKU no encontrado en Odoo: ${line.sku}`);
      productIds.push(productId);
    }

    let shippingProductId = null;
    let partnerShippingId = null;
    if (needsShipping(activeLines)) {
      shippingProductId = await findShippingProductId();
      if (!shippingProductId) throw new Error('Producto de envío no encontrado en Odoo (ODOO_FERIA_SHIPPING_PRODUCT_NAME)');
      partnerShippingId = await createShippingPartner(partnerId, order.customer.name, order.shipping);
    }

    const vals = buildSaleOrderPayload({
      partnerId, pricelistId, teamId, paymentMethodId,
      warehouseId: Number(process.env.ODOO_FERIA_WAREHOUSE_ID) || null,
      partnerShippingId,
      clientOrderRef: order.number ?? null,
      lines: buildOdooLines(activeLines, order.paymentMethod, productIds, shippingProductId),
    });
    odooOrderId = await createSaleOrder(vals);
    // El id se guarda ANTES de seguir: si algo falla después, el pedido de
    // Odoo YA existe y un reintento no tiene que crear otro.
    await saveOdooOrderId(order.id, odooOrderId);
  }

  // Afuera del if: cubre también el reintento de un intento que creó el
  // pedido pero se cortó antes de guardar los ids de línea.
  if (activeLines.some((l) => l.lineId && !l.odooLineId)) {
    await saveOdooLineIds(order.id, pairOdooLineIds(activeLines, await readOrderLineIds(odooOrderId)));
  }

  // Re-confirmar uno ya confirmado es un no-op seguro en Odoo.
  await confirmSaleOrder(odooOrderId);
  const odooOrderName = await readOrderName(odooOrderId);
  await markOrderConfirmed(order.id, { odooOrderId, odooOrderName });

  // Lo que se lleva ahora sale ya de exhibición. Si falla, el pedido queda
  // confirmado igual (la venta está hecha) y se avisa para marcarlo con "Hecho".
  const confirmed = await getOrderById(order.id);
  const ahora = confirmed.lines.filter((l) => l.delivery === 'ahora' && RESERVING_STATUSES.has(l.status) && l.odooLineId);
  if (ahora.length) {
    try {
      const exhibicionId = feriaLocationIds().exhibicion;
      await deliverLines(odooOrderId, ahora.map((l) => ({ odooLineId: l.odooLineId, qty: l.qty, locationId: exhibicionId })));
      await applyOrderLineActions(order.id, ahora.map((l) => l.lineId), 'deliver', { user });
    } catch (err) {
      await setOrderErrorDetail(order.id,
        `Pedido confirmado, pero no se pudo marcar como entregado lo que se lleva ahora (${err.message}). Marcalo con "Hecho".`);
    }
  }

  // Factura B con CAE. Si falla, la venta queda confirmada y el error queda
  // en invoiceError para que Caja reintente (no tira).
  await invoiceOrder({ ...confirmed, odooOrderId });
  return getOrderById(order.id);
}
