import { authenticate, callKw } from './odoo.mjs';

let authenticated = false;

export async function ensureAuth() {
  if (!authenticated) {
    await authenticate();
    authenticated = true;
  }
}

// callKwReadWithRetry reintenta si la sesión expiró, solo para operaciones
// de lectura. Las escrituras (create, action_confirm, etc.) no se reintentan
// automáticamente porque si la primera llamada tuvo éxito pero la respuesta
// se perdió a una desconexión de red, un reintento crearría duplicados.
// El panel Caja ya tiene un botón "Reintentar" manual para pedidos en estado
// 'error', así que es seguro fallar directo en el primer intento.
export async function callKwReadWithRetry(model, method, args = [], kwargs = {}) {
  await ensureAuth();
  try {
    return await callKw(model, method, args, kwargs);
  } catch (err) {
    authenticated = false;
    await ensureAuth();
    return callKw(model, method, args, kwargs);
  }
}

export async function searchProducts(query) {
  const results = await callKwReadWithRetry('product.product', 'search_read', [
    ['|', ['default_code', 'ilike', query], ['name', 'ilike', query]],
  ], { fields: ['id', 'name', 'default_code', 'lst_price'], limit: 20 });
  return results.map(p => ({
    id: p.id, name: p.name, sku: p.default_code ?? '', price: p.lst_price,
  }));
}

export async function getPricelists() {
  const results = await callKwReadWithRetry('product.pricelist', 'search_read', [[]], {
    fields: ['id', 'name'],
  });
  return results.map(p => ({ id: p.id, name: p.name }));
}

export async function findSalesTeamId(teamName) {
  if (!teamName) return null;
  const results = await callKwReadWithRetry('crm.team', 'search_read', [
    [['name', '=', teamName]],
  ], { fields: ['id'], limit: 1 });
  return results[0]?.id ?? null;
}

// Busca por CUIT/DNI (campo "vat" en Odoo) y crea el partner si no existe.
// No se cargan campos de responsabilidad fiscal AR (l10n_ar_*) porque
// dependen de qué localización tenga instalada este Odoo — confirmar
// contra la instancia real antes de necesitar Factura A (ver spec).
export function buildNewPartnerVals({ name, docNumber, phone }) {
  const vals = { name };
  if (docNumber) vals.vat = docNumber;
  if (phone) vals.phone = phone;
  return vals;
}

// Al cliente que ya existe en Odoo solo se le completa el teléfono si no
// tenía: no se pisa un dato que otra área ya cargó.
export function partnerPhoneUpdate(existingPhone, phone) {
  return !existingPhone && phone ? { phone } : null;
}

export async function findOrCreatePartner({ name, docNumber, phone }) {
  if (docNumber) {
    const existing = await callKwReadWithRetry('res.partner', 'search_read', [
      [['vat', '=', docNumber]],
    ], { fields: ['id', 'phone'], limit: 1 });
    if (existing[0]) {
      const update = partnerPhoneUpdate(existing[0].phone, phone);
      if (update) {
        await ensureAuth();
        await callKw('res.partner', 'write', [[existing[0].id], update]);
      }
      return existing[0].id;
    }
  }
  await ensureAuth();
  const [id] = await callKw('res.partner', 'create', [[buildNewPartnerVals({ name, docNumber, phone })]]);
  return id;
}

export function buildSaleOrderPayload({ partnerId, pricelistId, teamId, paymentMethodId, warehouseId, partnerShippingId, lines }) {
  const payload = {
    partner_id: partnerId,
    pricelist_id: pricelistId,
    order_line: lines.map(l => [0, 0, {
      product_id: l.productId,
      product_uom_qty: l.qty,
      price_unit: l.unitPrice,
      discount: l.discountPct,
    }]),
  };
  if (teamId) payload.team_id = teamId;
  // payment_method_ids es un many2one (a pesar del sufijo _ids) a
  // payment.method: el campo "Medio de pago" del pedido en este Odoo.
  if (paymentMethodId) payload.payment_method_ids = paymentMethodId;
  // Almacén Feria: el remito sale de ahí (y de sus ubicaciones exhibición /
  // Rolón), no del almacén por defecto.
  if (warehouseId) payload.warehouse_id = warehouseId;
  if (partnerShippingId) payload.partner_shipping_id = partnerShippingId;
  return payload;
}

export async function findPaymentMethodId(name) {
  if (!name) return null;
  const results = await callKwReadWithRetry('payment.method', 'search_read', [
    [['name', '=', name]],
  ], { fields: ['id'], limit: 1 });
  return results[0]?.id ?? null;
}

