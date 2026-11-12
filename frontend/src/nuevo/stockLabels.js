// Odoo stock locations (stockByLoc keys, see backend/stockLocations.mjs).
// Rolón is the central depot: web, mayorista and Alcorta's reserve sit there.
// Each store has a small depot (stock) and what's on the floor (exhibición).
export const LOCATIONS = [
  ['rolon', 'Rolón · reserva'],
  ['mayorista', 'Rolón · mayorista'],
  ['alcorta_en_rolon', 'Rolón · de Alcorta'],
  ['web_odoo', 'Web (Odoo EC)'],
  ['lomas_stock', 'Lomas · depósito'],
  ['lomas_exhibicion', 'Lomas · exhibición'],
  ['belgrano_stock', 'Belgrano · depósito'],
  ['belgrano_exhibicion', 'Belgrano · exhibición'],
  ['alcorta_stock', 'Alcorta · depósito'],
  ['alcorta_exhibicion', 'Alcorta · exhibición'],
];

// For chips in tables.
export const LOC_SHORT = {
  rolon: 'Rolón', mayorista: 'Mayorista', alcorta_en_rolon: 'Alcorta en Rolón', web_odoo: 'Web Odoo',
  lomas_stock: 'Lomas', lomas_exhibicion: 'Lomas exhib.',
  belgrano_stock: 'Belgrano', belgrano_exhibicion: 'Belgrano exhib.',
  alcorta_stock: 'Alcorta', alcorta_exhibicion: 'Alcorta exhib.',
};

export const isExhibition = (key) => key.endsWith('_exhibicion');

// Products synced before stockByLoc existed only carry the old keys.
const LEGACY = {
  deposito: 'rolon', mayorista: 'mayorista', alcorta_en_rolon: 'alcorta_en_rolon', ecommerce_odoo: 'web_odoo',
  local_lomas: 'lomas_stock', local_belgrano: 'belgrano_stock', local_alcorta: 'alcorta_stock',
};
export function toStockByLoc({ stockByLoc, stockByLocation } = {}) {
  if (stockByLoc) return stockByLoc;
  const out = {};
  for (const [old, key] of Object.entries(LEGACY)) if (stockByLocation?.[old] != null) out[key] = stockByLocation[old];
  return out;
}

// Only real stock (Odoo has negatives from unadjusted moves), in depot order.
export function stockRows(locs) {
  return LOCATIONS.filter(([k]) => locs?.[k] > 0).map(([key, label]) => ({ key, label, units: locs[key] }));
}
