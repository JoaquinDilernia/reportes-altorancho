const currencyFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('es-AR');

export function formatCurrency(amount) {
  return currencyFormatter.format(amount).replace(' ', ' ');
}

export function formatNumber(n) {
  return numberFormatter.format(n);
}

export function formatPercent(pct) {
  if (pct === null || pct === undefined) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
