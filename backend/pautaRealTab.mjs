// Pauta real: cuánta plata deja de verdad la pauta. Funciones puras.
//
// - Ventas y productos: docs de ventas de Firestore (web = ecommerce, locales).
// - Costo: Odoo por SKU (con IVA, como los precios). Si un ítem no tiene costo
//   cargado se estima con el margen promedio de los ítems que sí lo tienen, y
//   se informa qué parte de las ventas quedó estimada.
// - Atribución por pedido (qué campaña lo trajo): gineza. Opcional.
// - Inversión y lo que "dice" cada plataforma: docs diarios de Meta y Google.
import { argDay } from './events.mjs';

export const LOCAL_CHANNELS = ['local_lomas', 'local_belgrano', 'local_alcorta'];
const PAID_CHANNELS = ['meta', 'google'];

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const ratio = (a, b) => (b > 0 ? a / b : null);
const pctDelta = (cur, prev) => (prev ? round(((cur - prev) / prev) * 100, 1) : null);
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

// Margen de un conjunto de docs. COGS conocido por SKU; el resto se estima.
export function marginOf(docs, costBySku) {
  let knownRev = 0;
  let knownCost = 0;
  let unknownRev = 0;
  for (const d of docs) {
    for (const it of d.items || []) {
      const line = (it.qty || 0) * (it.unitPrice || 0);
      // Líneas negativas (devoluciones, descuentos del POS) no cuentan para el margen promedio.
      if (!(line > 0)) continue;
      const cost = costBySku.get(it.sku);
      if (cost != null) {
        knownRev += line;
        knownCost += (it.qty || 0) * cost;
      } else unknownRev += line;
    }
  }
  const costRatio = knownRev > 0 ? knownCost / knownRev : null;
  return { knownRev, knownCost, unknownRev, costRatio, costCoverage: ratio(knownRev, knownRev + unknownRev) };
}

// Ganancia bruta de un pedido: total cobrado − costo de la mercadería. El
// total ya trae descuentos (y el envío que paga el cliente).
export function orderGrossProfit(doc, costBySku, fallbackCostRatio) {
  let cogs = 0;
  for (const it of doc.items || []) {
    const line = (it.qty || 0) * (it.unitPrice || 0);
    const cost = costBySku.get(it.sku);
    if (cost != null) cogs += (it.qty || 0) * cost;
    else if (fallbackCostRatio != null) cogs += line * fallbackCostRatio;
  }
  return (doc.total || 0) - cogs;
}

function block(docs, costBySku, fallback) {
  const revenue = sum(docs, (d) => d.total);
  const gross = sum(docs, (d) => orderGrossProfit(d, costBySku, fallback));
  return { revenue, orders: docs.length, grossProfit: gross, marginPct: revenue ? round((gross / revenue) * 100, 1) : null };
}

const completed = (docs) => docs.filter((d) => d.status === 'completed');

// Gasto y valor reportado por plataforma, desde los docs diarios.
export function platformSpend(metaDaily, googleDaily) {
  return {
    meta: { spend: sum(metaDaily, (d) => d.spend), reportedValue: sum(metaDaily, (d) => d.purchaseValue), reportedPurchases: sum(metaDaily, (d) => d.purchases) },
    google: { spend: sum(googleDaily, (d) => d.spend), reportedValue: sum(googleDaily, (d) => d.purchaseValue), reportedPurchases: sum(googleDaily, (d) => d.purchases) },
  };
}

// Totales del negocio: lo que la pauta le cuesta al negocio entero.
export function headline({ webDocs, localDocs, spend, costBySku }) {
  const web = completed(webDocs);
  const loc = completed(localDocs);
  const all = [...web, ...loc];
  const m = marginOf(all, costBySku);
  const fallback = m.costRatio;
  const w = block(web, costBySku, fallback);
  const l = block(loc, costBySku, fallback);
  const revenue = w.revenue + l.revenue;
  const grossProfit = w.grossProfit + l.grossProfit;
  return {
    spend,
    web: w,
    locales: l,
    revenue,
    grossProfit,
    marginPct: revenue ? round((grossProfit / revenue) * 100, 1) : null,
    profitAfterAds: grossProfit - spend,
    merWeb: round(ratio(w.revenue, spend)),
    merTotal: round(ratio(revenue, spend)),
    adsShareOfRevenuePct: revenue ? round((spend / revenue) * 100, 1) : null,
    costCoverage: round(m.costCoverage, 3),
    fallbackCostRatio: round(fallback, 3),
  };
}

export function withDeltas(cur, prev) {
  if (!prev) return { ...cur, vsPrev: null };
  return {
    ...cur,
    vsPrev: {
      spend: pctDelta(cur.spend, prev.spend),
      revenue: pctDelta(cur.revenue, prev.revenue),
      grossProfit: pctDelta(cur.grossProfit, prev.grossProfit),
      // contra el valor absoluto: pasar de perder 100 a ganar 50 es +150 %, no −150 %
      profitAfterAds: prev.profitAfterAds
        ? round(((cur.profitAfterAds - prev.profitAfterAds) / Math.abs(prev.profitAfterAds)) * 100, 1) : null,
      merTotal: pctDelta(cur.merTotal, prev.merTotal),
    },
  };
}

