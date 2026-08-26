import { formatCurrency, formatNumber, formatRate, formatRoas } from './format.js';

export const META_ADS_METRICS = [
  { key: 'spend', label: 'Gasto', format: formatCurrency, inflationAdjustable: true },
  { key: 'purchases', label: 'Compras', format: formatNumber },
  { key: 'purchaseValue', label: 'Valor de compras', format: formatCurrency, inflationAdjustable: true },
  { key: 'roas', label: 'ROAS', format: formatRoas },
  { key: 'costPerPurchase', label: 'Costo por compra', format: formatCurrency, invert: true, inflationAdjustable: true },
  { key: 'impressions', label: 'Impresiones', format: formatNumber },
  { key: 'reach', label: 'Alcance (suma diaria)', format: formatNumber },
  { key: 'clicks', label: 'Clics', format: formatNumber },
  { key: 'ctr', label: 'CTR', format: formatRate },
  { key: 'cpc', label: 'CPC', format: formatCurrency, invert: true, inflationAdjustable: true },
  { key: 'addToCart', label: 'Agregados al carrito', format: formatNumber },
  { key: 'initiateCheckout', label: 'Checkouts iniciados', format: formatNumber },
  { key: 'landingPageViews', label: 'Vistas de landing', format: formatNumber },
];
