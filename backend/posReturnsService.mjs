// Compras para devolver: une la app (Firestore) con Odoo (TPV y Tiendanube).
// Las líneas que vuelven se arman SOLO con lo que devuelve este módulo.
import * as rOdoo from './posReturnsOdoo.mjs';
import { searchAppPurchases, getOrder } from './posOrders.mjs';
import { getSettings } from './posConfig.mjs';
import { getCatalogProducts } from './posCatalog.mjs';
import { appUnitValue } from './posReturns.mjs';

export function classifyQuery(q) {
  const text = String(q ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (/^[\d.\-\s]+$/.test(text) && [7, 8, 11].includes(digits.length)) return { doc: digits };
  if (text.length >= 3) return { ref: text };
  throw new Error('Escribí el DNI/CUIT o el número de la compra');
}

const appSummary = (o) => ({
  source: 'app', purchaseId: o.id, label: o.number, date: (o.confirmedAt?.toDate?.() ?? new Date(o.confirmedAt)).toISOString(),
  partnerName: o.customer?.name ?? null, total: o.totals?.total ?? 0, invoiceName: o.invoiceName ?? null,
});

const defaultDeps = () => ({
  searchApp: async ({ doc, ref }) => {
    if (ref && !/^[A-Z]{2,4}-\d{4,}$/i.test(ref)) return [];
    return (await searchAppPurchases({ doc, number: ref?.toUpperCase() ?? null })).map(appSummary);
  },
  searchTpv: (q) => rOdoo.searchTpvPurchases(q),
  searchWeb: (q) => rOdoo.searchWebPurchases(q),
  getPurchase: (source, id) => getPurchase(source, id),
  manualLine: (productId) => manualLine(productId),
});

export async function searchPurchases(q, { sinceISO }, deps = defaultDeps()) {
  const query = { ...classifyQuery(q), sinceISO };
  const sources = [['Local', deps.searchApp], ['TPV', deps.searchTpv], ['Web', deps.searchWeb]];
  const results = await Promise.allSettled(sources.map(([, fn]) => fn(query)));
  const purchases = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') purchases.push(...r.value);
    else errors.push(`${sources[i][0]}: ${r.reason.message}`);
  });
  purchases.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { purchases, errors };
}

export async function getPurchase(source, id, deps = { readSale: rOdoo.readSaleOrderPurchase }) {
  if (source === 'tpv') return rOdoo.readTpvPurchase(id);
  if (source === 'web') {
    if (!/^[0-9]+$/.test(String(id))) throw new Error('Pedido web inválido');
    const web = await deps.readSale({
      source: 'web', purchaseId: String(id), label: null, saleOrderIds: [Number(id)],
      unitValueFor: (sl) => (sl.product_uom_qty > 0 ? Math.round((sl.price_total / sl.product_uom_qty) * 100) / 100 : 0),
    });
    if (!String(web.label ?? '').startsWith('TN')) throw new Error('Ese pedido no es de la tienda web');
    return { ...web, lines: web.lines.map((l) => ({ ...l, purchaseLabel: l.purchaseLabel ?? web.label })) };
  }
  if (source === 'app') {
    const order = await getOrder(id);
    if (order.status !== 'confirmado') throw new Error('Esa venta no está confirmada');
    const byOdooLine = new Map(order.lines.filter((l) => l.odooLineId).map((l) => [l.odooLineId, l]));
    const purchase = await rOdoo.readSaleOrderPurchase({
      source: 'app', purchaseId: order.id, label: order.number, saleOrderIds: order.odooOrders.map((o) => o.odooOrderId),
      unitValueFor: (sl) => appUnitValue(byOdooLine.get(sl.id) ?? { basePrice: 0 }, order.totals?.lineDiscountPct),
    });
    // La app conoce el cliente y el número aunque Odoo tenga otro contacto de entrega.
    return { ...purchase, partnerVat: order.customer?.docNumber ?? purchase.partnerVat, partnerName: order.customer?.name ?? purchase.partnerName };
  }
  throw new Error('Origen de compra inválido');
}

export async function manualLine(productId) {
  const settings = await getSettings();
  const product = (await getCatalogProducts([Number(productId)], settings)).get(Number(productId));
  if (!product) throw new Error('Producto no encontrado en Odoo');
  return {
    source: 'manual', purchaseId: null, purchaseLabel: null, purchaseLineId: null, productId: product.productId, sku: product.sku,
    name: product.name, qtyBought: 0, qtyReturnedBefore: 0, unitValue: product.basePrice, lots: [], moveIds: [],
    invoiceId: null, invoiceName: null, partnerVat: null, partnerName: null,
  };
}

export async function resolvePurchaseLine({ source, purchaseId, purchaseLineId, productId }, deps = defaultDeps()) {
  if (source === 'manual') return deps.manualLine(productId);
  const purchase = await deps.getPurchase(source, purchaseId);
  const line = purchase.lines.find((l) => String(l.purchaseLineId) === String(purchaseLineId));
  if (!line) throw new Error('Esa línea no está en la compra (o ya no se puede devolver)');
  return line;
}
