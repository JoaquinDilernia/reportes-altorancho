const currencyFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('es-AR');

export function formatCurrency(amount) {
  // Intl.NumberFormat inserts a non-breaking space between the currency
  // symbol and the amount (ICU currency-spacing) — normalize to a regular
  // space so it matches the rest of the UI's typography.
  return currencyFormatter.format(amount).replace(/\u00A0/g, ' ');
}

export function formatNumber(n) {
  return numberFormatter.format(n);
}

export function formatPercent(pct) {
  if (pct === null || pct === undefined) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatRate(pct) {
  if (pct === null || pct === undefined) return '—';
  return `${pct.toFixed(1)}%`;
}

export function formatRoas(value) {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}x`;
}
