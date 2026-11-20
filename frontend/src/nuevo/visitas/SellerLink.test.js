import { describe, it, expect } from 'vitest';
import { sellerUrl } from './SellerLink.jsx';

describe('sellerUrl', () => {
  it('agrega las UTMs de vendedor y normaliza el nombre', () => {
    expect(sellerUrl('https://altorancho.com/productos/silla/?variant=1', ' Lucía Pérez ')).toBe('https://altorancho.com/productos/silla/?variant=1&utm_source=vendedor&utm_medium=whatsapp&utm_campaign=lucia-perez');
    expect(sellerUrl('', 'Juan')).toBe('https://altorancho.com/?utm_source=vendedor&utm_medium=whatsapp&utm_campaign=juan');
  });
  it('sin vendedor o con link inválido no arma nada', () => {
    expect(sellerUrl('https://altorancho.com/', '')).toBeNull();
    expect(sellerUrl('no es un link', 'Juan')).toBeNull();
  });
});
