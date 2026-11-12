// Event sales by product origin (Fábrica / Proveedor Nacional / Importado),
// this year vs last year up to the same point, 2025 in today's pesos.
// Pure logic; origins come from productOrigin.mjs.
import { argDay } from './events.mjs';

export const ORIGINS = [
  { id: 'fabrica', label: 'Fábrica' },
  { id: 'nacional', label: 'Proveedor nacional' },
  { id: 'importado', label: 'Importado' },
  { id: 'otro', label: 'Otro / sin dato' },
];

export function originIdOf(clase) {
  const c = String(clase ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (c === 'FABRICA') return 'fabrica';
  if (c === 'PROVEEDOR NACIONAL') return 'nacional';
  if (c === 'IMPORTADO') return 'importado';
  return 'otro';
}

// Per origin: revenue, units, orders (an order counts once in every origin
// it has a product of) and average ticket = that origin's revenue ÷ its
// orders. Importados also come split by country.
export function summarizeOrigins({ prevToDateDocs, currentDocs, originBySku, factorByRefDate }) {
  const blank = () => ({ revenue: 0, units: 0, orders: new Set(), countries: new Map() });
  const acc = { cur: new Map(ORIGINS.map(o => [o.id, blank()])), prev: new Map(ORIGINS.map(o => [o.id, blank()])) };
  const walk = (docs, side, withFactor) => {
    for (const doc of docs) {
      if (doc.status !== 'completed') continue;
      const f = withFactor ? (factorByRefDate?.get(argDay(doc.date)) ?? 1) : 1;
      for (const item of doc.items || []) {
        if (!(item.unitPrice >= 0) || !item.qty) continue;
        const o = originBySku.get(item.sku);
        const id = originIdOf(o?.clase);
        const a = acc[side].get(id);
        const rev = item.qty * item.unitPrice * f;
        a.revenue += rev;
        a.units += item.qty;
        a.orders.add(doc.id);
        if (id === 'importado') {
          const country = o?.pais || 'Sin país';
          a.countries.set(country, (a.countries.get(country) || 0) + rev);
        }
      }
    }
  };
  walk(currentDocs, 'cur', false);
  walk(prevToDateDocs, 'prev', true);

  const totals = (side) => [...acc[side].values()].reduce((s, a) => s + a.revenue, 0);
  const curTotal = totals('cur');
  const prevTotal = totals('prev');
  const shape = (a, total) => ({
    revenue: a.revenue,
    units: a.units,
    orders: a.orders.size,
    avgTicket: a.orders.size ? a.revenue / a.orders.size : null,
    share: total ? a.revenue / total : null,
  });
  return ORIGINS.map(({ id, label }) => {
    const c = acc.cur.get(id);
    const p = acc.prev.get(id);
    return {
      id, label,
      cur: shape(c, curTotal),
      prev: shape(p, prevTotal),
      countries: id === 'importado'
        ? [...c.countries.entries()].map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue)
        : undefined,
    };
  }).filter(o => o.cur.revenue || o.prev.revenue);
}
