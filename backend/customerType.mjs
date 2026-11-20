// ¿Cliente nuevo o recurrente? Por pedido web pago de un período: nuevo si
// ese cliente no tiene ningún pedido pago anterior en Tienda Nube (historia
// desde 2023). Se le pregunta a TN en lotes por customer_ids.
import { fetchAllPages } from './tiendanube.mjs';

const BATCH = 80;
const PARALLEL = 3;
// Primera compra conocida por cliente. Una vez encontrada no cambia; "sin
// compras antes de X" sí puede cambiar para fechas posteriores, por eso se
// guarda hasta qué fecha se miró.
const firstPaid = new Map(); // customerId → ISO de su primer pedido pago
const noneBefore = new Map(); // customerId → ISO hasta donde no tenía compras

// TN responde 404 (no una lista vacía) cuando el filtro no encuentra pedidos.
async function pagesOrEmpty(params) {
  try {
    return await fetchAllPages('orders', params);
  } catch (err) {
    if (/API error 404/.test(err.message)) return [];
    throw err;
  }
}

const artStart = (ymd) => `${ymd}T03:00:00Z`;
const artEnd = (ymd) => new Date(new Date(`${ymd}T03:00:00Z`).getTime() + 86400000 - 1).toISOString();
const iso = (d) => new Date(d).toISOString();

// Puro: clasifica los pedidos del período dado lo que se sabe de cada cliente.
export function classify(periodOrders, priorFirstByCustomer) {
  const sorted = [...periodOrders].sort((a, b) => iso(a.created_at).localeCompare(iso(b.created_at)));
  const seen = new Set();
  const out = new Map();
  for (const o of sorted) {
    const c = o.customer?.id;
    if (!c) { out.set(String(o.id), 'sin-dato'); continue; }
    const before = priorFirstByCustomer.get(c);
    const isNew = !before && !seen.has(c);
    seen.add(c);
    out.set(String(o.id), isNew ? 'nuevo' : 'recurrente');
  }
  return out;
}

async function priorFirst(customerIds, beforeISO) {
  const result = new Map();
  const ask = [];
  for (const c of customerIds) {
    const f = firstPaid.get(c);
    if (f && f < beforeISO) result.set(c, f);
    else if (!(noneBefore.get(c) >= beforeISO)) ask.push(c);
  }
  const batches = [];
  for (let i = 0; i < ask.length; i += BATCH) batches.push(ask.slice(i, i + BATCH));
  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(batches.slice(i, i + PARALLEL).map(async (ids) => {
      const prev = await pagesOrEmpty({
        customer_ids: ids.join(','), created_at_max: beforeISO, payment_status: 'paid', fields: 'id,created_at,customer',
      });
      for (const o of prev) {
        const c = o.customer?.id;
        if (!c) continue;
        const at = iso(o.created_at);
        if (!result.has(c) || at < result.get(c)) result.set(c, at);
      }
      for (const c of ids) {
        if (result.has(c)) {
          const known = firstPaid.get(c);
          if (!known || result.get(c) < known) firstPaid.set(c, result.get(c));
        } else noneBefore.set(c, beforeISO);
      }
    }));
  }
  return result;
}

const CLOSED_TTL = 12 * 3600 * 1000;
const OPEN_TTL = 20 * 60 * 1000;
const cache = new Map();

// Map id de pedido TN → 'nuevo' | 'recurrente' | 'sin-dato'
export function getCustomerTypes(range, today) {
  const key = `${range.start}|${range.end}`;
  const ttl = range.end < today ? CLOSED_TTL : OPEN_TTL;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = (async () => {
    const start = artStart(range.start);
    const orders = await pagesOrEmpty({
      created_at_min: start, created_at_max: artEnd(range.end), payment_status: 'paid', fields: 'id,created_at,customer',
    });
    const ids = [...new Set(orders.map((o) => o.customer?.id).filter(Boolean))];
    return classify(orders, await priorFirst(ids, start));
  })();
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  const entry = { at: Date.now(), promise, value: null };
  cache.set(key, entry);
  promise.then((v) => { entry.value = v; }, () => cache.delete(key));
  return promise;
}

// Sin esperar: el resultado si ya está calculado para ese rango, si no null.
export function peekCustomerTypes(range) {
  return cache.get(`${range.start}|${range.end}`)?.value || null;
}
