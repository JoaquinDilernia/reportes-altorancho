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
