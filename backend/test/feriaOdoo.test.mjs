import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInvoiceStep, invoiceWizardContext, buildSaleOrderPayload, buildShippingPartnerVals, buildNewPartnerVals, partnerPhoneUpdate, existingPartnerUpdate } from '../feriaOdoo.mjs';

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

test('el número interno de la app viaja en "Referencia del cliente" del pedido', () => {
  const payload = buildSaleOrderPayload({ partnerId: 42, pricelistId: 7, clientOrderRef: 'F-0012', lines: [] });
  assert.equal(payload.client_order_ref, 'F-0012');
  assert.equal('client_order_ref' in buildSaleOrderPayload({ partnerId: 42, pricelistId: 7, lines: [] }), false);
});

test('planInvoiceStep: sin factura se crea; en borrador se valida; validada ya está', () => {
  assert.deepEqual(planInvoiceStep([]), { action: 'create' });
  assert.deepEqual(planInvoiceStep([{ id: 9, state: 'draft', name: '/' }]), { action: 'post', invoiceId: 9 });
  const posted = { id: 9, state: 'posted', name: 'FA-B 00009-00031962' };
  assert.deepEqual(planInvoiceStep([posted]), { action: 'done', invoice: posted });
});

test('planInvoiceStep: una factura cancelada no cuenta (se crea otra)', () => {
  assert.deepEqual(planInvoiceStep([{ id: 9, state: 'cancel', name: 'FA-B 1' }]), { action: 'create' });
  // Si hay validada y otra en borrador, manda la validada: nunca se emite una segunda.
  const posted = { id: 10, state: 'posted', name: 'FA-B 2' };
  assert.deepEqual(planInvoiceStep([{ id: 11, state: 'draft', name: '/' }, posted]), { action: 'done', invoice: posted });
});

test('invoiceWizardContext: el asistente Crear factura de Odoo actúa sobre ese pedido', () => {
  assert.deepEqual(invoiceWizardContext(60081), { active_model: 'sale.order', active_ids: [60081], active_id: 60081 });
});

test('buildNewPartnerVals carga el email del cliente nuevo', () => {
  assert.deepEqual(buildNewPartnerVals({ name: 'Juan', docNumber: '20304050607', phone: '1155555555', email: 'juan@mail.com' }), {
    name: 'Juan', vat: '20304050607', phone: '1155555555', email: 'juan@mail.com',
  });
});

test('existingPartnerUpdate: el email se pisa si cambió (la factura sale a ese mail); el teléfono solo se completa', () => {
  assert.deepEqual(existingPartnerUpdate({ phone: '1144444444', email: 'viejo@mail.com' }, { phone: '1155555555', email: 'nuevo@mail.com' }),
    { email: 'nuevo@mail.com' });
  assert.deepEqual(existingPartnerUpdate({ phone: false, email: false }, { phone: '1155555555', email: 'juan@mail.com' }),
    { phone: '1155555555', email: 'juan@mail.com' });
  assert.equal(existingPartnerUpdate({ phone: '1144444444', email: 'Juan@Mail.com' }, { phone: '1155555555', email: 'juan@mail.com' }), null);
  // Pedidos viejos (sin email) no borran el email de Odoo.
  assert.equal(existingPartnerUpdate({ phone: '1144444444', email: 'juan@mail.com' }, { phone: '1155555555' }), null);
});

test('docIdentityType: 7-8 dígitos DNI, CUIT válido CUIT, el resto sin tipo', async () => {
  const { docIdentityType, isValidCuit } = await import('../feriaOdoo.mjs');
  assert.equal(docIdentityType('40127242'), 'dni');
  assert.equal(docIdentityType('4.012.724'), 'dni');
  assert.equal(isValidCuit('20304050609'), true);
  assert.equal(docIdentityType('20-30405060-9'), 'cuit');
  assert.equal(docIdentityType('20304050607'), null);
  assert.equal(docIdentityType('123'), null);
});

test('buildNewPartnerVals: DNI con su tipo y Consumidor Final; CUIT con su tipo', () => {
  const ids = { dni: 5, cuit: 4, consumidorFinal: 9 };
  assert.deepEqual(buildNewPartnerVals({ name: 'Ana', docNumber: '40127242' }, ids), {
    name: 'Ana', vat: '40127242', l10n_latam_identification_type_id: 5, l10n_ar_afip_responsibility_type_id: 9,
  });
  assert.deepEqual(buildNewPartnerVals({ name: 'SA', docNumber: '20304050609' }, ids), {
    name: 'SA', vat: '20304050609', l10n_latam_identification_type_id: 4,
  });
});

test('partnerIdentityUpdate: completa tipo DNI y Consumidor Final al cliente existente que no los tiene', async () => {
  const { partnerIdentityUpdate } = await import('../feriaOdoo.mjs');
  const ids = { dni: 5, cuit: 4, consumidorFinal: 9 };
  assert.deepEqual(partnerIdentityUpdate({ l10n_latam_identification_type_id: [1, 'VAT'] }, '40127242', ids),
    { l10n_latam_identification_type_id: 5, l10n_ar_afip_responsibility_type_id: 9 });
  assert.deepEqual(partnerIdentityUpdate({ l10n_latam_identification_type_id: [5, 'DNI'], l10n_ar_afip_responsibility_type_id: [1, 'RI'] }, '40127242', ids), {});
  // No pisa un tipo ya cargado a mano (p. ej. Pasaporte).
  assert.deepEqual(partnerIdentityUpdate({ l10n_latam_identification_type_id: [2, 'Pasaporte'], l10n_ar_afip_responsibility_type_id: [5, 'CF'] }, '40127242', ids), {});
  assert.deepEqual(partnerIdentityUpdate({}, 'ABC', ids), {});
});

test('Buenos Aires: cliente nuevo con provincia y país; el existente sin provincia la recibe', async () => {
  const { partnerIdentityUpdate } = await import('../feriaOdoo.mjs');
  const ids = { dni: 5, cuit: 4, consumidorFinal: 9, state: 554, country: 10 };
  const vals = buildNewPartnerVals({ name: 'Ana', docNumber: '40127242' }, ids);
  assert.equal(vals.state_id, 554);
  assert.equal(vals.country_id, 10);
  assert.deepEqual(partnerIdentityUpdate({ l10n_latam_identification_type_id: [5, 'DNI'], l10n_ar_afip_responsibility_type_id: [9, 'CF'] }, '40127242', ids),
    { state_id: 554, country_id: 10 });
  // Con provincia cargada (aunque sea otra) no se toca; país solo si falta.
  assert.deepEqual(partnerIdentityUpdate({ state_id: [553, 'CABA'], l10n_latam_identification_type_id: [5, 'DNI'], l10n_ar_afip_responsibility_type_id: [9, 'CF'] }, '40127242', ids), {});
  assert.deepEqual(partnerIdentityUpdate({ country_id: [10, 'AR'] }, 'ABC', ids), { state_id: 554 });
});
