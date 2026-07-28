import 'dotenv/config';

const BASE_URL = process.env.ODOO_URL;
const DB       = process.env.ODOO_DB;
const LOGIN    = process.env.ODOO_LOGIN;
const PASSWORD = process.env.ODOO_PASSWORD;

let sessionCookie = '';

async function rpc(endpoint, params) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionCookie) headers['Cookie'] = sessionCookie;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers,
    signal:  AbortSignal.timeout(30_000),
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 1, params }),
  });

  const sc = res.headers.get('set-cookie');
  if (sc) {
    const m = sc.match(/session_id=([^;]+)/);
    if (m) sessionCookie = `session_id=${m[1]}`;
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Odoo RPC error: ${json.error.data?.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

export async function authenticate() {
  sessionCookie = '';
  const result = await rpc('/web/session/authenticate', { db: DB, login: LOGIN, password: PASSWORD });
  if (!result?.uid) throw new Error('Odoo authentication failed — check credentials');
  console.log(`[odoo] authenticated uid=${result.uid}`);
}

export async function callKw(model, method, args = [], kwargs = {}) {
  return rpc('/web/dataset/call_kw', {
    model, method, args,
    kwargs: { context: { lang: 'es_AR' }, ...kwargs },
  });
}

export async function fetchAll(model, domain, fields, pageSize = 1000) {
  const results = [];
  let offset = 0;
  while (true) {
    const page = await callKw(model, 'search_read', [domain], { fields, limit: pageSize, offset });
    results.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

// Odoo's /web/image endpoint silently serves a generic placeholder to
// unauthenticated requests instead of erroring (it checks read access on
// the underlying record) — so this always needs the session cookie, not a
// plain fetch of the URL.
export async function fetchProductImage(templateId, field = 'image_128') {
  if (!sessionCookie) await authenticate();
  const res = await fetch(`${BASE_URL}/web/image/product.template/${templateId}/${field}`, {
    headers: { Cookie: sessionCookie },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'image/png',
  };
}

// Splits an array into fixed-size chunks. Used to keep id-list RPC calls
// (read / search_read with `in [...]`) under Odoo's request size/time limits
// at full 14-month-backfill scale (hundreds of thousands of ids).
export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}
