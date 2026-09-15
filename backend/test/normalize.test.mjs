import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTiendanubeOrder,
  normalizeOdooPosOrder,
  normalizeOdooSaleOrder,
  normalizeOdooEcommerceOrder,
  extractSkuFromDisplayName,
  stripSkuFromDisplayName,
} from '../normalize.mjs';

const categoryBySku = new Map([
  ['MSI018GR', 'Sillas'],
  ['BTE249MB', 'Textiles'],
]);

test('normalizeTiendanubeOrder maps a paid order to completed', () => {
  const order = {
    id: 2013996982,
    status: 'open',
    payment_status: 'paid',
    created_at: '2026-07-08T14:33:14+0000',
    total: '395960.00',
    gateway_name: 'Mercado Pago',
    shipping_address: { province: 'Capital Federal' },
    products: [{ sku: 'MSI018GR', name: 'Silla Chicago Gris', quantity: 4, price: '89990.00' }],
  };

  const doc = normalizeTiendanubeOrder(order, categoryBySku);

  assert.equal(doc.id, 'ecommerce_2013996982');
  assert.equal(doc.channel, 'ecommerce');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.total, 395960);
  assert.equal(doc.paymentMethod, 'Mercado Pago');
  assert.equal(doc.shippingProvince, 'Capital Federal');
  assert.deepEqual(doc.items, [
    { sku: 'MSI018GR', name: 'Silla Chicago Gris', category: 'Sillas', qty: 4, unitPrice: 89990 },
  ]);
});

test('normalizeTiendanubeOrder maps a cancelled order regardless of payment_status', () => {
  const order = {
    id: 1, status: 'cancelled', payment_status: 'paid', created_at: '2026-01-01T00:00:00Z',
    total: '100.00', gateway_name: null, shipping_address: null, products: [],
  };
  assert.equal(normalizeTiendanubeOrder(order, categoryBySku).status, 'cancelled');
});

test('normalizeTiendanubeOrder coerces a string quantity to a number', () => {
  const order = {
    id: 3, status: 'open', payment_status: 'paid', created_at: '2026-01-01T00:00:00Z',
    total: '100.00', gateway_name: null, shipping_address: null,
    products: [{ sku: 'A', name: 'A', quantity: '3', price: '100.00' }],
  };
  const doc = normalizeTiendanubeOrder(order, categoryBySku);
  assert.equal(doc.items[0].qty, 3);
  assert.equal(typeof doc.items[0].qty, 'number');
});

test('normalizeTiendanubeOrder maps a pending payment to pending', () => {
  const order = {
    id: 2, status: 'open', payment_status: 'pending', created_at: '2026-01-01T00:00:00Z',
    total: '100.00', gateway_name: null, shipping_address: null, products: [],
  };
  assert.equal(normalizeTiendanubeOrder(order, categoryBySku).status, 'pending');
});

test('extractSkuFromDisplayName reads the bracketed SKU', () => {
  assert.equal(extractSkuFromDisplayName('[MSI018GR] SILLA CHICAGO GRIS'), 'MSI018GR');
});

test('stripSkuFromDisplayName removes the bracketed SKU', () => {
  assert.equal(stripSkuFromDisplayName('[MSI018GR] SILLA CHICAGO GRIS'), 'SILLA CHICAGO GRIS');
});

test('normalizeOdooPosOrder maps paid/done/invoiced to completed', () => {
  const order = { id: 39875, date_order: '2026-07-08 14:18:45', amount_total: 16990, state: 'invoiced' };
  const lines = [{ product_id: [1, '[MSI018GR] SILLA CHICAGO GRIS'], qty: 1, price_unit: 16990 }];

  const doc = normalizeOdooPosOrder(order, lines, 'local_lomas', categoryBySku, 'Mercado Pago');

  assert.equal(doc.id, 'local_lomas_39875');
  assert.equal(doc.channel, 'local_lomas');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.paymentMethod, 'Mercado Pago');
  assert.equal(doc.shippingProvince, null);
  assert.deepEqual(doc.items, [
    { sku: 'MSI018GR', name: 'SILLA CHICAGO GRIS', category: 'Sillas', qty: 1, unitPrice: 16990 },
  ]);
});

test('normalizeOdooPosOrder maps cancel state to cancelled', () => {
  const order = { id: 1, date_order: '2026-01-01 00:00:00', amount_total: 0, state: 'cancel' };
  assert.equal(normalizeOdooPosOrder(order, [], 'local_belgrano', categoryBySku, null).status, 'cancelled');
});

test('normalizeOdooPosOrder maps draft state to pending', () => {
  const order = { id: 1, date_order: '2026-01-01 00:00:00', amount_total: 0, state: 'draft' };
  assert.equal(normalizeOdooPosOrder(order, [], 'local_belgrano', categoryBySku, null).status, 'pending');
});

test('normalizeOdooSaleOrder maps sale/done to completed and uses product_uom_qty', () => {
  const order = { id: 51269, date_order: '2026-07-08 14:52:14', amount_total: 849746.7, state: 'sale' };
  const lines = [{ product_id: [1, '[BTE249MB] MANTEL RAYADO'], product_uom_qty: 3, price_unit: 283248.9 }];

  const doc = normalizeOdooSaleOrder(order, lines, categoryBySku);

  assert.equal(doc.id, 'mayorista_51269');
  assert.equal(doc.channel, 'mayorista');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.paymentMethod, null);
  assert.deepEqual(doc.items, [
    { sku: 'BTE249MB', name: 'MANTEL RAYADO', category: 'Textiles', qty: 3, unitPrice: 283248.9 },
  ]);
});

