import 'dotenv/config';

const BASE_URL   = 'https://api.tiendanube.com/v1';
const STORE_ID   = process.env.TN_STORE_ID;
const TOKEN      = process.env.TN_ACCESS_TOKEN;
const USER_AGENT = process.env.TN_USER_AGENT || 'AltoranchoReportes';

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const nextPart = linkHeader.split(',').find(part => part.includes('rel="next"'));
  if (!nextPart) return null;
  const match = nextPart.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function request(url) {
  const res = await fetch(url, {
    headers: {
      'Authentication': `bearer ${TOKEN}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get('retry-after') || 2);
    console.log(`[tiendanube] rate limited, waiting ${retryAfterSec}s`);
    await new Promise(r => setTimeout(r, retryAfterSec * 1000));
    return request(url);
  }

  if (!res.ok) {
    throw new Error(`Tiendanube API error ${res.status}: ${await res.text()}`);
  }

  return { data: await res.json(), next: parseNextLink(res.headers.get('link')) };
}

export async function fetchAllPages(resource, params = {}) {
  const query = new URLSearchParams({ per_page: '200', ...params }).toString();
  let url = `${BASE_URL}/${STORE_ID}/${resource}?${query}`;
  const results = [];

  while (url) {
    const { data, next } = await request(url);
    results.push(...data);
    url = next;
  }

  return results;
}

export async function fetchOrdersSince(sinceISO) {
  const params = sinceISO ? { updated_at_min: sinceISO } : {};
  return fetchAllPages('orders', params);
}

export async function fetchAllProducts() {
  return fetchAllPages('products');
}

const ORDER_FIELDS = 'id,number,created_at,customer,contact_name,contact_phone,contact_email,contact_identification,shipping_address';

function shippingAddressString(a) {
  if (!a) return '';
  const street = [a.address, a.number, a.floor].filter((p) => p !== undefined && p !== null && String(p).trim()).join(' ');
  const parts = [street, a.locality, a.city, a.province].filter((p) => p && String(p).trim());
  const zip = a.zipcode && String(a.zipcode).trim() ? ` (${String(a.zipcode).trim()})` : '';
  return parts.join(', ') + zip;
}

// Busca un pedido por su número visible (el que ven clientes y equipo).
export async function findOrderByNumber(number, req = request) {
  const n = String(number ?? '').trim();
  if (!/^\d+$/.test(n)) throw new Error('Número de pedido inválido');
  let data;
  try {
    ({ data } = await req(`${BASE_URL}/${STORE_ID}/orders?q=${n}&per_page=50&fields=${ORDER_FIELDS}`));
  } catch (e) {
    if (/error 404/.test(e?.message ?? '')) return null; // "Last page is 0": no hay resultados
    throw e;
  }
  const o = (Array.isArray(data) ? data : []).find((x) => String(x.number) === n);
  if (!o) return null;
  const c = o.customer ?? {};
  return {
    id: o.id,
    number: String(o.number),
    createdAt: o.created_at,
    customer: {
      name: o.contact_name || c.name || '',
      email: o.contact_email || c.email || '',
      phone: o.contact_phone || c.phone || '',
      identification: o.contact_identification || c.identification || '',
    },
    shippingAddress: shippingAddressString(o.shipping_address),
  };
}
