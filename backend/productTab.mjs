// Producto tab (new report): pure helpers over sales docs and product docs.
// Stock is "as of today" (stockByLoc from Odoo + Tiendanube's web stock).
import { STOCK_LOCATIONS, LOC_GROUPS, isJunkSku } from './stockLocations.mjs';
import { eventCategoryOf, skuModel } from './eventCategories.mjs';

export const CHANNEL_FILTERS = {
  all: null,
  web: ['ecommerce'],
  locales: ['local_lomas', 'local_belgrano', 'local_alcorta'],
  mayorista: ['mayorista', 'feria'],
};

export function filterDocs(docs, ch) {
  const channels = CHANNEL_FILTERS[ch];
  return channels ? docs.filter(d => channels.includes(d.channel)) : docs;
}

const LEGACY_KEYS = { deposito: 'rolon', mayorista: 'mayorista', local_lomas: 'lomas_stock', local_belgrano: 'belgrano_stock', local_alcorta: 'alcorta_stock', ecommerce_odoo: 'web_odoo' };
function locsOf(p) {
  if (p?.stockByLoc) return p.stockByLoc;
  const out = {};
  for (const [old, key] of Object.entries(LEGACY_KEYS)) if (p?.stockByLocation?.[old] != null) out[key] = p.stockByLocation[old];
  return out;
}
const pos = (n) => Math.max(0, Number(n) || 0);

// The web stock is both Tiendanube's number and Odoo's EC warehouse (the same
// boxes): take the larger so it isn't counted twice nor lost.
export function stockOf(p) {
  const locs = locsOf(p);
  const web = Math.max(pos(p?.currentStock), pos(locs.web_odoo));
  let other = 0;
  for (const [k, n] of Object.entries(locs)) if (k !== 'web_odoo') other += pos(n);
  return { web, other, total: web + other };
}

// Stock per model (SKU without color): total, web and per location.
export function modelStock(productsBySku) {
  const out = new Map();
  for (const p of productsBySku.values()) {
    if (!p?.sku || isJunkSku(p.sku, p.name)) continue;
    const key = skuModel(p.sku);
    const m = out.get(key) ?? { total: 0, web: 0, byLoc: {} };
    const s = stockOf(p);
    m.total += s.total;
    m.web += s.web;
    for (const [k, n] of Object.entries(locsOf(p))) if (k !== 'web_odoo' && pos(n)) m.byLoc[k] = (m.byLoc[k] || 0) + pos(n);
    out.set(key, m);
  }
  return out;
}

// Stock per event category, only sellable ("Biblia") products.
export function categoryStock(productsBySku) {
  const out = new Map();
  for (const p of productsBySku.values()) {
    if (!p?.odooCategPath?.includes('Biblia') || /GIFTCARD/i.test(p.odooCategPath) || isJunkSku(p.sku, p.name)) continue;
    const id = eventCategoryOf(p);
    out.set(id, (out.get(id) || 0) + stockOf(p).total);
  }
  return out;
}

// Lots of stock, slow or no sales over the last 8 weeks (all channels):
// candidates to push with ads or price.
export function overstock({ salesDocs8w, productsBySku, minDays = 180, minStock = 10, limit = 30, windowDays = 56 }) {
  const units = new Map();
  for (const d of salesDocs8w) {
    if (d.status !== 'completed') continue;
    for (const it of d.items || []) {
      if (!(it.unitPrice >= 0) || !it.qty) continue;
      units.set(it.sku, (units.get(it.sku) || 0) + it.qty);
    }
  }
  const rows = [];
  for (const p of productsBySku.values()) {
    if (!p?.sku || isJunkSku(p.sku, p.name)) continue;
    const stockTotal = stockOf(p).total;
    if (stockTotal < minStock) continue;
    const sold = units.get(p.sku) || 0;
    const coverageDays = sold ? Math.round(stockTotal / (sold / windowDays)) : null;
    if (coverageDays != null && coverageDays <= minDays) continue;
    rows.push({ sku: p.sku, name: p.name, stockTotal, weeklyUnits: Math.round((sold / windowDays) * 7 * 10) / 10, coverageDays });
  }
  return rows.sort((a, b) => b.stockTotal - a.stockTotal).slice(0, limit);
}

const LOC_LABELS = {
  rolon: 'Rolón (reserva central)', mayorista: 'Mayorista (en Rolón)', alcorta_en_rolon: 'Alcorta en Rolón',
  web_odoo: 'Web (EC en Rolón)',
  lomas_stock: 'Lomas · depósito', lomas_exhibicion: 'Lomas · exhibición',
  belgrano_stock: 'Belgrano · depósito', belgrano_exhibicion: 'Belgrano · exhibición',
  alcorta_stock: 'Alcorta · depósito', alcorta_exhibicion: 'Alcorta · exhibición',
};
const LOCAL_KEYS = new Set([...LOC_GROUPS.localStock, ...LOC_GROUPS.localExhibition]);

// "Where is everything": units and products per physical location.
export function warehouses(productsBySku) {
  const acc = new Map(Object.values(STOCK_LOCATIONS).map(k => [k, { units: 0, products: 0 }]));
  for (const p of productsBySku.values()) {
    if (!p?.sku || isJunkSku(p.sku, p.name)) continue;
    for (const [k, n] of Object.entries(locsOf(p))) {
      const a = acc.get(k);
      if (!a || !(n > 0)) continue;
      a.units += n;
      a.products += 1;
    }
  }
  return [...acc.entries()].map(([key, a]) => ({
    key, label: LOC_LABELS[key] ?? key, group: LOCAL_KEYS.has(key) ? 'locales' : 'rolon', ...a,
  }));
}
