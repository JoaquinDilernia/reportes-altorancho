// Recorrido y comportamiento de una venta web. Puro: recibe el pedido de gineza,
// las compras anteriores del mismo mail y los costos de Odoo.
import { marginOf, orderGrossProfit } from './pautaRealTab.mjs';

const TZ = 'America/Argentina/Buenos_Aires';
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const PAID_CHANNELS = new Set(['meta', 'google']);

const isPaid = (o) => o.payment_status === 'paid' && !o.cancelled && !o.cancelled_at;
const round = (n, d = 0) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// "Meta / cpc" de GA4 a uno de nuestros canales
export function channelOfSource(source, medium) {
  const s = (source || '').toLowerCase();
  const m = (medium || '').toLowerCase();
  if (!s && !m) return null;
  if (/(facebook|instagram|meta|^fb|^ig)/.test(s)) return m === 'cpc' || m === 'paid' ? 'meta' : 'social';
  if (s === 'google' && m === 'cpc') return 'google';
  if (s === 'pinterest') return m === 'cpc' || m === 'paid' || m === 'paidsocial' ? 'pinterest' : 'social';
  if (m === 'organic') return 'organic';
  if (m === 'email' || /mail|klaviyo|perfit|doppler/.test(s)) return 'email';
  if (s === '(direct)') return 'organic';
  if (m === 'referral') return 'other';
  return 'other';
}

// Qué página vio primero: producto, categoría, búsqueda o inicio.
export function describeLanding(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return { type: 'otra', title: null, path: String(url).slice(0, 200) };
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const pretty = (slug) => {
    const words = decodeURIComponent(slug).replace(/-[a-z0-9]{5}$/i, '').split('-').filter(Boolean);
    const t = words.join(' ');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
  };
  if (parts[0] === 'productos' && parts[1]) return { type: 'producto', title: pretty(parts[1]), slug: parts[1], path: u.pathname };
  if (parts[0] === 'search' || u.searchParams.get('q')) return { type: 'búsqueda', title: u.searchParams.get('q'), path: u.pathname };
  if (parts.length === 0) return { type: 'inicio', title: null, path: '/' };
  if (['checkout', 'cart', 'carrito'].includes(parts[0])) return { type: 'carrito', title: null, path: u.pathname };
  return { type: 'categoría', title: pretty(parts[parts.length - 1]), path: u.pathname };
}

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ¿Compró lo que vio al entrar? Compara las palabras del producto de entrada con los nombres comprados.
export function boughtLanded(landing, items) {
  if (landing?.type !== 'producto' || !landing.title) return null;
  const words = norm(landing.title).split(' ').filter((w) => w.length > 2);
  if (!words.length) return null;
  return items.some((it) => {
    const name = norm(it.name);
    const hits = words.filter((w) => name.includes(w)).length;
    return hits / words.length >= 0.6;
  });
}

function artParts(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(f.find((p) => p.type === 'weekday').value);
  return { weekday: DAYS[wd], hour: Number(f.find((p) => p.type === 'hour').value) };
}

export function minutesBetween(a, b) {
  if (!a || !b) return null;
  const m = (new Date(b) - new Date(a)) / 60000;
  return m >= 0 ? Math.round(m) : null;
}

