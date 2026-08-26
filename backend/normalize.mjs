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
      qty: Number(p.quantity),
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

export function normalizeOdooSaleOrder(order, lines, categoryBySku, { channel = 'mayorista', amountCollected = 0 } = {}) {
  const status =
    order.state === 'cancel' ? 'cancelled' :
    ['sale', 'done'].includes(order.state) ? 'completed' :
    'pending';

  return {
    id: `${channel}_${order.id}`,
    channel,
    sourceId: String(order.id),
    date: order.date_order,
    status,
    total: Number(order.amount_total),
    // Mayorista is often confirmed (state=sale, counted in `total`) well
    // before it's actually invoiced and paid — this is the amount actually
    // collected so far (sum of amount_total - amount_residual across the
    // order's linked invoices), 0 for orders with no invoice yet.
    amountCollected: Number(amountCollected),
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

const SHIPPING_SKU = 'Delivery_007';

function stripCountrySuffix(name) {
  return name.replace(/\s*\([A-Z]{2}\)$/, '');
}

export function normalizeOdooEcommerceOrder(order, lines, categoryBySku, provinceName) {
  const status =
    order.state === 'cancel' ? 'cancelled' :
    order.tiendanube_order_payment_status === 'paid' ? 'completed' :
    'pending';

  const productLines = [];
  let shippingRevenue = 0;
  for (const l of lines) {
    const sku = extractSkuFromDisplayName(l.product_id[1]);
    if (sku === SHIPPING_SKU) {
      shippingRevenue += l.price_subtotal;
    } else {
      productLines.push(l);
    }
  }

  return {
    id: `ecommerce_${order.tiendanube_order_id}`,
    channel: 'ecommerce',
    sourceId: String(order.tiendanube_order_id),
    date: order.date_order,
    status,
    total: order.amount_untaxed - shippingRevenue,
    shippingRevenue,
    paymentMethod: order.tiendanube_gateway_name || null,
    shippingProvince: provinceName ? stripCountrySuffix(provinceName) : null,
    items: productLines.map(l => {
      const sku = extractSkuFromDisplayName(l.product_id[1]);
      return {
        sku,
        name: stripSkuFromDisplayName(l.product_id[1]),
        category: categoryBySku.get(sku) || null,
        qty: l.product_uom_qty,
        unitPrice: l.product_uom_qty ? l.price_subtotal / l.product_uom_qty : 0,
      };
    }),
  };
}