// Qué le pasa a una campaña / plataforma: entendible sin saber de ROAS.
export function verdict({ spend, grossProfit, sales }) {
  if (!(spend > 0)) return null;
  if (!sales) return 'sin-ventas';
  const poas = grossProfit / spend;
  if (poas >= 1.3) return 'gana';
  if (poas >= 1) return 'justo';
  return 'pierde';
}

function paidBlock({ spend, reportedValue, orders }) {
  const revenue = sum(orders, (o) => o.total);
  const grossProfit = sum(orders, (o) => o.grossProfit);
  return {
    spend,
    reported: { revenue: reportedValue, roas: round(ratio(reportedValue, spend)) },
    real: { revenue, orders: orders.length, roas: round(ratio(revenue, spend)) },
    grossProfit,
    poas: round(ratio(grossProfit, spend)),
    profitAfterAds: grossProfit - spend,
    costPerSale: orders.length ? round(spend / orders.length, 0) : null,
    // Cuánto "se agranda" la plataforma frente a las ventas que efectivamente llegaron con su clic.
    overReportPct: revenue > 0 ? round(((reportedValue - revenue) / revenue) * 100, 0) : null,
    verdict: verdict({ spend, grossProfit, sales: orders.length }),
  };
}

// Pedidos web cruzados con su atribución, con la ganancia de cada uno.
export function attributedOrders(webDocs, attribution, costBySku, fallback) {
  const out = [];
  for (const d of completed(webDocs)) {
    const a = attribution.get(String(d.sourceId));
    if (!a || !PAID_CHANNELS.includes(a.channel)) continue;
    out.push({ ...a, id: d.sourceId, date: argDay(d.date), total: d.total || 0, grossProfit: orderGrossProfit(d, costBySku, fallback) });
  }
  return out;
}

export function platforms({ spendBy, orders }) {
  return Object.fromEntries(PAID_CHANNELS.map((ch) => [ch, paidBlock({
    spend: spendBy[ch].spend, reportedValue: spendBy[ch].reportedValue, orders: orders.filter((o) => o.channel === ch),
  })]));
}

