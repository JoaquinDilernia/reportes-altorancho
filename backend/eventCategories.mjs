// Event categories — groups products into the ~16 buckets the Cyber/Black
// report compares year over year, off the Odoo "Biblia" category path.
// Pure logic; the Firestore side lives in eventReport.mjs.
import { argDay } from './events.mjs';

export const EVENT_CATEGORIES = [
  { id: 'sillas', label: 'Sillas' },
  { id: 'iluminacion_inalambrica', label: 'Iluminación inalámbrica' },
  { id: 'iluminacion', label: 'Iluminación' },
  { id: 'escritorios', label: 'Escritorios' },
  { id: 'comodas', label: 'Cómodas' },
  { id: 'mesas_comedor', label: 'Mesas de comedor' },
  { id: 'mesas_ratonas', label: 'Mesas ratonas' },
  { id: 'mesas_luz', label: 'Mesas de luz' },
  { id: 'mesas_arrime', label: 'Mesas de arrime' },
  { id: 'consolas', label: 'Consolas' },
  { id: 'bancos', label: 'Bancos y banquetas' },
  { id: 'otros_muebles', label: 'Otros muebles' },
  { id: 'textil', label: 'Textil' },
  { id: 'deco', label: 'Deco' },
  { id: 'bazar', label: 'Bazar' },
  { id: 'otros', label: 'Otros' },
];

// MUEBLES sub-category (third level of the Biblia path) -> category id.
// Anything not listed falls into otros_muebles.
const MUEBLES_LEVEL3 = {
  'ESCRITORIO': 'escritorios',
  'COMODA': 'comodas',
  'MESA COMEDOR': 'mesas_comedor',
  'MESA DE COMEDOR': 'mesas_comedor',
  'MESA RATONA': 'mesas_ratonas',
  'MESA DE LUZ': 'mesas_luz',
  'MESA DE ARRIME': 'mesas_arrime',
  'CONSOLA': 'consolas',
  'BANCO': 'bancos',
  'BANQUETA': 'bancos',
};

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();

// Wireless lamps live under the same Odoo category as the plug-in ones, so
// the product name is the only thing that tells them apart.
export function eventCategoryOf(product, itemName) {
  const name = product?.name ?? itemName ?? '';
  if (/INAL[AÁ]MBRIC/i.test(name) || /INAL[AÁ]MBRIC/i.test(itemName ?? '')) return 'iluminacion_inalambrica';
  if (!product?.odooCategPath) return 'otros';
  const [l1, l2, l3] = product.odooCategPath.split('/').map(norm).filter(p => p && p !== 'ALL' && p !== 'BIBLIA');
  if (l1 === 'MUEBLES' && l2 === 'SILLAS') return 'sillas';
  if (l1 === 'ILUMINACION') return 'iluminacion';
  if (l1 === 'MUEBLES') return MUEBLES_LEVEL3[l3] ?? 'otros_muebles';
  if (l1 === 'TEXTIL' || l1 === 'DECO' || l1 === 'BAZAR') return l1.toLowerCase();
  return 'otros';
}

