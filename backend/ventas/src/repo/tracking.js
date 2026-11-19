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
      return { tracked: true, since: from.toISOString(), ...summarizeJourney({ sessions, events, orderAt, visitors: ids }) };
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

    async purge(days = 400) {
      const before = new Date(Date.now() - days * 864e5);
      await db.query('DELETE FROM track_events WHERE at < $1', [before]);
      await db.query('DELETE FROM track_sessions WHERE last_at < $1', [before]);
    },
  };
}