// Ventas web por origen: pago (Meta/Google) vs. el resto, con su ganancia.
export function webSources({ webDocs, orders, summaryChannels }) {
  const web = completed(webDocs);
  const webRev = sum(web, (d) => d.total);
  const paid = Object.fromEntries(PAID_CHANNELS.map((ch) => [ch, sum(orders.filter((o) => o.channel === ch), (o) => o.total)]));
  const rows = [];
  if (summaryChannels?.length) {
    // gineza conoce el canal de todos los pedidos (orgánico, email, redes, etc.)
    for (const c of summaryChannels) rows.push({ channel: c.channel, revenue: c.revenue, orders: c.orders });
  } else {
    for (const ch of PAID_CHANNELS) rows.push({ channel: ch, revenue: paid[ch], orders: orders.filter((o) => o.channel === ch).length });
    rows.push({ channel: 'resto', revenue: Math.max(0, webRev - paid.meta - paid.google), orders: null });
  }
  const total = sum(rows, (r) => r.revenue);
  return rows
    .map((r) => ({ ...r, sharePct: total ? round((r.revenue / total) * 100, 1) : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
}

// Campañas: gasto de gineza (igual que el agente) + ganancia de sus pedidos.
// Pedidos con clic de la plataforma pero sin ID de campaña (típico de PMax en
// Google) van a una fila aparte; mientras existan, una campaña sin ventas
// identificadas es "sin dato", no "sin ventas": sus ventas pueden estar ahí.
export function campaigns({ rows, orders, platform, limit = 30 }) {
  const mine = orders.filter((o) => o.channel === platform);
  const unknown = mine.filter((o) => !o.campaignId);
  // Solo si lo no identificado pesa (≥5 % de los pedidos) se duda de un "sin ventas".
  const unknownMatters = unknown.length > 0 && unknown.length / mine.length >= 0.05;
  const unidentified = unknown.length ? {
    sales: unknown.length,
    revenue: sum(unknown, (o) => o.total),
    grossProfit: sum(unknown, (o) => o.grossProfit),
  } : null;
  const byId = new Map();
  for (const o of orders) {
    if (o.channel !== platform || !o.campaignId) continue;
    const c = byId.get(o.campaignId) || { revenue: 0, grossProfit: 0, sales: 0 };
    c.revenue += o.total;
    c.grossProfit += o.grossProfit;
    c.sales += 1;
    byId.set(o.campaignId, c);
  }
  const list = (rows || [])
    .map((r) => {
      const own = byId.get(String(r.id)) || { revenue: 0, grossProfit: 0, sales: 0 };
      const spend = r.spend || 0;
      return {
        id: String(r.id),
        name: r.name || `Campaña ${r.id}`,
        status: r.status || null,
        thumbnail: r.thumbnail_url || null,
        spend,
        sales: own.sales,
        revenue: own.revenue,
        grossProfit: own.grossProfit,
        roas: round(ratio(own.revenue, spend)),
        // sin valor reportado (Google por campaña no lo trae) → sin dato, no 0x
        reportedRoas: r.metaValue > 0 ? round(r.metaRoas) : null,
        poas: round(ratio(own.grossProfit, spend)),
        profitAfterAds: own.grossProfit - spend,
        verdict: !own.sales && unknownMatters && spend > 0 ? 'sin-dato' : verdict({ spend, grossProfit: own.grossProfit, sales: own.sales }),
      };
    })
    .filter((c) => c.spend > 0 || c.sales > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, limit);
  return { rows: list, unidentified };
}

// Serie diaria: inversión, ventas (web y locales) y ganancia después de pauta.
export function daily({ range, webDocs, localDocs, metaDaily, googleDaily, costBySku, fallback }) {
  const days = [];
  for (let d = range.start; d <= range.end; d = nextDay(d)) days.push(d);
  const row = new Map(days.map((d) => [d, { date: d, spend: 0, web: 0, locales: 0, grossProfit: 0 }]));
  for (const x of [...metaDaily, ...googleDaily]) {
    const r = row.get(x.date);
    if (r) r.spend += x.spend || 0;
  }
  for (const [docs, key] of [[webDocs, 'web'], [localDocs, 'locales']]) {
    for (const d of completed(docs)) {
      const r = row.get(argDay(d.date));
      if (!r) continue;
      r[key] += d.total || 0;
      r.grossProfit += orderGrossProfit(d, costBySku, fallback);
    }
  }
  return days.map((d) => {
    const r = row.get(d);
    return { ...r, profitAfterAds: r.grossProfit - r.spend };
  });
}

function nextDay(ymd) {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

// Clientes nuevos vs. recurrentes. typeByOrder: id de pedido TN → 'nuevo' |
// 'recurrente' | 'sin-dato'. El primer pedido de un cliente es único, así que
// pedidos nuevos = clientes nuevos.
export function customerMix({ webDocs, typeByOrder, orders, spendBy }) {
  const empty = () => ({ orders: 0, revenue: 0 });
  const add = (b, total) => { b.orders += 1; b.revenue += total || 0; };
  const split = (list, idOf, totalOf) => {
    const s = { nuevo: empty(), recurrente: empty(), sinDato: empty() };
    for (const x of list) {
      const t = typeByOrder.get(String(idOf(x)));
      add(t === 'nuevo' ? s.nuevo : t === 'recurrente' ? s.recurrente : s.sinDato, totalOf(x));
    }
    const known = s.nuevo.orders + s.recurrente.orders;
    const knownRev = s.nuevo.revenue + s.recurrente.revenue;
    return {
      ...s,
      newPct: known ? round((s.nuevo.orders / known) * 100, 1) : null,
      newRevenuePct: knownRev ? round((s.nuevo.revenue / knownRev) * 100, 1) : null,
    };
  };
  const web = split(completed(webDocs), (d) => d.sourceId, (d) => d.total);
  const platform = Object.fromEntries(PAID_CHANNELS.map((ch) => {
    const s = split(orders.filter((o) => o.channel === ch), (o) => o.id, (o) => o.total);
    const spend = spendBy?.[ch]?.spend || 0;
    return [ch, { ...s, costPerNew: s.nuevo.orders ? round(spend / s.nuevo.orders, 0) : null }];
  }));
  // Lo que no vino por Meta ni Google (orgánico, email, redes, directo…)
  const paidIds = new Set(orders.map((o) => String(o.id)));
  const rest = split(completed(webDocs).filter((d) => !paidIds.has(String(d.sourceId))), (d) => d.sourceId, (d) => d.total);
  const campaignsNew = {};
  for (const ch of PAID_CHANNELS) {
    const by = new Map();
    for (const o of orders) {
      if (o.channel !== ch || !o.campaignId) continue;
      const t = typeByOrder.get(String(o.id));
      const c = by.get(o.campaignId) || { nuevo: 0, known: 0 };
      if (t === 'nuevo' || t === 'recurrente') c.known += 1;
      if (t === 'nuevo') c.nuevo += 1;
      by.set(o.campaignId, c);
    }
    campaignsNew[ch] = Object.fromEntries([...by].map(([id, c]) => [id, { newOrders: c.nuevo, newPct: c.known ? round((c.nuevo / c.known) * 100, 0) : null }]));
  }
  return { web, platform, rest, campaigns: campaignsNew };
}
