// Product search (top bar) and the product sheet it opens: stock by
// location, origin and sales by channel and day for the chosen period.
import { isJunkSku } from './stockCoverage.mjs';
import { RESUMEN_CHANNELS } from './resumen.mjs';
import { argDay } from './events.mjs';

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// SKU prefix or every word in the name, accents and case ignored. SKU hits first.
export function searchProducts(productsBySku, q, limit = 10) {
  const query = fold(q).trim();
  if (!query) return [];
  const words = query.split(/\s+/);
  const bySku = [];
  const byName = [];
  for (const p of productsBySku.values()) {
    if (!p?.sku || isJunkSku(p.sku, p.name)) continue;
    if (fold(p.sku).startsWith(query)) bySku.push(p);
    else if (words.every(w => fold(p.name).includes(w))) byName.push(p);
  }
  const byNameAsc = (a, b) => String(a.name).localeCompare(String(b.name), 'es');
  return [...bySku.sort(byNameAsc), ...byName.sort(byNameAsc)]
    .slice(0, limit)
    .map(p => ({ sku: p.sku, name: p.name, category: p.category ?? null }));
}

const GROUP_OF = new Map(RESUMEN_CHANNELS.flatMap(g => g.channels.map(ch => [ch, g.id])));

export function productSheet({ sku, productsBySku, salesDocs, originBySku }) {
  const p = productsBySku.get(sku);
  if (!p) return null;
  const byChannel = new Map(RESUMEN_CHANNELS.map(g => [g.id, { id: g.id, units: 0, revenue: 0 }]));
  const byDay = new Map();
  for (const doc of salesDocs) {
    if (doc.status !== 'completed') continue;
    const g = GROUP_OF.get(doc.channel);
    if (!g) continue;
    for (const item of doc.items || []) {
      if (item.sku !== sku || !(item.unitPrice >= 0)) continue;
      const revenue = item.qty * item.unitPrice;
      const c = byChannel.get(g);
      c.units += item.qty;
      c.revenue += revenue;
      const date = argDay(doc.date);
      const d = byDay.get(date) ?? { date, units: 0, revenue: 0 };
      d.units += item.qty;
      d.revenue += revenue;
      byDay.set(date, d);
    }
  }
  return {
    sku,
    name: p.name,
    category: p.category ?? null,
    origin: originBySku?.get(sku) ?? null,
    webStock: p.currentStock ?? null,
    stockByLocation: p.stockByLocation ?? null,
    stockByLoc: p.stockByLoc ?? null,
    byChannel: [...byChannel.values()],
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
