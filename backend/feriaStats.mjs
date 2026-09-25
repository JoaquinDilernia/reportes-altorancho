// Estadísticas de la feria, calculadas sobre los pedidos guardados. Puro:
// recibe los pedidos con `createdAtMs` y devuelve los agregados.
//
// Cuenta solo ventas confirmadas (las pendientes todavía pueden cambiar y
// las canceladas no son venta) y, dentro de cada una, las líneas no
// eliminadas. El envío se suma a la facturación total pero va aparte de los
// productos.
import { paymentsOf } from './feriaLines.mjs';

const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina: UTC-3, sin horario de verano.
const DAY_MS = 24 * 60 * 60 * 1000;
const SOLD = new Set(['confirmado', 'facturado']);
const IVA = 1.21;
const round2 = (n) => Math.round(n * 100) / 100;

function arHour(ms) {
  return new Date(ms - AR_OFFSET_MS).getUTCHours();
}

// Límites del rango en milisegundos, tomando el día argentino.
export function rangeBounds(range, now = Date.now()) {
  if (range === 'todo') return { from: 0, to: Infinity };
  const startToday = Math.floor((now - AR_OFFSET_MS) / DAY_MS) * DAY_MS + AR_OFFSET_MS;
  if (range === 'ayer') return { from: startToday - DAY_MS, to: startToday };
  return { from: startToday, to: startToday + DAY_MS };
}

function bump(map, key, fields) {
  const entry = map.get(key) ?? {};
  for (const [k, v] of Object.entries(fields)) entry[k] = (entry[k] ?? 0) + v;
  map.set(key, entry);
}

const byRevenue = (a, b) => b.revenue - a.revenue;

export function computeStats(orders, { from = 0, to = Infinity } = {}) {
  const sold = orders.filter((o) => SOLD.has(o.status) && o.createdAtMs >= from && o.createdAtMs < to);

  const totals = { orders: 0, units: 0, productsRevenue: 0, shippingRevenue: 0, listTotal: 0, cost: 0, netWithCost: 0, unitsWithoutCost: 0 };
  const sellers = new Map();
  const payments = new Map();
  const products = new Map();
  const byCondition = {};
  const byDelivery = {};
  const byHour = Array.from({ length: 24 }, () => ({ orders: 0, revenue: 0 }));

  for (const order of sold) {
    const lines = (order.lines ?? []).filter((l) => l.status !== 'eliminado');
    const units = lines.reduce((n, l) => n + l.qty, 0);
    const productsRevenue = lines.reduce((n, l) => n + l.qty * l.unitPrice, 0);
    const listTotal = lines.reduce((n, l) => n + l.qty * (l.listPrice ?? l.unitPrice), 0);
    const shipping = order.shippingCost || 0;
    const revenue = productsRevenue + shipping;

    totals.orders += 1;
    totals.units += units;
    totals.productsRevenue += productsRevenue;
    totals.shippingRevenue += shipping;
    totals.listTotal += listTotal;

    bump(sellers, order.sellerName ?? 'Sin vendedor', { orders: 1, units, revenue });
    // Pago dividido: la facturación se reparte por medio; el descuento es
    // del medio que fijó el precio (el que fue a Odoo).
    for (const { method, amount } of paymentsOf(order)) {
      bump(payments, method ?? 'sin_dato', {
        orders: 1, revenue: amount, discount: method === order.paymentMethod ? listTotal - productsRevenue : 0,
      });
    }
    const hour = byHour[arHour(order.createdAtMs)];
    hour.orders += 1;
    hour.revenue += revenue;

    for (const l of lines) {
      const lineRevenue = l.qty * l.unitPrice;
      // Margen sin IVA (el costo galpón es sin IVA), solo donde hay costo.
      const hasCost = typeof l.unitCost === 'number';
      const lineCost = hasCost ? l.qty * l.unitCost : 0;
      const lineNet = hasCost ? lineRevenue / IVA : 0;
      if (hasCost) {
        totals.cost += lineCost;
        totals.netWithCost += lineNet;
      } else {
        totals.unitsWithoutCost += l.qty;
      }
      bump(products, l.sku, { units: l.qty, revenue: lineRevenue, cost: lineCost, net: lineNet });
      products.get(l.sku).modelo = l.modelo;
      byCondition[l.condition] ??= { units: 0, revenue: 0 };
      byCondition[l.condition].units += l.qty;
      byCondition[l.condition].revenue += lineRevenue;
      const delivery = l.delivery ?? 'sin_dato';
      byDelivery[delivery] ??= { units: 0, revenue: 0 };
      byDelivery[delivery].units += l.qty;
      byDelivery[delivery].revenue += lineRevenue;
    }
  }

  const revenue = totals.productsRevenue + totals.shippingRevenue;
  return {
    totals: {
      orders: totals.orders,
      units: totals.units,
      productsRevenue: totals.productsRevenue,
      shippingRevenue: totals.shippingRevenue,
      revenue,
      discount: totals.listTotal - totals.productsRevenue,
      avgTicket: totals.orders ? Math.round(revenue / totals.orders) : 0,
      cost: round2(totals.cost),
      netRevenueWithCost: round2(totals.netWithCost),
      margin: totals.netWithCost ? round2(totals.netWithCost - totals.cost) : null,
      marginPct: totals.netWithCost ? Math.round(((totals.netWithCost - totals.cost) / totals.netWithCost) * 10000) / 10000 : null,
      unitsWithoutCost: totals.unitsWithoutCost,
    },
    bySeller: [...sellers].map(([name, v]) => ({ name, orders: v.orders, units: v.units, revenue: v.revenue })).sort(byRevenue),
    byPayment: [...payments].map(([method, v]) => ({ method, orders: v.orders, revenue: v.revenue, discount: v.discount })).sort(byRevenue),
    topProducts: [...products].map(([sku, v]) => ({
      sku, modelo: v.modelo, units: v.units, revenue: v.revenue,
      cost: round2(v.cost), margin: v.net ? round2(v.net - v.cost) : null,
    })).sort(byRevenue).slice(0, 15),
    byCondition,
    byDelivery,
    byHour,
  };
}
