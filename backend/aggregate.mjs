function completedOnly(salesDocs) {
  return salesDocs.filter(s => s.status === 'completed');
}

// Argentina is UTC-3, no DST: shift each UTC timestamp back 3 hours before
// slicing out the calendar date, so a sale after ~21:00 ART doesn't get
// bucketed into the next UTC calendar day.
function argDayBucket(isoDate) {
  return new Date(new Date(isoDate).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function computeTotals(salesDocs) {
  const completed = completedOnly(salesDocs);

  const revenue = completed.reduce((sum, s) => sum + s.total, 0);
  const units = completed.reduce((sum, s) => sum + s.items.reduce((u, i) => u + i.qty, 0), 0);
  const orders = completed.length;
  const avgTicket = orders ? revenue / orders : 0;

  const uniqueDays = new Set(completed.map(s => argDayBucket(s.date)));
  const daysInRange = uniqueDays.size;
  const avgDailyRevenue = daysInRange ? revenue / daysInRange : 0;

  return { revenue, units, orders, avgTicket, daysInRange, avgDailyRevenue };
}

export function computeDailyBreakdown(salesDocs) {
  const completed = completedOnly(salesDocs);
  const byDay = new Map();

  for (const sale of completed) {
    const day = argDayBucket(sale.date);
    if (!byDay.has(day)) byDay.set(day, { date: day, revenue: 0, units: 0, orders: 0 });
    const entry = byDay.get(day);
    entry.revenue += sale.total;
    entry.orders += 1;
    entry.units += sale.items.reduce((u, i) => u + i.qty, 0);
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function computeTopProducts(salesDocs, productsBySku, { by = 'units', limit = 10 } = {}) {
  const completed = completedOnly(salesDocs);
  const bySku = new Map();

  for (const sale of completed) {
    for (const item of sale.items) {
      if (!bySku.has(item.sku)) {
        bySku.set(item.sku, { sku: item.sku, name: item.name, unitsSold: 0, revenue: 0 });
      }
      const entry = bySku.get(item.sku);
      entry.unitsSold += item.qty;
      entry.revenue += item.qty * item.unitPrice;
    }
  }

  const ranked = [...bySku.values()]
    .map(entry => ({ ...entry, currentStock: productsBySku.get(entry.sku)?.currentStock ?? null }))
    .sort((a, b) => (by === 'revenue' ? b.revenue - a.revenue : b.unitsSold - a.unitsSold));

  return ranked.slice(0, limit);
}

export function computeCategoryBreakdown(salesDocs) {
  const completed = completedOnly(salesDocs);
  const byCategory = new Map();

  for (const sale of completed) {
    for (const item of sale.items) {
      // Some historical sale docs (synced before a fix to the product-category
      // lookup) stored the whole product object here instead of its category
      // string — recover the real category from it rather than crash on render.
      const rawCategory = typeof item.category === 'object' && item.category !== null
        ? item.category.category
        : item.category;
      const category = rawCategory || 'Sin categoría';
      if (!byCategory.has(category)) byCategory.set(category, { category, units: 0, revenue: 0 });
      const entry = byCategory.get(category);
      entry.units += item.qty;
      entry.revenue += item.qty * item.unitPrice;
    }
  }

  return [...byCategory.values()].sort((a, b) => b.revenue - a.revenue);
}

export function computePaymentMethods(salesDocs) {
  const completed = completedOnly(salesDocs);
  const byMethod = new Map();

  for (const sale of completed) {
    if (!sale.paymentMethod) continue;
    if (!byMethod.has(sale.paymentMethod)) byMethod.set(sale.paymentMethod, { method: sale.paymentMethod, revenue: 0 });
    byMethod.get(sale.paymentMethod).revenue += sale.total;
  }

  return [...byMethod.values()].sort((a, b) => b.revenue - a.revenue);
}

export function computeProvinces(salesDocs) {
  const completed = completedOnly(salesDocs);
  const byProvince = new Map();

  for (const sale of completed) {
    if (!sale.shippingProvince) continue;
    if (!byProvince.has(sale.shippingProvince)) byProvince.set(sale.shippingProvince, { province: sale.shippingProvince, orders: 0 });
    byProvince.get(sale.shippingProvince).orders += 1;
  }

  return [...byProvince.values()].sort((a, b) => b.orders - a.orders);
}

export function computeDelta(current, previous) {
  const value = current - previous;
  const pct = previous === 0 ? null : Math.round((value / previous) * 10000) / 100;
  return { value, pct };
}
