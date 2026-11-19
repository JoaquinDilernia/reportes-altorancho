// Cliente del backend de gineza-agent (altorancho-ventas en Railway): ahí
// vive la atribución de cada pedido de Tienda Nube al anuncio que lo trajo
// y los agentes de Meta y Google. Reportes le habla server-side con su
// contraseña, así el equipo entra con un solo login.
import 'dotenv/config';

const DEFAULT_URL = 'https://web-production-71431.up.railway.app';
const PAGE_LIMIT = 60; // 50 pedidos por página → hasta 3.000 pedidos pagos por canal

export const ginezaBaseUrl = () => (process.env.GINEZA_URL || DEFAULT_URL).replace(/\/+$/, '');
export const ginezaAuthHeader = () => `Bearer ${process.env.GINEZA_PASSWORD}`;

// Con el módulo Ventas corriendo en este mismo servidor, las lecturas van a su
// API local (/api/gz) con un token propio en vez de salir a gineza por internet.
let local = null;
export function useLocalGineza({ apiRoot, authHeader }) {
  local = { apiRoot, authHeader };
}
export const isGinezaConfigured = () => Boolean(local || process.env.GINEZA_PASSWORD);
const apiRoot = () => (local ? local.apiRoot : `${ginezaBaseUrl()}/api`);
const authHeader = () => (local ? local.authHeader() : ginezaAuthHeader());

async function get(path) {
  const res = await fetch(`${apiRoot()}${path}`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new Error('gineza rechazó la contraseña (GINEZA_PASSWORD)');
  if (!res.ok) throw new Error(`gineza ${path.split('?')[0]} respondió ${res.status}`);
  return res.json();
}

const qs = (o) => new URLSearchParams(o).toString();

// Pedidos pagos atribuidos a un canal pago, recorriendo el cursor.
async function paidOrdersOf(channel, from, to) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < PAGE_LIMIT; i++) {
    const page = await get(`/orders?${qs({ from, to, channel, ...(cursor ? { cursor } : {}) })}`);
    for (const o of page.items) {
      if (o.payment_status === 'paid' && !o.cancelled) out.push(o);
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

// Map id de pedido TN → { channel, campaignId, campaignName, adId, adName }
export async function fetchPaidAttribution(from, to) {
  const lists = await Promise.all(['meta', 'google', 'pinterest', 'email'].map((ch) => paidOrdersOf(ch, from, to)));
  const map = new Map();
  for (const o of lists.flat()) {
    map.set(String(o.id), {
      channel: o.channel,
      campaignId: o.campaign_id || null,
      campaignName: o.campaign_name || null,
      adId: o.ad_id || null,
      adName: o.ad_name || null,
      total: o.total,
    });
  }
  return map;
}

export async function fetchSummary(from, to) {
  return get(`/summary?${qs({ from, to })}`);
}

export async function fetchCampaigns(from, to) {
  const [meta, google] = await Promise.all([
    get(`/ads?${qs({ from, to, platform: 'meta', level: 'campaign', sort: 'spend' })}`),
    get(`/ads?${qs({ from, to, platform: 'google', sort: 'spend' })}`),
  ]);
  return { meta: meta.rows, google: google.rows };
}

export async function fetchAds(from, to) {
  const r = await get(`/ads?${qs({ from, to, platform: 'meta', level: 'ad', sort: 'spend' })}`);
  return r.rows;
}

// Listado de pedidos web (50 por página, con cursor) tal como lo arma gineza.
export function fetchOrders({ from, to, channel, q, cursor }) {
  const p = { from, to };
  if (channel) p.channel = channel;
  if (q) p.q = q;
  if (cursor) p.cursor = cursor;
  return get(`/orders?${qs(p)}`);
}

// Recorrido propio (script de la tienda): visitas, carritos y checkouts antes de la compra
export async function fetchTracking(id) {
  return get(`/tracking/order/${encodeURIComponent(id)}`);
}

export async function fetchTrackingStats(hours = 24) {
  return get(`/tracking/stats?hours=${Number(hours) || 24}`);
}

export async function fetchOrder(id) {
  return get(`/orders/${encodeURIComponent(id)}`);
}

// Todas las compras de un mail desde 2023 (búsqueda por texto de gineza), viejas primero.
// gineza no acepta rangos de más de 366 días: se busca de a un año, en paralelo.
export async function fetchCustomerHistory(email, to, { since = '2023-01-01', maxPages = 3 } = {}) {
  if (!email) return [];
  const windows = [];
  let end = to;
  const shift = (ymd, days) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  while (end >= since && windows.length < 10) {
    const start = shift(end, -365) < since ? since : shift(end, -365);
    windows.push([start, end]);
    end = shift(start, -1);
  }
  const chunks = await Promise.all(windows.map(async ([from, until]) => {
    const out = [];
    let cursor;
    for (let i = 0; i < maxPages; i++) {
      const page = await fetchOrders({ from, to: until, q: email, cursor });
      out.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }));
  return chunks.flat().sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
}
