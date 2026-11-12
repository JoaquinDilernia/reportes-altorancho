// "Pasar a la web": products that were selling on the web and have less than
// a week of web stock left, with where else there's stock. The web stock is
// Tiendanube's (`currentStock`, what the site can actually sell); the rest
// comes from Odoo's per-location stock (`stockByLocation`). Stock is "as of
// today"; the sales window counts back from today.

// Locations physically in Rolón (a move inside the same building) vs. stores.
export const ROLON_KEYS = ['deposito', 'mayorista', 'alcorta_en_rolon'];
export const LOCAL_KEYS = ['local_lomas', 'local_belgrano', 'local_alcorta'];

import { isJunkSku } from './stockLocations.mjs';

export { isJunkSku };

const GROUP_ORDER = { rolon: 0, local: 1, none: 2 };

export function webCoverage({ webSalesDocs, productsBySku, windowDays = 28, maxCoverageDays = 7 }) {
  const sold = new Map();
  for (const doc of webSalesDocs) {
    if (doc.status !== 'completed') continue;
    for (const item of doc.items || []) {
      if (!(item.unitPrice >= 0) || !item.qty) continue;
      const s = sold.get(item.sku) ?? { units: 0, revenue: 0 };
      s.units += item.qty;
      s.revenue += item.qty * item.unitPrice;
      sold.set(item.sku, s);
    }
  }
  const rows = [];
  for (const [sku, s] of sold) {
    const p = productsBySku.get(sku);
    if (!p || isJunkSku(sku, p.name) || p.currentStock == null || s.units <= 0) continue;
    const webStock = Math.max(0, p.currentStock);
    const coverageDays = Math.round((webStock / (s.units / windowDays)) * 10) / 10;
    if (coverageDays >= maxCoverageDays) continue;
    const where = {};
    for (const k of [...ROLON_KEYS, ...LOCAL_KEYS]) {
      const n = p.stockByLocation?.[k];
      if (n > 0) where[k] = n;
    }
    const group = ROLON_KEYS.some(k => where[k]) ? 'rolon' : LOCAL_KEYS.some(k => where[k]) ? 'local' : 'none';
    rows.push({
      sku, name: p.name, weeklyUnits: Math.round((s.units / windowDays) * 7 * 10) / 10,
      dailyRevenue: s.revenue / windowDays, webStock, coverageDays, where, group,
    });
  }
  return rows.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || b.dailyRevenue - a.dailyRevenue);
}
