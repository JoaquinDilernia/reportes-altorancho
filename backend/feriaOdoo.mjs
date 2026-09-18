import { authenticate, callKw } from './odoo.mjs';

let authenticated = false;

async function ensureAuth() {
  if (!authenticated) {
    await authenticate();
    authenticated = true;
  }
}

// callKw (odoo.mjs) no reintenta si la sesión de Odoo expiró — no hace
// falta para los syncs de reportes, que corren cada pocas horas y toleran
// un reintento del propio cron. Las escrituras de este módulo pasan dinero
// real en el momento de la venta, así que si la sesión expiró, se
// reautentica una vez y se reintenta antes de fallarle al cajero.
async function callKwWithRetry(model, method, args = [], kwargs = {}) {
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
  const results = await callKwWithRetry('product.product', 'search_read', [
    ['|', ['default_code', 'ilike', query], ['name', 'ilike', query]],
  ], { fields: ['id', 'name', 'default_code', 'lst_price'], limit: 20 });
  return results.map(p => ({
    id: p.id, name: p.name, sku: p.default_code ?? '', price: p.lst_price,
  }));
}

export async function getPricelists() {
  const results = await callKwWithRetry('product.pricelist', 'search_read', [[]], {
    fields: ['id', 'name'],
  });
  return results.map(p => ({ id: p.id, name: p.name }));
}

export async function findSalesTeamId(teamName) {
  if (!teamName) return null;
  const results = await callKwWithRetry('crm.team', 'search_read', [
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
    const existing = await callKwWithRetry('res.partner', 'search_read', [
      [['vat', '=', docNumber]],
    ], { fields: ['id'], limit: 1 });
    if (existing[0]) return existing[0].id;
  }
  const vals = { name };
  if (docNumber) vals.vat = docNumber;
  const [id] = await callKwWithRetry('res.partner', 'create', [[vals]]);
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
  const [id] = await callKwWithRetry('sale.order', 'create', [[vals]]);
  return id;
}

export async function confirmSaleOrder(orderId) {
  await callKwWithRetry('sale.order', 'action_confirm', [[orderId]]);
}

// Método estándar de Odoo 14+ para facturar un pedido confirmado. Si esta
// instancia usa una automatización propia para Tienda Nube (a confirmar
// durante la implementación — ver spec), puede hacer falta ajustar este
// método al que esa automatización realmente llama.
export async function createInvoiceForOrder(orderId) {
  try {
    const result = await callKwWithRetry('sale.order', '_create_invoices', [[orderId]]);
    return Array.isArray(result) ? (result[0] ?? null) : (result ?? null);
  } catch (err) {
    console.error('[feriaOdoo] Error creando factura:', err.message);
    return null;
  }
}

export { getDb } from './firestore.mjs';
