import { useState } from 'react';
import { formatCurrency, formatNumber } from '../lib/format.js';

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
            <th>Producto</th>
            <th>Vendidos</th>
            <th>Facturación</th>
            <th>Stock</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.sku}>
              <td>{p.name}</td>
              <td>{formatNumber(p.unitsSold)}</td>
              <td>{formatCurrency(p.revenue)}</td>
              <td>
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
