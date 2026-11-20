// Seguimiento propio: qué llega del navegador y cómo se clasifica cada visita.
// Puro (sin DB) para poder testearlo.
import { attribute } from './attribution.js';

const ID = /^[a-z0-9-]{8,40}$/;
const EVENT_TYPES = new Set(['session', 'page', 'product', 'search', 'add_to_cart', 'checkout', 'purchase']);
const PID = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'epik', 'ttclid'];
const SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia)\./;
const SOCIAL = /(^|\.)(instagram|facebook|fb|pinterest|pin|tiktok|youtube|linkedin|twitter|x|t)\.(com|it|me|co)$|lnk\.bio|linktr\.ee/;
const MAIL = /mail\.|outlook\.|perfit|myperfit/;

const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function pathOf(u) {
  try {
    return new URL(u).pathname.slice(0, 200);
  } catch {
    return null;
  }
}

// Origen de una visita a partir de la URL de entrada y el referrer.
// Mismas reglas que la atribución de pedidos para UTMs y click ids; sin
// parámetros, el referrer dice si vino de un buscador, de redes o directo.
export function classifySession({ url, referrer, ownHost = 'altorancho.com' }) {
  const a = attribute({ landingUrl: url, visitLandingPage: null, visitUtm: null });
  const raw = a.source_raw || {};
  const clickId = CLICK_IDS.find((k) => raw[k]) || null;
  const base = {
    source: raw.utm_source || null, medium: raw.utm_medium || null,
    campaign: a.campaign_name || raw.utm_campaign || null, content: raw.utm_content || null, click_id: clickId,
  };
  const ref = hostOf(referrer);
  const refHost = ref && !ref.endsWith(ownHost) && !ref.includes('mitiendanube') ? ref : null;
  // Links que mandan los vendedores (WhatsApp, etc.): utm_source=vendedor&utm_campaign=<nombre>
  if (/^(vendedor|vendedores|ventas)$/i.test(base.source || '')) return { channel: 'vendedor', ...base, referrer_host: refHost };
  if (['meta', 'google', 'pinterest', 'email', 'other'].includes(a.channel)) return { channel: a.channel, ...base, referrer_host: refHost };
  if (a.channel === 'social_organic') return { channel: 'social_organic', ...base, source: base.source || refHost, referrer_host: refHost };
  if (refHost && SEARCH.test(refHost)) return { channel: 'search', ...base, source: refHost, referrer_host: refHost };
  if (refHost && SOCIAL.test(refHost)) return { channel: 'social_organic', ...base, source: refHost, referrer_host: refHost };
  if (refHost && MAIL.test(refHost)) return { channel: 'email', ...base, source: refHost, referrer_host: refHost };
  if (refHost) return { channel: 'referral', ...base, source: refHost, referrer_host: refHost };
  return { channel: 'direct', ...base, referrer_host: null };
}

// Lo que manda el script: { v, s, e: [{ t, ... }] }. Todo lo demás se descarta.
export function parseBatch(body) {
  let b = body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  if (!b || !ID.test(b.v || '') || !ID.test(b.s || '') || !Array.isArray(b.e)) return null;
  const events = [];
  for (const ev of b.e.slice(0, 20)) {
    if (!ev || !EVENT_TYPES.has(ev.t)) continue;
    if (ev.t === 'session') {
      events.push({ type: 'session', url: str(ev.url, 1000), referrer: str(ev.ref, 500), device: ['mobile', 'desktop', 'tablet'].includes(ev.dev) ? ev.dev : null, customerId: str(String(ev.cid ?? ''), 30) });
    } else if (ev.t === 'page') {
      events.push({ type: 'page', product: Boolean(ev.product), path: str(ev.path, 200), customerId: str(String(ev.cid ?? ''), 30) });
    } else if (ev.t === 'product') {
      events.push({ type: 'product', data: { productId: PID(ev.pid), name: str(ev.name, 120), sku: str(ev.sku, 60), price: num(ev.price) } });
    } else if (ev.t === 'search') {
      const q = str(ev.q, 80);
      if (q) events.push({ type: 'search', data: { q: q.toLowerCase() } });
    } else if (ev.t === 'add_to_cart') {
      events.push({ type: 'add_to_cart', data: { productId: PID(ev.pid), sku: str(ev.sku, 60), name: str(ev.name, 120), qty: num(ev.qty), price: num(ev.price), cartItems: num(ev.items), cartTotal: num(ev.total) } });
    } else if (ev.t === 'checkout') {
      events.push({ type: 'checkout', data: { step: str(ev.step, 40), cartItems: num(ev.items), cartTotal: num(ev.total) } });
    } else if (ev.t === 'purchase') {
      const orderId = /^\d{6,15}$/.test(String(ev.order || '')) ? String(ev.order) : null;
      events.push({ type: 'purchase', data: { orderId } });
    }
  }
  return { visitorId: b.v, sessionId: b.s, events };
}

// Recorrido de un pedido a partir de las visitas y eventos del (o los) visitante(s).
// sessions/events ya vienen filtrados hasta la compra y ordenados por fecha.
export function summarizeJourney({ sessions, events, orderAt, visitors }) {
  const carts = events.filter((e) => e.type === 'add_to_cart');
  const checkouts = events.filter((e) => e.type === 'checkout');
  const purchases = events.filter((e) => e.type === 'purchase');
  const evBySession = new Map();
  for (const e of events) {
    if (!evBySession.has(e.session_id)) evBySession.set(e.session_id, []);
    evBySession.get(e.session_id).push(e);
  }
  const channels = [];
  for (const s of sessions) if (channels[channels.length - 1] !== s.channel) channels.push(s.channel);
  const first = sessions[0];
  const dayMs = 864e5;
  return {
    visitors: visitors.length,
    devices: [...new Set(sessions.map((s) => s.device).filter(Boolean))],
    sessions: sessions.length,
    pageviews: sessions.reduce((n, s) => n + (s.pageviews || 0), 0),
    productViews: sessions.reduce((n, s) => n + (s.product_views || 0), 0),
    addToCart: carts.length,
    checkouts: checkouts.length,
    priorPurchases: purchases.filter((p) => new Date(p.at) < new Date(orderAt) - 60e3).length,
    firstVisitAt: first?.started_at || null,
    daysToBuy: first ? Math.round(((new Date(orderAt) - new Date(first.started_at)) / dayMs) * 10) / 10 : null,
    path: channels,
    timeline: sessions.map((s) => {
      const ev = evBySession.get(s.id) || [];
      return {
        at: s.started_at, channel: s.channel, source: s.source, medium: s.medium, campaign: s.campaign,
        clickId: s.click_id, referrer: s.referrer_host, landing: s.landing_path, device: s.device,
        pageviews: s.pageviews, productViews: s.product_views,
        products: [...new Set(ev.filter((e) => e.type === 'product').map((e) => e.data?.name).filter(Boolean))],
        searches: [...new Set(ev.filter((e) => e.type === 'search').map((e) => e.data?.q).filter(Boolean))],
        carts: ev.filter((e) => e.type === 'add_to_cart').map((e) => ({ at: e.at, ...(e.data || {}) })),
        checkout: ev.some((e) => e.type === 'checkout'),
        purchase: ev.some((e) => e.type === 'purchase'),
      };
    }),
  };
}
