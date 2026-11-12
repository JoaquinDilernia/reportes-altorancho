// "Pasar a la web": products that were selling on the web and have less than
// a week of web stock left, with where else there's stock. The web stock is
// Tiendanube's (`currentStock`, what the site can actually sell); the rest
// comes from Odoo's per-location stock (`stockByLoc`, see stockLocations.mjs).
// Stock is "as of today"; the sales window counts back from today.
import { isJunkSku, LOC_GROUPS } from './stockLocations.mjs';

export { isJunkSku };

const OTHER_KEYS = [...LOC_GROUPS.rolon, ...LOC_GROUPS.localStock, ...LOC_GROUPS.localExhibition];
const GROUP_ORDER = { rolon: 0, local: 1, none: 2 };

// Before the first sync with stockByLoc, products only carry the old keys.
const LEGACY_KEYS = { deposito: 'rolon', mayorista: 'mayorista', local_lomas: 'lomas_stock', local_belgrano: 'belgrano_stock', local_alcorta: 'alcorta_stock' };
function locationsOf(p) {
  if (p.stockByLoc) return p.stockByLoc;
  const out = {};
  for (const [old, key] of Object.entries(LEGACY_KEYS)) if (p.stockByLocation?.[old] != null) out[key] = p.stockByLocation[old];
  return out;
}

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
    const locs = locationsOf(p);
    const where = {};
    for (const k of OTHER_KEYS) if (locs[k] > 0) where[k] = locs[k];
    const has = (keys) => keys.some(k => where[k]);
    const group = has(LOC_GROUPS.rolon) ? 'rolon'
      : has(LOC_GROUPS.localStock) || has(LOC_GROUPS.localExhibition) ? 'local' : 'none';
    const dailyRevenue = s.revenue / windowDays;
    rows.push({
      sku, name: p.name, weeklyUnits: Math.round((s.units / windowDays) * 7 * 10) / 10,
      dailyRevenue, lostPerDay: dailyRevenue, webStock, coverageDays, where, group,
      onlyExhibition: group === 'local' && !has(LOC_GROUPS.localStock),
    });
  }
  return rows.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || b.dailyRevenue - a.dailyRevenue);
}
