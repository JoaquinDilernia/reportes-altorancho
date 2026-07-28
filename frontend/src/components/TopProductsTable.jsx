import { useState } from 'react';
import { formatCurrency, formatNumber } from '../lib/format.js';
import { API_URL } from '../api/client.js';

const STOCK_LOCATION_LABELS = {
  local_lomas: 'Lomas',
  local_belgrano: 'Belgrano',
  local_alcorta: 'Alcorta',
  mayorista: 'Mayorista',
  ecommerce_odoo: 'Depósito web',
  deposito: 'Rolón',
};

function StockBreakdown({ stockByLocation }) {
  if (!stockByLocation) return null;
  const parts = Object.entries(stockByLocation)
    .filter(([, qty]) => qty > 0)
    .map(([loc, qty]) => `${STOCK_LOCATION_LABELS[loc] || loc}: ${formatNumber(Math.round(qty))}`);
  if (parts.length === 0) return null;
  return <div className="stock-breakdown">{parts.join(' · ')}</div>;
}

function ProductThumb({ sku, name }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="product-thumb"
      src={`${API_URL}/api/product-image/${encodeURIComponent(sku)}`}
      alt=""
      loading="lazy"
      title={name}
      onError={() => setFailed(true)}
    />
  );
}

export default function TopProductsTable({ byUnits, byRevenue }) {
  const [sortBy, setSortBy] = useState('units');
  const rows = sortBy === 'units' ? byUnits : byRevenue;

  return (
    <div className="table-card">
      <div className="table-header">
        <h3 className="chart-title">Top productos</h3>
        <div className="table-toggle">
          <button className={sortBy === 'units' ? 'active' : ''} onClick={() => setSortBy('units')}>Vendidos</button>
          <button className={sortBy === 'revenue' ? 'active' : ''} onClick={() => setSortBy('revenue')}>Facturación</button>
        </div>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="product-thumb-col"></th>
            <th className="sku-col">SKU</th>
            <th className="product-col">Producto</th>
            <th className="numeric-col">Vendidos</th>
            <th className="numeric-col">Facturación</th>
            <th className="stock-col">Stock</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.sku}>
              <td className="product-thumb-col">
                <ProductThumb sku={p.sku} name={p.name} />
              </td>
              <td className="sku-col">{p.sku}</td>
              <td className="product-col" title={p.name}>{p.nombreModeloAr || p.name}</td>
              <td className="numeric-col">{formatNumber(p.unitsSold)}</td>
              <td className="numeric-col">{formatCurrency(p.revenue)}</td>
              <td className="stock-col">
                {p.currentStock === null ? '—' : formatNumber(p.currentStock)}
                <StockBreakdown stockByLocation={p.stockByLocation} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