// Per category: last year's units/revenue (full window and up to the same
// point as today), this year's, and the stock left to sell. 2025 revenue is
// brought to today's pesos with the factor of each doc's day.
export function summarizeCategories({ prevDocs, prevToDateDocs, currentDocs, productsBySku, factorByRefDate }) {
  const blank = () => ({
    prevUnits: 0, prevRevenueAdj: 0, prevUnitsToDate: 0, prevRevenueToDateAdj: 0,
    units: 0, revenue: 0, stock: 0, products: new Map(),
  });
  const byId = new Map(EVENT_CATEGORIES.map(c => [c.id, blank()]));
  const walk = (docs, fn) => walkItems(docs, productsBySku, factorByRefDate, (item, rev, f, id) => fn(byId.get(id), item, rev, f));
  // Last year's units/revenue per product up to the same point, so each top
  // product can say how much more (or less) it is selling.
  const prevBySku = new Map();
  walk(prevDocs, (c, item, rev, f) => { c.prevUnits += item.qty; c.prevRevenueAdj += rev * f; });
  walk(prevToDateDocs, (c, item, rev, f) => {
    c.prevUnitsToDate += item.qty;
    c.prevRevenueToDateAdj += rev * f;
    const p = prevBySku.get(item.sku) ?? { units: 0, revenueAdj: 0 };
    p.units += item.qty;
    p.revenueAdj += rev * f;
    prevBySku.set(item.sku, p);
  });
  walk(currentDocs, (c, item, rev) => {
    c.units += item.qty;
    c.revenue += rev;
    const p = c.products.get(item.sku) ?? { sku: item.sku, name: productsBySku.get(item.sku)?.name ?? item.name, units: 0, revenue: 0 };
    p.units += item.qty;
    p.revenue += rev;
    c.products.set(item.sku, p);
  });
  const withPrev = (p) => ({
    ...p,
    prevUnitsToDate: prevBySku.get(p.sku)?.units ?? 0,
    prevRevenueToDateAdj: prevBySku.get(p.sku)?.revenueAdj ?? 0,
  });

  // Stock counts every location (incl. mayorista and depósito) of every
  // product in the category, sold or not.
  // Only sellable ("Biblia") products: factory/supplies have no sales.
  for (const product of productsBySku.values()) {
    if (!product.odooCategPath?.includes('Biblia')) continue;
    // Gift cards carry a virtual ~100M stock in Odoo.
    if (/GIFTCARD/i.test(product.odooCategPath)) continue;
    const c = byId.get(eventCategoryOf(product));
    for (const n of Object.values(product.stockByLocation || {})) c.stock += Math.max(0, n || 0);
  }

  return EVENT_CATEGORIES
    .map(({ id, label }) => {
      const { products, ...c } = byId.get(id);
      return {
        id, label, ...c,
        cantMatch: c.units + c.stock < c.prevUnits,
        topProducts: [...products.values()].sort((a, b) => b.units - a.units).slice(0, 5).map(withPrev),
      };
    })
    .filter(c => c.prevUnits || c.units);
}

// Calls fn(item, revenue, factor, categoryId) for every product line of the
// completed docs. Negative-price lines are discounts, not products.
function walkItems(docs, productsBySku, factorByRefDate, fn) {
  for (const doc of docs) {
    if (doc.status !== 'completed') continue;
    const factor = factorByRefDate?.get(argDay(doc.date)) ?? 1;
    for (const item of doc.items || []) {
      if (!(item.unitPrice >= 0)) continue;
      fn(item, item.qty * item.unitPrice, factor, eventCategoryOf(productsBySku.get(item.sku), item.name));
    }
  }
}

// The event's best-selling products (by revenue) against the same products
// over last year's aligned days up to the same point, 2025 in today's pesos.
export function compareTopProducts({ prevToDateDocs, currentDocs, productsBySku, factorByRefDate, limit = 15 }) {
  const label = new Map(EVENT_CATEGORIES.map(c => [c.id, c.label]));
  const bySku = new Map();
  const row = (item, catId) => {
    let p = bySku.get(item.sku);
    if (!p) {
      p = {
        sku: item.sku,
        name: productsBySku.get(item.sku)?.name ?? item.name,
        category: label.get(catId),
        units: 0, revenue: 0, prevUnitsToDate: 0, prevRevenueToDateAdj: 0,
      };
      bySku.set(item.sku, p);
    }
    return p;
  };
  walkItems(currentDocs, productsBySku, null, (item, rev, _f, catId) => {
    const p = row(item, catId);
    p.units += item.qty;
    p.revenue += rev;
  });
  walkItems(prevToDateDocs, productsBySku, factorByRefDate, (item, rev, f) => {
    const p = bySku.get(item.sku);
    if (!p) return; // only products selling this year make the list
    p.prevUnitsToDate += item.qty;
    p.prevRevenueToDateAdj += rev * f;
  });
  return [...bySku.values()]
    .filter(p => p.units > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}
