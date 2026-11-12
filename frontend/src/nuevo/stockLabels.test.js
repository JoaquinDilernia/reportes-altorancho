import { describe, it, expect } from 'vitest';
import { stockRows, toStockByLoc, LOC_SHORT } from './stockLabels.js';

describe('stockLabels', () => {
  it('lists positive stock in depot order, Rolón first, exhibition after the store depot', () => {
    const rows = stockRows({ lomas_exhibicion: 3, rolon: 5, lomas_stock: 6, belgrano_exhibicion: 0, mayorista: -2, web_odoo: 20 });
    expect(rows.map(r => r.key)).toEqual(['rolon', 'web_odoo', 'lomas_stock', 'lomas_exhibicion']);
    expect(rows[0]).toEqual({ key: 'rolon', label: 'Rolón · reserva', units: 5 });
  });

  it('falls back to the old stockByLocation keys', () => {
    expect(toStockByLoc({ stockByLoc: null, stockByLocation: { deposito: 2, local_lomas: 1, ecommerce_odoo: 4 } }))
      .toEqual({ rolon: 2, lomas_stock: 1, web_odoo: 4 });
    expect(toStockByLoc({ stockByLoc: { rolon: 1 }, stockByLocation: { deposito: 9 } })).toEqual({ rolon: 1 });
    expect(toStockByLoc({})).toEqual({});
  });

  it('has a short label for every location', () => {
    for (const k of ['rolon', 'mayorista', 'alcorta_en_rolon', 'lomas_stock', 'lomas_exhibicion', 'belgrano_stock', 'belgrano_exhibicion', 'alcorta_stock', 'alcorta_exhibicion']) {
      expect(LOC_SHORT[k]).toBeTruthy();
    }
  });
});
