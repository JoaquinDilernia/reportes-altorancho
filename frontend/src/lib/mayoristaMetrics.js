import { formatCurrency, formatRate } from './format.js';

// Mayorista-only: orders get confirmed (and counted in "Facturación") well
// before they're actually invoiced and paid, so these two extra cards show
// how much of that facturación has actually been collected.
export const MAYORISTA_EXTRA_METRICS = [
  { key: 'amountCollected', label: 'Total cobrado', format: formatCurrency },
  { key: 'collectionRate', label: '% cobrado', format: formatRate },
];
