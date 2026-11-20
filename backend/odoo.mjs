import 'dotenv/config';

const BASE_URL = process.env.ODOO_URL;
const DB       = process.env.ODOO_DB;
const LOGIN    = process.env.ODOO_LOGIN;
const PASSWORD = process.env.ODOO_PASSWORD;

let sessionCookie = '';

async function rpc(endpoint, params, { withCookie = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withCookie && sessionCookie) headers['Cookie'] = sessionCookie;

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
  // Don't clear the shared cookie first: concurrent calls keep using the old
  // session until the new Set-Cookie replaces it.
  const result = await rpc('/web/session/authenticate', { db: DB, login: LOGIN, password: PASSWORD }, { withCookie: false });
  if (!result?.uid) throw new Error('Odoo authentication failed — check credentials');
  console.log(`[odoo] authenticated uid=${result.uid}`);
}

const READ_METHODS = new Set([
  'search_read', 'read', 'search', 'search_count', 'read_group', 'fields_get',
  'name_search', 'name_get', 'default_get', 'check_access_rights', 'onchange',
]);

export function isReadMethod(method) {
  return READ_METHODS.has(method);
}

let fakeIdSeq = 0;
const nextFakeId = () => -(++fakeIdSeq);

const DRY_LOG_MAX = 500;
const dryLog = [];

export function dryWriteLog() {
  return dryLog;
}

export function dryWriteResult(model, method, args = []) {
  if (method === 'create') {
    const first = args[0];
    if (Array.isArray(first)) return first.map(() => nextFakeId());
    return nextFakeId();
  }
  return { res_id: nextFakeId(), dryRun: true };
}

export async function callKw(model, method, args = [], kwargs = {}) {
  if (process.env.ODOO_WRITES === 'dry' && !isReadMethod(method)) {
    console.log(`[odoo:dry] ${model}.${method}`);
    dryLog.push({ model, method, args, at: new Date().toISOString() });
    if (dryLog.length > DRY_LOG_MAX) dryLog.splice(0, dryLog.length - DRY_LOG_MAX);
    return dryWriteResult(model, method, args);
  }
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