export function buildShippingPartnerVals(parentId, customerName, shipping) {
  return {
    parent_id: parentId,
    type: 'delivery',
    name: customerName,
    street: `${shipping.street} ${shipping.number}`.trim(),
    street2: shipping.floor || false,
    city: shipping.city,
    zip: shipping.zip,
    phone: shipping.phone,
    comment: shipping.notes || false,
  };
}

// Dirección de entrega como contacto hijo del cliente: así el pedido lleva
// su propia dirección sin pisar la dirección principal del cliente en Odoo.
export async function createShippingPartner(parentId, customerName, shipping) {
  await ensureAuth();
  const [id] = await callKw('res.partner', 'create', [[buildShippingPartnerVals(parentId, customerName, shipping)]]);
  return id;
}

export async function findShippingProductId() {
  const name = process.env.ODOO_FERIA_SHIPPING_PRODUCT_NAME || 'Otros envíos terciarizados';
  const results = await callKwReadWithRetry('product.product', 'search_read', [
    [['name', '=', name]],
  ], { fields: ['id'], limit: 1 });
  return results[0]?.id ?? null;
}

// Ids de sale.order.line en el orden en que se crearon (Odoo los devuelve
// ordenados por secuencia e id, que es el orden de creación).
export async function readOrderLineIds(orderId) {
  const [order] = await callKwReadWithRetry('sale.order', 'read', [[orderId]], { fields: ['order_line'] });
  return order?.order_line ?? [];
}

export async function createSaleOrder(vals) {
  await ensureAuth();
  const [id] = await callKw('sale.order', 'create', [[vals]]);
  return id;
}

export async function confirmSaleOrder(orderId) {
  await ensureAuth();
  await callKw('sale.order', 'action_confirm', [[orderId]]);
}

// Método estándar de Odoo 14+ para facturar un pedido confirmado. Si esta
// instancia usa una automatización propia para Tienda Nube (a confirmar
// durante la implementación — ver spec), puede hacer falta ajustar este
// método al que esa automatización realmente llama.
export async function createInvoiceForOrder(orderId) {
  try {
    await ensureAuth();
    const result = await callKw('sale.order', '_create_invoices', [[orderId]]);
    return Array.isArray(result) ? (result[0] ?? null) : (result ?? null);
  } catch (err) {
    console.error('[feriaOdoo] Error creando factura:', err.message);
    return null;
  }
}

// Busca un partner existente por CUIT/DNI para autocompletar datos en el
// panel Vendedor. A diferencia de findOrCreatePartner, esta función NO crea
// nada — devuelve null si no existe, para que el panel deje los campos
// vacíos y el vendedor los cargue a mano (mínimo: nombre + DNI).
export async function findPartnerByDoc(docNumber) {
  if (!docNumber) return null;
  const results = await callKwReadWithRetry('res.partner', 'search_read', [
    [['vat', '=', docNumber]],
  ], { fields: ['id', 'name', 'vat', 'email', 'phone', 'street', 'city'], limit: 1 });
  return results[0] ?? null;
}

export async function findPricelistId(name) {
  if (!name) return null;
  const results = await callKwReadWithRetry('product.pricelist', 'search_read', [
    [['name', '=', name]],
  ], { fields: ['id'], limit: 1 });
  return results[0]?.id ?? null;
}

// Resuelve el product_id real de Odoo por SKU (default_code) recién al
// confirmar la venta — la búsqueda que hace el vendedor ya no pega contra
// Odoo (ver feriaProducts.mjs), así que este es el único punto del flujo
// que necesita el id real para poder armar el sale.order.
//
// Se usa '=ilike' y no '=': los SKU en Firestore quedan siempre en
// mayúsculas (import y lookup los normalizan), pero los default_code de
// Odoo pueden estar en mayúsculas/minúsculas mezcladas. Con '=' un
// producto real no se encontraría justo al confirmar, en la caja, con el
// cliente ya habiendo pagado. '=ilike' es igualdad exacta sin distinguir
// mayúsculas (no agrega comodines por su cuenta).
export async function findProductIdBySku(sku) {
  const results = await callKwReadWithRetry('product.product', 'search_read', [
    [['default_code', '=ilike', sku]],
  ], { fields: ['id'], limit: 1 });
  return results[0]?.id ?? null;
}

export { getDb } from './firestore.mjs';