test('normalizeOdooSaleOrder maps draft state to pending', () => {
  const order = { id: 1, date_order: '2026-01-01 00:00:00', amount_total: 0, state: 'draft' };
  assert.equal(normalizeOdooSaleOrder(order, [], categoryBySku).status, 'pending');
});

test('normalizeOdooSaleOrder carries amountCollected through, defaulting to 0 when omitted', () => {
  const order = { id: 51269, date_order: '2026-07-08 14:52:14', amount_total: 849746.7, state: 'sale' };
  assert.equal(normalizeOdooSaleOrder(order, [], categoryBySku, { amountCollected: 300000 }).amountCollected, 300000);
  assert.equal(normalizeOdooSaleOrder(order, [], categoryBySku).amountCollected, 0);
});

test('normalizeOdooSaleOrder defaults to the mayorista channel, but accepts an override', () => {
  const order = { id: 51269, date_order: '2026-07-08 14:52:14', amount_total: 849746.7, state: 'sale' };
  const mayoristaDoc = normalizeOdooSaleOrder(order, [], categoryBySku);
  assert.equal(mayoristaDoc.id, 'mayorista_51269');
  assert.equal(mayoristaDoc.channel, 'mayorista');

  const feriaDoc = normalizeOdooSaleOrder(order, [], categoryBySku, { channel: 'feria' });
  assert.equal(feriaDoc.id, 'feria_51269');
  assert.equal(feriaDoc.channel, 'feria');
});

test('normalizeOdooEcommerceOrder maps a paid order to completed and splits out net shipping', () => {
  const order = {
    tiendanube_order_id: '2024692415',
    date_order: '2026-07-08 14:33:14',
    amount_untaxed: 27100.82,
    state: 'sale',
    tiendanube_order_payment_status: 'paid',
    tiendanube_gateway_name: 'Mercado Pago',
  };
  const lines = [
    { product_id: [57353, '[BCV187BO] SET X4 BOWLS DE CERÁMICA APILABLES BORDO 14x7 CM'], product_uom_qty: 1, price_subtotal: 27100.82 },
    { product_id: [4, '[Delivery_007] Entrega gratuita'], product_uom_qty: 1, price_subtotal: 3000 },
  ];

  const doc = normalizeOdooEcommerceOrder(order, lines, categoryBySku, 'Ciudad Autonoma De Buenos Aires (AR)');

  assert.equal(doc.id, 'ecommerce_2024692415');
  assert.equal(doc.channel, 'ecommerce');
  assert.equal(doc.sourceId, '2024692415');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.total, 24100.82);
  assert.equal(doc.shippingRevenue, 3000);
  assert.equal(doc.paymentMethod, 'Mercado Pago');
  assert.equal(doc.shippingProvince, 'Ciudad Autonoma De Buenos Aires');
  assert.deepEqual(doc.items, [
    { sku: 'BCV187BO', name: 'SET X4 BOWLS DE CERÁMICA APILABLES BORDO 14x7 CM', category: null, qty: 1, unitPrice: 27100.82 },
  ]);
});

test('normalizeOdooEcommerceOrder maps cancel state to cancelled regardless of payment status', () => {
  const order = {
    tiendanube_order_id: '1', date_order: '2026-01-01 00:00:00', amount_untaxed: 100,
    state: 'cancel', tiendanube_order_payment_status: 'paid', tiendanube_gateway_name: null,
  };
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, null).status, 'cancelled');
});

test('normalizeOdooEcommerceOrder maps sale/done to completed regardless of tiendanube_order_payment_status', () => {
  // Offline payment methods (transferencia, efectivo) never flip this field
  // to 'paid' even once Odoo has confirmed and invoiced the order, so status
  // must follow Odoo's own state, not the Tiendanube-specific field.
  const order = {
    tiendanube_order_id: '2', date_order: '2026-01-01 00:00:00', amount_untaxed: 100,
    state: 'sale', tiendanube_order_payment_status: 'pending', tiendanube_gateway_name: null,
  };
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, null).status, 'completed');
});

test('normalizeOdooEcommerceOrder maps a non-sale/done state to pending', () => {
  const order = {
    tiendanube_order_id: '2b', date_order: '2026-01-01 00:00:00', amount_untaxed: 100,
    state: 'draft', tiendanube_order_payment_status: 'paid', tiendanube_gateway_name: null,
  };
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, null).status, 'pending');
});

test('normalizeOdooEcommerceOrder defaults shippingRevenue to 0 when there is no shipping line', () => {
  const order = {
    tiendanube_order_id: '3', date_order: '2026-01-01 00:00:00', amount_untaxed: 500,
    state: 'sale', tiendanube_order_payment_status: 'paid', tiendanube_gateway_name: 'Pago Nube',
  };
  const lines = [{ product_id: [1, '[MSI018GR] SILLA CHICAGO GRIS'], product_uom_qty: 2, price_subtotal: 500 }];

  const doc = normalizeOdooEcommerceOrder(order, lines, categoryBySku, null);

  assert.equal(doc.shippingRevenue, 0);
  assert.equal(doc.total, 500);
  assert.deepEqual(doc.items, [
    { sku: 'MSI018GR', name: 'SILLA CHICAGO GRIS', category: 'Sillas', qty: 2, unitPrice: 250 },
  ]);
});

test('normalizeOdooEcommerceOrder strips the country-code suffix from the province name, and passes through null', () => {
  const order = {
    tiendanube_order_id: '4', date_order: '2026-01-01 00:00:00', amount_untaxed: 0,
    state: 'sale', tiendanube_order_payment_status: 'paid', tiendanube_gateway_name: null,
  };
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, 'Santa Fe (AR)').shippingProvince, 'Santa Fe');
  assert.equal(normalizeOdooEcommerceOrder(order, [], categoryBySku, null).shippingProvince, null);
});