export function buildJourney({ order: o, history: historyIn = [], costBySku = new Map(), fallbackCostRatio = null }) {
  const items = o.items || [];
  // null = no se pudo traer el historial: no se sabe si es nuevo
  const history = historyIn || [];
  const created = new Date(o.created_at).getTime();
  const prior = history.filter((h) => String(h.id) !== String(o.id) && new Date(h.created_at).getTime() < created && isPaid(h));
  const later = history.filter((h) => String(h.id) !== String(o.id) && new Date(h.created_at).getTime() > created && isPaid(h));

  const landing = describeLanding(o.visit_landing_page || o.landing_url);
  const minutesToBuy = minutesBetween(o.visit_created_at, o.created_at);
  const { weekday, hour } = artParts(o.created_at);

  // Economía: misma regla que el tablero (líneas con precio > 0; sin costo → sin dato)
  const lines = items.map((it) => ({ sku: it.sku, qty: it.quantity, unitPrice: it.price }));
  const m = marginOf([{ items: lines }], costBySku);
  // Productos sin costo en Odoo: se estiman con el margen de los que sí tienen (o el promedio que pase el que llama)
  const fallback = m.costRatio ?? fallbackCostRatio;
  const grossProfit = m.knownRev > 0 || fallback != null ? orderGrossProfit({ total: o.total, items: lines }, costBySku, fallback) : null;
  const adCost = PAID_CHANNELS.has(o.channel) ? o.costEstimate?.costPerSale ?? null : null;

  const steps = [];
  const firstCh = o.first_channel || channelOfSource(o.first_source, o.first_medium);
  if (firstCh || o.first_source) {
    steps.push({ kind: 'first', channel: firstCh, source: o.first_source || null, medium: o.first_medium || null });
  }
  if (prior.length) {
    const first = prior[0];
    steps.push({
      kind: 'history', count: prior.length,
      revenue: prior.reduce((s, h) => s + h.total, 0),
      firstAt: first.created_at, firstChannel: first.channel, lastAt: prior[prior.length - 1].created_at,
      orders: prior.slice(-5).map((h) => ({ id: h.id, number: h.number, at: h.created_at, total: h.total, channel: h.channel, campaign: h.campaign_name || null })),
    });
  }
  steps.push({
    kind: 'visit', at: o.visit_created_at || null, channel: o.channel, confidence: o.confidence || null,
    campaign: o.campaign_name || null, adset: o.adset_name || null, ad: o.ad_name || null, thumbnail: o.thumbnail_url || null,
    utm: o.source_raw ? { source: o.source_raw.utm_source || null, medium: o.source_raw.utm_medium || null, campaign: o.source_raw.utm_campaign || null } : null,
    landing,
  });
  steps.push({ kind: 'purchase', at: o.created_at, minutesSinceVisit: minutesToBuy });
  if (o.paid_at) steps.push({ kind: 'paid', at: o.paid_at, minutesSincePurchase: minutesBetween(o.created_at, o.paid_at) });
  if (later.length) steps.push({ kind: 'after', count: later.length, revenue: later.reduce((s, h) => s + h.total, 0), nextAt: later[0].created_at });

  return {
    id: o.id, number: o.number, createdAt: o.created_at, total: o.total, customerName: o.customer_name || null,
    status: o.cancelled_at ? 'cancelada' : ({ paid: 'pagada', pending: 'pendiente', authorized: 'autorizada', abandoned: 'abandonada', refunded: 'devuelta', voided: 'anulada' })[o.payment_status] || o.payment_status,
    channel: o.channel,
    customer: {
      type: !o.customer_email || !historyIn ? 'sin-dato' : prior.length ? 'recurrente' : 'nuevo',
      priorOrders: prior.length, laterOrders: later.length,
      lifetimeRevenue: prior.reduce((s, h) => s + h.total, 0) + (isPaid(o) ? o.total : 0) + later.reduce((s, h) => s + h.total, 0),
    },
    steps,
    behavior: {
      device: o.storefront || null, weekday, hour,
      minutesToBuy, sameSession: minutesToBuy != null ? minutesToBuy <= 30 : null,
      units: items.reduce((s, it) => s + it.quantity, 0), lines: items.length,
      discountPct: o.subtotal > 0 && o.discount > 0 ? round((o.discount / o.subtotal) * 100, 1) : 0,
      freeShipping: !(o.shipping_cost_customer > 0), shipping: o.shipping_cost_customer || 0,
      gateway: o.gateway_name || null,
      landedOnBought: boughtLanded(landing, items),
    },
    economics: {
      revenue: o.total,
      grossProfit: grossProfit == null ? null : Math.round(grossProfit),
      marginPct: grossProfit != null && o.total > 0 ? round((grossProfit / o.total) * 100, 1) : null,
      costCoverage: m.costCoverage == null ? null : round(m.costCoverage, 2),
      adCost: adCost == null ? null : Math.round(adCost),
      adCostBasis: adCost == null ? null : o.costEstimate,
      net: grossProfit != null && adCost != null ? Math.round(grossProfit - adCost) : null,
    },
    items: items.map((it) => {
      const cost = costBySku.get(it.sku);
      return { sku: it.sku, name: it.name, qty: it.quantity, price: it.price, unitCost: cost ?? null };
    }),
  };
}
