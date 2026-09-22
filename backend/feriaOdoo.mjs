import { authenticate, callKw } from './odoo.mjs';

let authenticated = false;

async function ensureAuth() {
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
async function callKwReadWithRetry(model, method, args = [], kwargs = {}) {
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
export async function findOrCreatePartner({ name, docNumber }) {
  if (docNumber) {
    const existing = await callKwReadWithRetry('res.partner', 'search_read', [
      [['vat', '=', docNumber]],
    ], { fields: ['id'], limit: 1 });
    if (existing[0]) return existing[0].id;
  }
  const vals = { name };
  if (docNumber) vals.vat = docNumber;
  await ensureAuth();
  const [id] = await callKw('res.partner', 'create', [[vals]]);
  return id;
}

export function buildSaleOrderPayload({ partnerId, pricelistId, teamId, lines }) {
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
  return payload;
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
export async function findProductIdBySku(sku) {
  const results = await callKwReadWithRetry('product.product', 'search_read', [
    [['default_code', '=', sku]],
  ], { fields: ['id'], limit: 1 });
  return results[0]?.id ?? null;
}

export { getDb } from './firestore.mjs';
