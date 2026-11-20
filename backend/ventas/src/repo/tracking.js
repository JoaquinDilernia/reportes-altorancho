import { classifySession, summarizeJourney } from '../engine/tracking.js';

const LOOKBACK_DAYS = 120;

export function createTrackingRepo(db) {
  // Asegura la sesión (si se perdió el evento de inicio, queda como "sin dato")
  async function touchSession(q, { sessionId, visitorId, at }) {
    await q.query(
      `INSERT INTO track_sessions (id, visitor_id, started_at, last_at, channel)
       VALUES ($1, $2, $3, $3, 'unknown')
       ON CONFLICT (id) DO UPDATE SET last_at = GREATEST(track_sessions.last_at, EXCLUDED.last_at)`,
      [sessionId, visitorId, at],
    );
  }

  return {
    async record({ visitorId, sessionId, events }, { now = new Date(), ownHost } = {}) {
      return db.tx(async (q) => {
        for (const ev of events) {
          if (ev.type === 'session') {
            const c = classifySession({ url: ev.url, referrer: ev.referrer, ownHost });
            let landing = null;
            try { landing = ev.url ? new URL(ev.url).pathname.slice(0, 200) : null; } catch { /* url inválida */ }
            await q.query(
              `INSERT INTO track_sessions (id, visitor_id, started_at, last_at, channel, source, medium, campaign, content, click_id, referrer_host, landing_path, device, customer_id)
               VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               ON CONFLICT (id) DO UPDATE SET channel = EXCLUDED.channel, source = EXCLUDED.source, medium = EXCLUDED.medium,
                 campaign = EXCLUDED.campaign, content = EXCLUDED.content, click_id = EXCLUDED.click_id,
                 referrer_host = EXCLUDED.referrer_host, landing_path = EXCLUDED.landing_path,
                 device = COALESCE(EXCLUDED.device, track_sessions.device),
                 customer_id = COALESCE(EXCLUDED.customer_id, track_sessions.customer_id)
               WHERE track_sessions.channel = 'unknown'`,
              [sessionId, visitorId, now, c.channel, c.source, c.medium, c.campaign, c.content, c.click_id, c.referrer_host, landing, ev.device, ev.customerId || null],
            );
          } else if (ev.type === 'page') {
            await touchSession(q, { sessionId, visitorId, at: now });
            await q.query(
              `UPDATE track_sessions SET pageviews = pageviews + 1, product_views = product_views + $2, last_at = $3,
                 customer_id = COALESCE($4, customer_id) WHERE id = $1`,
              [sessionId, ev.product ? 1 : 0, now, ev.customerId || null],
            );
          } else {
            await touchSession(q, { sessionId, visitorId, at: now });
            await q.query('INSERT INTO track_events (session_id, visitor_id, at, type, data) VALUES ($1,$2,$3,$4,$5)', [sessionId, visitorId, now, ev.type, ev.data || null]);
            if (ev.type === 'purchase' && ev.data?.orderId) {
              await q.query(
                'INSERT INTO track_order_links (order_id, visitor_id, session_id, at) VALUES ($1,$2,$3,$4) ON CONFLICT (order_id) DO NOTHING',
                [ev.data.orderId, visitorId, sessionId, now],
              );
            }
          }
        }
      });
    },

    // Recorrido completo de un pedido: todos los visitantes que sabemos que son
    // esa persona (pedidos con el mismo mail, misma cuenta de cliente), desde su
    // compra anterior (o 120 días) hasta la compra.
    async journeyForOrder(orderId) {
      const { rows: [order] } = await db.query('SELECT id, created_at, customer_email FROM orders WHERE id = $1', [orderId]);
      if (!order) return { tracked: false, reason: 'pedido desconocido' };
      const { rows: direct } = await db.query('SELECT visitor_id FROM track_order_links WHERE order_id = $1', [orderId]);
      const visitors = new Set(direct.map((r) => r.visitor_id));
      if (order.customer_email) {
        const { rows } = await db.query(
          `SELECT l.visitor_id FROM track_order_links l JOIN orders o ON o.id = l.order_id
           WHERE lower(o.customer_email) = lower($1)`, [order.customer_email]);
        for (const r of rows) visitors.add(r.visitor_id);
      }
      if (visitors.size) {
        const { rows } = await db.query(
          `SELECT DISTINCT s2.visitor_id FROM track_sessions s1 JOIN track_sessions s2 ON s2.customer_id = s1.customer_id
           WHERE s1.visitor_id = ANY($1) AND s1.customer_id IS NOT NULL`, [[...visitors]]);
        for (const r of rows) visitors.add(r.visitor_id);
      }
      if (!visitors.size) return { tracked: false, reason: 'sin visitas registradas (la compra fue antes de instalar el seguimiento o el navegador lo bloqueó)' };

      // Ventana: justo después de la compra anterior hasta esta compra. Cada borde es el
      // momento en que llegó la página de "gracias" (si se registró) o la hora del pedido.
      const orderAt = new Date(order.created_at);
      const linkAt = async (id) => (await db.query('SELECT at FROM track_order_links WHERE order_id = $1', [id])).rows[0]?.at;
      const thisLink = await linkAt(orderId);
      const to = new Date(Math.max(orderAt.getTime() + 2 * 60e3, thisLink ? new Date(thisLink).getTime() + 1000 : 0));
      let from = new Date(orderAt.getTime() - LOOKBACK_DAYS * 864e5);
      if (order.customer_email) {
        const { rows: [prev] } = await db.query(
          `SELECT id, created_at FROM orders WHERE lower(customer_email) = lower($1) AND created_at < $2 AND id <> $3
             AND payment_status = 'paid' AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1`, [order.customer_email, orderAt, orderId]);
        if (prev) {
          const prevLink = await linkAt(prev.id);
          const prevEnd = new Date(Math.max(new Date(prev.created_at).getTime() + 2 * 60e3, prevLink ? new Date(prevLink).getTime() + 1000 : 0));
          if (prevEnd > from) from = prevEnd;
        }
      }
      const ids = [...visitors];
      // eventos dentro de la ventana; visitas con alguna actividad en ella (una visita puede abarcar dos compras)
      const { rows: events } = await db.query(
        'SELECT session_id, at, type, data FROM track_events WHERE visitor_id = ANY($1) AND at > $2 AND at <= $3 ORDER BY at', [ids, from, to]);
      const { rows: sessions } = await db.query(
        `SELECT * FROM track_sessions WHERE visitor_id = ANY($1) AND started_at <= $3
           AND (started_at > $2 OR last_at > $2 OR id = ANY($4)) ORDER BY started_at`,
        [ids, from, to, [...new Set(events.map((e) => e.session_id))]]);
      const { rows: abandoned } = order.customer_email ? await db.query(
        `SELECT created_at AS at, total::float AS total, items, products, channel FROM tn_checkouts
          WHERE contact_email = lower($1) AND created_at > $2 AND created_at < $3 ORDER BY created_at`,
        [order.customer_email, from, orderAt]) : { rows: [] };
      return {
        tracked: true, since: from.toISOString(), ...summarizeJourney({ sessions, events, orderAt, visitors: ids }),
        abandonedCheckouts: abandoned.map((c) => ({ at: c.at, total: c.total, channel: c.channel, products: (c.products || []).map((p) => p.name) })),
      };
    },

    // Para el panel: cuántas visitas y carritos se registraron (para ver que el script anda)
    async stats(sinceHours = 24) {
      const since = new Date(Date.now() - sinceHours * 3600e3);
      const { rows: [r] } = await db.query(
        `SELECT (SELECT count(*) FROM track_sessions WHERE started_at >= $1)::int AS sessions,
                (SELECT count(DISTINCT visitor_id) FROM track_sessions WHERE started_at >= $1)::int AS visitors,
                (SELECT count(*) FROM track_events WHERE type = 'add_to_cart' AND at >= $1)::int AS add_to_cart,
                (SELECT count(*) FROM track_events WHERE type = 'checkout' AND at >= $1)::int AS checkouts,
                (SELECT count(*) FROM track_order_links WHERE at >= $1)::int AS orders_linked`, [since]);
      return { sinceHours, ...r };
    },

    // Visitas, carritos y compras por canal en un rango (from incluido, to excluido).
    // "orders" = canal de la visita en la que compró; "assisted" = el canal trajo al
    // comprador al menos una vez en los 30 días antes de la compra.
    async channelSummary(from, to) {
      const [{ rows: sessions }, { rows: carts }, { rows: last }, { rows: assisted }, { rows: [first] }] = await Promise.all([
        db.query(
          `SELECT channel, count(*)::int AS visits, count(DISTINCT visitor_id)::int AS visitors,
                  coalesce(sum(pageviews), 0)::int AS pageviews, coalesce(sum(product_views), 0)::int AS product_views,
                  (count(*) FILTER (WHERE pageviews <= 1))::int AS bounces
             FROM track_sessions WHERE started_at >= $1 AND started_at < $2 GROUP BY channel`, [from, to]),
        db.query(
          `SELECT s.channel, count(*)::int AS adds, count(DISTINCT s.id)::int AS sessions_with_cart
             FROM track_events e JOIN track_sessions s ON s.id = e.session_id
            WHERE e.type = 'add_to_cart' AND s.started_at >= $1 AND s.started_at < $2 GROUP BY s.channel`, [from, to]),
        db.query(
          `SELECT coalesce(s.channel, 'unknown') AS channel, count(*)::int AS orders, coalesce(sum(o.total), 0)::float AS revenue
             FROM track_order_links l JOIN orders o ON o.id = l.order_id LEFT JOIN track_sessions s ON s.id = l.session_id
            WHERE o.created_at >= $1 AND o.created_at < $2 AND o.cancelled_at IS NULL GROUP BY 1`, [from, to]),
        db.query(
          `SELECT channel, count(*)::int AS orders, coalesce(sum(total), 0)::float AS revenue FROM (
             SELECT DISTINCT s.channel, l.order_id, o.total
               FROM track_order_links l JOIN orders o ON o.id = l.order_id
               JOIN track_sessions s ON s.visitor_id = l.visitor_id AND s.started_at <= l.at AND s.started_at > l.at - interval '30 days'
              WHERE o.created_at >= $1 AND o.created_at < $2 AND o.cancelled_at IS NULL) x GROUP BY channel`, [from, to]),
        db.query('SELECT min(started_at) AS at FROM track_sessions'),
      ]);
      const by = new Map();
      const row = (ch) => {
        if (!by.has(ch)) by.set(ch, { channel: ch, visits: 0, visitors: 0, pageviews: 0, productViews: 0, bounces: 0, adds: 0, sessionsWithCart: 0, orders: 0, revenue: 0, assistedOrders: 0, assistedRevenue: 0 });
        return by.get(ch);
      };
      for (const s of sessions) Object.assign(row(s.channel), { visits: s.visits, visitors: s.visitors, pageviews: s.pageviews, productViews: s.product_views, bounces: s.bounces });
      for (const c of carts) Object.assign(row(c.channel), { adds: c.adds, sessionsWithCart: c.sessions_with_cart });
      for (const o of last) Object.assign(row(o.channel), { orders: o.orders, revenue: Number(o.revenue) });
      for (const a of assisted) Object.assign(row(a.channel), { assistedOrders: a.orders, assistedRevenue: Number(a.revenue) });
      const channels = [...by.values()].sort((a, b) => b.visits - a.visits || b.orders - a.orders);
      const keys = ['visits', 'visitors', 'pageviews', 'productViews', 'bounces', 'adds', 'sessionsWithCart', 'orders', 'revenue'];
      const total = Object.fromEntries(keys.map((k) => [k, channels.reduce((n, c) => n + c[k], 0)]));
      return { trackingSince: first?.at || null, channels, total };
    },

    // Todo lo de la pestaña Visitas para un rango: embudo, entradas, dispositivos,
    // productos, búsquedas, recorridos y checkouts abandonados.
    async insights(from, to) {
      const q = (sql, params = [from, to]) => db.query(sql, params).then((r) => r.rows);
      const [funnel, landings, devices, products, searches, journeys, checkouts, ckChannels, ckProducts] = await Promise.all([
        q(`SELECT channel, count(*)::int AS visits, (count(*) FILTER (WHERE product_views > 0))::int AS with_product
             FROM track_sessions WHERE started_at >= $1 AND started_at < $2 GROUP BY channel`),
        q(`SELECT coalesce(nullif(rtrim(s.landing_path, '/'), ''), '/') AS path, count(*)::int AS visits,
                  mode() WITHIN GROUP (ORDER BY s.channel) AS channel,
                  (count(*) FILTER (WHERE s.pageviews <= 1))::int AS bounces,
                  count(DISTINCT c.session_id)::int AS with_cart, count(DISTINCT l.order_id)::int AS orders
             FROM track_sessions s
             LEFT JOIN (SELECT DISTINCT session_id FROM track_events WHERE type = 'add_to_cart' AND at >= $1) c ON c.session_id = s.id
             LEFT JOIN track_order_links l ON l.session_id = s.id
            WHERE s.started_at >= $1 AND s.started_at < $2 AND s.landing_path IS NOT NULL
            GROUP BY 1 ORDER BY 2 DESC LIMIT 40`),
        q(`SELECT coalesce(s.device, 'sin dato') AS device, count(*)::int AS visits,
                  (count(*) FILTER (WHERE s.pageviews <= 1))::int AS bounces,
                  coalesce(sum(s.pageviews), 0)::int AS pageviews,
                  count(DISTINCT c.session_id)::int AS with_cart, count(DISTINCT l.order_id)::int AS orders,
                  coalesce(sum(o.total), 0)::float AS revenue
             FROM track_sessions s
             LEFT JOIN (SELECT DISTINCT session_id FROM track_events WHERE type = 'add_to_cart' AND at >= $1) c ON c.session_id = s.id
             LEFT JOIN track_order_links l ON l.session_id = s.id
             LEFT JOIN orders o ON o.id = l.order_id AND o.cancelled_at IS NULL
            WHERE s.started_at >= $1 AND s.started_at < $2 GROUP BY 1 ORDER BY 2 DESC`),
        q(`WITH since AS (SELECT greatest($1::timestamptz, coalesce(min(at), $1::timestamptz)) AS at FROM track_events WHERE type = 'product'),
                v AS (SELECT (data->>'productId')::bigint AS pid, max(data->>'name') AS name, count(*)::int AS views,
                             count(DISTINCT visitor_id)::int AS people
                        FROM track_events WHERE type = 'product' AND at >= $1 AND at < $2 AND data->>'productId' IS NOT NULL GROUP BY 1),
                a AS (SELECT (data->>'productId')::bigint AS pid, count(*)::int AS adds
                        FROM track_events WHERE type = 'add_to_cart' AND at >= $1 AND at < $2 AND data->>'productId' IS NOT NULL GROUP BY 1),
                b AS (SELECT i.product_id AS pid, sum(i.quantity)::int AS units, count(DISTINCT i.order_id)::int AS orders, sum(i.quantity * i.price)::float AS revenue
                        FROM order_items i JOIN orders o ON o.id = i.order_id, since
                       WHERE o.created_at >= since.at AND o.created_at < $2 AND o.cancelled_at IS NULL AND o.payment_status = 'paid' GROUP BY 1)
           SELECT v.pid, v.name, v.views, v.people, coalesce(a.adds, 0)::int AS adds, coalesce(b.orders, 0)::int AS orders,
                  coalesce(b.units, 0)::int AS units, coalesce(b.revenue, 0)::float AS revenue
             FROM v LEFT JOIN a ON a.pid = v.pid LEFT JOIN b ON b.pid = v.pid ORDER BY v.views DESC LIMIT 60`),
        q(`SELECT e.data->>'q' AS q, count(*)::int AS searches, count(DISTINCT e.session_id)::int AS sessions,
                  count(DISTINCT c.session_id)::int AS with_cart, count(DISTINCT l.order_id)::int AS orders
             FROM track_events e
             LEFT JOIN (SELECT DISTINCT session_id FROM track_events WHERE type = 'add_to_cart' AND at >= $1) c ON c.session_id = e.session_id
             LEFT JOIN track_order_links l ON l.session_id = e.session_id
            WHERE e.type = 'search' AND e.at >= $1 AND e.at < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 40`),
        // por compra: cuántas visitas y días le llevó, por dónde llegó la primera vez y por dónde compró
        q(`SELECT l.order_id, o.total::float AS total, count(s.id)::int AS visits,
                  extract(epoch FROM (l.at - min(s.started_at))) / 86400 AS days,
                  (array_agg(s.channel ORDER BY s.started_at))[1] AS first_channel,
                  (SELECT channel FROM track_sessions WHERE id = l.session_id) AS last_channel
             FROM track_order_links l JOIN orders o ON o.id = l.order_id
             JOIN track_sessions s ON s.visitor_id = l.visitor_id AND s.started_at <= l.at AND s.started_at > l.at - interval '30 days'
            WHERE o.created_at >= $1 AND o.created_at < $2 AND o.cancelled_at IS NULL
            GROUP BY l.order_id, o.total, l.at, l.session_id`),
        q(`SELECT count(*)::int AS abandoned, coalesce(sum(c.total), 0)::float AS value,
                  (count(*) FILTER (WHERE r.id IS NOT NULL))::int AS recovered,
                  coalesce(sum(r.total) FILTER (WHERE r.id IS NOT NULL), 0)::float AS recovered_value
             FROM tn_checkouts c
             LEFT JOIN LATERAL (SELECT o.id, o.total FROM orders o WHERE c.contact_email IS NOT NULL AND lower(o.customer_email) = c.contact_email
                                  AND o.created_at > c.created_at AND o.created_at < c.created_at + interval '14 days' AND o.cancelled_at IS NULL
                                ORDER BY o.created_at LIMIT 1) r ON true
            WHERE c.created_at >= $1 AND c.created_at < $2`),
        q(`SELECT channel, count(*)::int AS abandoned, coalesce(sum(total), 0)::float AS value
             FROM tn_checkouts WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC`),
        q(`SELECT p->>'name' AS name, count(*)::int AS checkouts, sum((p->>'quantity')::int)::int AS units,
                  sum((p->>'quantity')::numeric * (p->>'price')::numeric)::float AS value
             FROM tn_checkouts, jsonb_array_elements(products) p
            WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
      ]);
      // Recorridos: distribución de visitas y días, y de qué canal a qué canal
      const bucket = (n, edges) => edges.find(([max]) => n <= max)?.[1];
      const visitsDist = {};
      const daysDist = {};
      const pairs = {};
      for (const j of journeys) {
        const vb = bucket(j.visits, [[1, '1 visita'], [3, '2 a 3 visitas'], [9, '4 a 9 visitas'], [Infinity, '10 o más']]);
        const db_ = bucket(Number(j.days), [[1, 'el mismo día'], [7, 'en la semana'], [Infinity, 'más de una semana']]);
        visitsDist[vb] = (visitsDist[vb] || 0) + 1;
        daysDist[db_] = (daysDist[db_] || 0) + 1;
        const key = `${j.first_channel || 'unknown'}>${j.last_channel || 'unknown'}`;
        pairs[key] = pairs[key] || { first: j.first_channel || 'unknown', last: j.last_channel || 'unknown', orders: 0, revenue: 0 };
        pairs[key].orders += 1;
        pairs[key].revenue += j.total || 0;
      }
      const productRows = products.map((p) => ({
        productId: Number(p.pid), name: p.name, views: p.views, people: p.people, adds: p.adds, orders: p.orders, units: p.units, revenue: p.revenue,
      }));
      return {
        funnel,
        landings: landings.map((l) => ({ path: l.path, channel: l.channel, visits: l.visits, bounces: l.bounces, withCart: l.with_cart, orders: l.orders })),
        devices: devices.map((d) => ({ device: d.device, visits: d.visits, bounces: d.bounces, pageviews: d.pageviews, withCart: d.with_cart, orders: d.orders, revenue: d.revenue })),
        products: productRows,
        searches: searches.map((s) => ({ q: s.q, searches: s.searches, sessions: s.sessions, withCart: s.with_cart, orders: s.orders })),
        journeys: {
          orders: journeys.length,
          avgVisits: journeys.length ? journeys.reduce((n, j) => n + j.visits, 0) / journeys.length : null,
          visits: visitsDist,
          days: daysDist,
          paths: Object.values(pairs).sort((a, b) => b.orders - a.orders),
        },
        checkouts: { ...checkouts[0], byChannel: ckChannels, products: ckProducts },
      };
    },

    // Avisos para el panel: el script dejó de mandar datos, checkouts grandes sin recuperar
    // y canales cuya conversión de las últimas 24 h cayó mucho contra los 7 días anteriores.
    async alerts(now = new Date()) {
      const out = [];
      const { rows: [last] } = await db.query('SELECT max(started_at) AS at FROM track_sessions');
      const hourArt = (now.getUTCHours() + 21) % 24;
      if (last?.at && now - new Date(last.at) > 2 * 3600e3 && hourArt >= 9) {
        out.push({ level: 'critical', kind: 'tracking', text: `El seguimiento no registra visitas desde hace ${Math.round((now - new Date(last.at)) / 3600e3)} h: revisar que el script siga instalado en Tienda Nube.` });
      }
      const day = new Date(now.getTime() - 864e5);
      const week = new Date(now.getTime() - 8 * 864e5);
      const { rows: conv } = await db.query(
        `SELECT s.channel,
                (count(*) FILTER (WHERE s.started_at >= $1))::int AS v_now, (count(*) FILTER (WHERE s.started_at < $1))::int AS v_prev,
                (count(l.order_id) FILTER (WHERE s.started_at >= $1))::int AS o_now, (count(l.order_id) FILTER (WHERE s.started_at < $1))::int AS o_prev
           FROM track_sessions s LEFT JOIN track_order_links l ON l.session_id = s.id
          WHERE s.started_at >= $2 AND s.started_at < $3 GROUP BY 1`, [day, week, now]);
      for (const c of conv) {
        if (c.v_now < 300 || c.v_prev < 1000 || c.o_prev < 5) continue;
        const rNow = c.o_now / c.v_now;
        const rPrev = c.o_prev / c.v_prev;
        if (rNow < rPrev * 0.5) out.push({ level: 'warning', kind: 'conversion', channel: c.channel, text: `${c.channel}: en las últimas 24 h convirtió ${(rNow * 100).toFixed(2)}% (los 7 días anteriores: ${(rPrev * 100).toFixed(2)}%), con ${c.v_now} visitas.` });
      }
      const { rows: big } = await db.query(
        `SELECT c.id, c.created_at, c.total::float AS total, c.contact_email, c.channel, c.products
           FROM tn_checkouts c
          WHERE c.created_at >= $1 AND c.total >= 500000
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE lower(o.customer_email) = c.contact_email AND o.created_at > c.created_at AND o.cancelled_at IS NULL)
          ORDER BY c.total DESC LIMIT 8`, [new Date(now.getTime() - 2 * 864e5)]);
      for (const b of big) {
        out.push({ level: 'info', kind: 'checkout', at: b.created_at, total: b.total, email: b.contact_email, channel: b.channel,
          products: (b.products || []).map((p) => `${p.quantity}× ${p.name}`).join(', '),
          text: 'Checkout grande abandonado, todavía sin compra: vale un contacto.' });
      }
      return { alerts: out, generatedAt: now.toISOString() };
    },

    async purge(days = 400) {
      const before = new Date(Date.now() - days * 864e5);
      await db.query('DELETE FROM track_events WHERE at < $1', [before]);
      await db.query('DELETE FROM track_sessions WHERE last_at < $1', [before]);
    },
  };
}
