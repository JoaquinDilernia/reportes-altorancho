// Physical stock locations in Odoo (stock.location ids, verified live
// 2026-11-12) and the clear keys the new report uses for them. Rolón is the
// central depot: the web (EC) and mayorista stock sit there too. Each store
// has a mini depot (Stock) and what's on the floor (Exhibición).
import { extractSkuFromDisplayName, stripSkuFromDisplayName } from './normalize.mjs';

export const STOCK_LOCATIONS = {
  150: 'web_odoo',            // EC/Stock (Rolón) — the web's own warehouse in Odoo
  168: 'mayorista',           // MAY/Stock (Rolón)
  174: 'rolon',               // RL/Stock — central reserve
  407: 'alcorta_en_rolon',    // AL/RL/Stock — Alcorta's reserve kept in Rolón
  8: 'lomas_stock',           // LL/Stock
  324: 'lomas_exhibicion',    // LL/Exhibicion
  372: 'belgrano_stock',      // BL/Stock
  379: 'belgrano_exhibicion', // BL/Exhibicion
  397: 'alcorta_stock',       // AL/Stock
  415: 'alcorta_exhibicion',  // AL/Exhibición
};

export const LOC_GROUPS = {
  // Can go to the web with a move inside Rolón (web_odoo is the web itself).
  rolon: ['rolon', 'mayorista', 'alcorta_en_rolon'],
  localStock: ['lomas_stock', 'belgrano_stock', 'alcorta_stock'],
  localExhibition: ['lomas_exhibicion', 'belgrano_exhibicion', 'alcorta_exhibicion'],
};

// Gift cards (100M fake units) and shipping "products" are never stock.
export function isJunkSku(sku, name) {
  return /^GFT/i.test(sku ?? '') || /env[ií]o/i.test(sku ?? '') || /env[ií]o/i.test(name ?? '');
}

// stock.quant rows → SKU → { key: units }. Only the locations above, only
// positive quantities (Odoo has negatives from unadjusted moves).
export function stockByLocFromQuants(quants) {
  const bySku = new Map();
  for (const q of quants) {
    const key = STOCK_LOCATIONS[q.location_id?.[0]];
    if (!key || !(q.quantity > 0)) continue;
    const display = q.product_id?.[1] ?? '';
    const sku = extractSkuFromDisplayName(display);
    if (isJunkSku(sku, stripSkuFromDisplayName(display))) continue;
    const entry = bySku.get(sku) ?? {};
    entry[key] = (entry[key] || 0) + q.quantity;
    bySku.set(sku, entry);
  }
  return bySku;
}
