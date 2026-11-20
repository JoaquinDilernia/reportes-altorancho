import { attribute } from '../engine/attribution.js';

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Checkout abandonado crudo de TN → fila de tn_checkouts.
export function mapCheckout(c) {
  const visit = c.customer_visit || {};
  const a = attribute({ landingUrl: c.landing_url || null, visitLandingPage: visit.landing_page || null, visitUtm: visit.utm_parameters || null });
  const products = (c.products || []).map((p) => ({
    product_id: num(p.product_id), name: p.name || null, quantity: num(p.quantity) || 1, price: num(p.price),
  }));
  return {
    id: Number(c.id),
    created_at: c.created_at,
    updated_at: c.updated_at || null,
    contact_email: c.contact_email ? String(c.contact_email).trim().toLowerCase() : null,
    total: num(c.total),
    items: products.reduce((n, p) => n + p.quantity, 0),
    products,
    channel: a.channel,
    campaign: a.campaign_name || null,
    province: c.shipping_province || null,
  };
}

export function createCheckoutSync({ tn, db }) {
  async function upsert(rows) {
    for (const r of rows) {
      await db.query(
        `INSERT INTO tn_checkouts (id, created_at, updated_at, contact_email, total, items, products, channel, campaign, province, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at, contact_email = EXCLUDED.contact_email,
           total = EXCLUDED.total, items = EXCLUDED.items, products = EXCLUDED.products, synced_at = now()`,
        [r.id, r.created_at, r.updated_at, r.contact_email, r.total, r.items, JSON.stringify(r.products), r.channel, r.campaign, r.province],
      );
    }
  }
  return {
    // Trae los creados desde `sinceIso` (TN solo lista los que siguen abandonados).
    async syncSince(sinceIso) {
      let n = 0;
      for (let page = 1; page <= 50; page += 1) {
        const list = await tn.listCheckouts({ page, createdMin: sinceIso });
        if (!Array.isArray(list) || !list.length) break;
        const rows = list.filter((c) => !c.completed_at).map(mapCheckout);
        await upsert(rows);
        n += rows.length;
        if (list.length < 200) break;
      }
      return n;
    },
  };
}
