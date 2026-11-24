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

export function normalizeOdooSaleOrder(order, lines, categoryBySku, { channel = 'mayorista', amountCollected = 0, team = false } = {}) {
  // Feria docs keep their Odoo sales team (each team is one fair/expo).
  const teamFields = team && Array.isArray(order.team_id) ? { teamId: order.team_id[0], team: order.team_id[1] } : {};
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
    ...teamFields,
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
  // tiendanube_order_payment_status only auto-updates for orders paid through
  // a Tiendanube online gateway; offline methods (transferencia, efectivo)
  // leave it stuck on 'pending' forever even after Odoo confirms and invoices
  // the order. Odoo's own state is the reliable signal — same as mayorista's
  // normalizeOdooSaleOrder, which reads the same sale.order model.
  const status =
    order.state === 'cancel' ? 'cancelled' :
    ['sale', 'done'].includes(order.state) ? 'completed' :
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

// Odoo devuelve datetimes naive en UTC ('YYYY-MM-DD HH:MM:SS'); new Date() los
// leería en la zona del proceso. Acá la zona del proceso no debe importar.
export function parseSourceDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(value.replace(' ', 'T') + 'Z');
  }
  return new Date(value);
}

// Nota de crédito (account.move out_refund) como "venta negativa" del canal de
// su pedido original: resta facturación y unidades, pero no es un pedido
// (kind 'refund'; los conteos de pedidos/tickets la saltean). Misma base que
// el canal: ecommerce sin IVA y sin envío, el resto con IVA (amount_total).
// Una NC anulada o vuelta a borrador queda 'void' y no suma en ningún lado.
export function normalizeOdooCreditNote(move, lines, channel, categoryBySku, { team = null } = {}) {
  const productLines = lines.filter(l => l.display_type === 'product' && l.product_id);
  const isEcommerce = channel === 'ecommerce';
  let shipping = 0;
  const items = [];
  for (const l of productLines) {
    const sku = extractSkuFromDisplayName(l.product_id[1]);
    if (isEcommerce && sku === SHIPPING_SKU) { shipping += l.price_subtotal; continue; }
    items.push({
      sku,
      name: stripSkuFromDisplayName(l.product_id[1]),
      category: categoryBySku.get(sku) || null,
      qty: -l.quantity,
      unitPrice: isEcommerce ? (l.quantity ? l.price_subtotal / l.quantity : 0) : l.price_unit,
    });
  }

  const doc = {
    id: `refund_${move.id}`,
    channel,
    kind: 'refund',
    sourceId: move.name,
    date: creditNoteDate(move),
    status: move.state === 'posted' ? 'completed' : 'void',
    total: isEcommerce ? -(move.amount_untaxed - shipping) : -move.amount_total,
    paymentMethod: null,
    shippingProvince: null,
    items,
  };
  if (isEcommerce) doc.shippingRevenue = -shipping;
  // Una NC conciliada contra la factura la deja "pagada" sin que entre plata:
  // su parte conciliada se descuenta de lo cobrado.
  if (channel === 'mayorista') doc.amountCollected = -(move.amount_total - move.amount_residual);
  if (team) Object.assign(doc, { teamId: team[0], team: team[1] });
  return doc;
}

// La NC cuenta el día de su fecha contable (invoice_date). Si se creó ese mismo
// día (hora argentina) usa la hora real; si no, el mediodía de ese día.
function creditNoteDate(move) {
  const day = move.invoice_date || move.date;
  const created = move.create_date ? parseSourceDate(move.create_date) : null;
  if (created && (!day || new Date(created.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) === day)) {
    return move.create_date;
  }
  return `${day} 15:00:00`;
}
