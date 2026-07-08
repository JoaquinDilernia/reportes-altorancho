export function extractSkuFromDisplayName(displayName) {
  const m = displayName.match(/^\[(.+?)\]/);
  return m ? m[1] : displayName;
}

export function stripSkuFromDisplayName(displayName) {
  return displayName.replace(/^\[.+?\]\s*/, '');
}

export function normalizeTiendanubeOrder(order, categoryBySku) {
  const status =
    order.status === 'cancelled' ? 'cancelled' :
    order.payment_status === 'paid' ? 'completed' :
    'pending';

  return {
    id: `ecommerce_${order.id}`,
    channel: 'ecommerce',
    sourceId: String(order.id),
    date: order.created_at,
    status,
    total: Number(order.total),
    paymentMethod: order.gateway_name || null,
    shippingProvince: order.shipping_address?.province || null,
    items: (order.products || []).map(p => ({
      sku: p.sku,
      name: p.name,
      category: categoryBySku.get(p.sku) || null,
      qty: p.quantity,
      unitPrice: Number(p.price),
    })),
  };
}

export function normalizeOdooPosOrder(order, lines, channel, categoryBySku, paymentMethodName) {
  const status =
    order.state === 'cancel' ? 'cancelled' :
    ['paid', 'done', 'invoiced'].includes(order.state) ? 'completed' :
    'pending';

  return {
    id: `${channel}_${order.id}`,
    channel,
    sourceId: String(order.id),
    date: order.date_order,
    status,
    total: Number(order.amount_total),
    paymentMethod: paymentMethodName || null,
    shippingProvince: null,
    items: lines.map(l => {
      const sku = extractSkuFromDisplayName(l.product_id[1]);
      return {
        sku,
        name: stripSkuFromDisplayName(l.product_id[1]),
        category: categoryBySku.get(sku) || null,
        qty: l.qty,
        unitPrice: l.price_unit,
      };
    }),
  };
}

export function normalizeOdooSaleOrder(order, lines, categoryBySku) {
  const status =
    order.state === 'cancel' ? 'cancelled' :
    ['sale', 'done'].includes(order.state) ? 'completed' :
    'pending';

  return {
    id: `mayorista_${order.id}`,
    channel: 'mayorista',
    sourceId: String(order.id),
    date: order.date_order,
    status,
    total: Number(order.amount_total),
    paymentMethod: null,
    shippingProvince: null,
    items: lines.map(l => {
      const sku = extractSkuFromDisplayName(l.product_id[1]);
      return {
        sku,
        name: stripSkuFromDisplayName(l.product_id[1]),
        category: categoryBySku.get(sku) || null,
        qty: l.product_uom_qty,
        unitPrice: l.price_unit,
      };
    }),
  };
}
