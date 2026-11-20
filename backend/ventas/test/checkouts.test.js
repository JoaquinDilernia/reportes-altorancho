import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { mapCheckout, createCheckoutSync } from '../src/sync/checkouts.js';

const raw = (over = {}) => ({
  id: 9001, created_at: '2026-11-19T22:52:29+00:00', updated_at: '2026-11-19T23:00:00+00:00', completed_at: null,
  contact_email: ' Ana@X.com ', total: '919960.00', shipping_province: 'Capital Federal',
  customer_visit: { landing_page: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_campaign=dpa' },
  products: [{ product_id: 377141484, name: 'Silla Buenos Aires Azul', quantity: 4, price: '229990.00' }],
  ...over,
});

describe('checkouts abandonados', () => {
  it('mapea mail, productos y canal de la visita', () => {
    expect(mapCheckout(raw())).toMatchObject({
      id: 9001, contact_email: 'ana@x.com', total: 919960, items: 4, channel: 'meta', campaign: 'dpa', province: 'Capital Federal',
      products: [{ product_id: 377141484, name: 'Silla Buenos Aires Azul', quantity: 4, price: 229990 }],
    });
  });

  it('pagina, salta los completados y es idempotente', async () => {
    const db = await createTestDb();
    const pages = [[raw(), raw({ id: 9002, completed_at: '2026-11-19T23:10:00Z' })], []];
    const tn = { listCheckouts: async ({ page }) => pages[page - 1] || [] };
    const sync = createCheckoutSync({ tn, db });
    expect(await sync.syncSince('2026-11-16T00:00:00Z')).toBe(1);
    await sync.syncSince('2026-11-16T00:00:00Z');
    const { rows } = await db.query('SELECT id, channel FROM tn_checkouts');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(9001);
    expect(rows[0].channel).toBe('meta');
    await db.close();
  });
});
