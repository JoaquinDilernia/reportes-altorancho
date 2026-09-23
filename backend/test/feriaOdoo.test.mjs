import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSaleOrderPayload, buildShippingPartnerVals, buildNewPartnerVals, partnerPhoneUpdate } from '../feriaOdoo.mjs';

test('arma el payload de sale.order con las líneas en formato Odoo (0,0,{...})', () => {
  const payload = buildSaleOrderPayload({
    partnerId: 42,
    pricelistId: 7,
    teamId: 3,
    lines: [
      { productId: 100, qty: 2, unitPrice: 1500, discountPct: 10 },
      { productId: 101, qty: 1, unitPrice: 800, discountPct: 0 },
    ],
  });

  assert.equal(payload.partner_id, 42);
  assert.equal(payload.pricelist_id, 7);
  assert.equal(payload.team_id, 3);
  assert.equal(payload.order_line.length, 2);
  assert.deepEqual(payload.order_line[0], [0, 0, {
    product_id: 100, product_uom_qty: 2, price_unit: 1500, discount: 10,
  }]);
  assert.deepEqual(payload.order_line[1], [0, 0, {
    product_id: 101, product_uom_qty: 1, price_unit: 800, discount: 0,
  }]);
});

test('sin team_id (todavía no se creó el equipo de ventas en Odoo) lo omite en vez de mandar null', () => {
  const payload = buildSaleOrderPayload({
    partnerId: 42, pricelistId: 7, teamId: null, lines: [
      { productId: 100, qty: 1, unitPrice: 100, discountPct: 0 },
    ],
  });
  assert.equal('team_id' in payload, false);
});

test('con medio de pago lo carga en payment_method_ids', () => {
  const payload = buildSaleOrderPayload({
    partnerId: 42, pricelistId: 7, teamId: 3, paymentMethodId: 6, lines: [
      { productId: 100, qty: 1, unitPrice: 9990, discountPct: 20 },
    ],
  });
  assert.equal(payload.payment_method_ids, 6);
  assert.deepEqual(payload.order_line[0], [0, 0, {
    product_id: 100, product_uom_qty: 1, price_unit: 9990, discount: 20,
  }]);
});

test('sin medio de pago lo omite en vez de mandar null', () => {
  const payload = buildSaleOrderPayload({
    partnerId: 42, pricelistId: 7, teamId: 3, lines: [
      { productId: 100, qty: 1, unitPrice: 100, discountPct: 0 },
    ],
  });
  assert.equal('payment_method_ids' in payload, false);
});

test('con almacén y dirección de envío los carga en el pedido', () => {
  const payload = buildSaleOrderPayload({
    partnerId: 42, pricelistId: 7, teamId: 3, paymentMethodId: 6, warehouseId: 43, partnerShippingId: 99,
    lines: [{ productId: 100, qty: 1, unitPrice: 8256.2, discountPct: 20 }],
  });
  assert.equal(payload.warehouse_id, 43);
  assert.equal(payload.partner_shipping_id, 99);
});

test('sin almacén ni envío no manda esas claves', () => {
  const payload = buildSaleOrderPayload({ partnerId: 42, pricelistId: 7, lines: [] });
  assert.equal('warehouse_id' in payload, false);
  assert.equal('partner_shipping_id' in payload, false);
});

test('buildShippingPartnerVals arma un contacto de entrega hijo del cliente', () => {
  assert.deepEqual(buildShippingPartnerVals(42, 'Juan Pérez', {
    street: 'Av. Siempreviva', number: '742', floor: '3B', city: 'Tigre', zip: '1648', phone: '1155555555', notes: 'Tocar timbre',
  }), {
    parent_id: 42, type: 'delivery', name: 'Juan Pérez', street: 'Av. Siempreviva 742', street2: '3B',
    city: 'Tigre', zip: '1648', phone: '1155555555', comment: 'Tocar timbre',
  });
});

test('buildNewPartnerVals carga nombre, DNI/CUIT y teléfono', () => {
  assert.deepEqual(buildNewPartnerVals({ name: 'Juan', docNumber: '20304050607', phone: '1155555555' }), {
    name: 'Juan', vat: '20304050607', phone: '1155555555',
  });
  assert.deepEqual(buildNewPartnerVals({ name: 'Juan' }), { name: 'Juan' });
});

test('partnerPhoneUpdate completa el teléfono solo si el cliente de Odoo no tenía', () => {
  assert.deepEqual(partnerPhoneUpdate(false, '1155555555'), { phone: '1155555555' });
  assert.equal(partnerPhoneUpdate('1144444444', '1155555555'), null);
  assert.equal(partnerPhoneUpdate(false, ''), null);
});
