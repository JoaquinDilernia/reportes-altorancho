// Cliente del backend de gineza-agent (altorancho-ventas en Railway): ahí
// vive la atribución de cada pedido de Tienda Nube al anuncio que lo trajo
// y los agentes de Meta y Google. Reportes le habla server-side con su
// contraseña, así el equipo entra con un solo login.
import 'dotenv/config';

const DEFAULT_URL = 'https://web-production-71431.up.railway.app';
const PAGE_LIMIT = 60; // 50 pedidos por página → hasta 3.000 pedidos pagos por canal

export const ginezaBaseUrl = () => (process.env.GINEZA_URL || DEFAULT_URL).replace(/\/+$/, '');
export const isGinezaConfigured = () => Boolean(process.env.GINEZA_PASSWORD);
export const ginezaAuthHeader = () => `Bearer ${process.env.GINEZA_PASSWORD}`;

async function get(path) {
  const res = await fetch(`${ginezaBaseUrl()}/api${path}`, {
    headers: { Authorization: ginezaAuthHeader() },
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
  const [meta, google] = await Promise.all([paidOrdersOf('meta', from, to), paidOrdersOf('google', from, to)]);
  const map = new Map();
  for (const o of [...meta, ...google]) {
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
