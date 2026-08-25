import { useState } from 'react';
import { formatCurrency, formatNumber, formatRoas } from '../lib/format.js';
import { API_URL } from '../api/client.js';

function AdThumb({ adId, name }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="product-thumb"
      src={`${API_URL}/api/ad-image/${encodeURIComponent(adId)}`}
      alt=""
      loading="lazy"
      title={name}
      onError={() => setFailed(true)}
    />
  );
}

// Backend sends up to 50 ads (sorted by spend); each tab re-sorts that same
// list client-side rather than issuing a new request per view.
const RANKINGS = {
  spend: (ads) => [...ads].sort((a, b) => b.spend - a.spend),
  best: (ads) => [...ads].filter((a) => a.spend > 0).sort((a, b) => b.roas - a.roas),
  worst: (ads) => [...ads].filter((a) => a.spend > 0).sort((a, b) => a.roas - b.roas),
};

const TABS = [
  { key: 'spend', label: 'Más gasto' },
  { key: 'best', label: 'Mejores' },
  { key: 'worst', label: 'Peores' },
];

export default function TopAdsTable({ ads }) {
  const [ranking, setRanking] = useState('spend');
  const rows = RANKINGS[ranking](ads).slice(0, 10);

  return (
    <div className="table-card">
      <div className="table-header">
        <h3 className="chart-title">Top anuncios</h3>
        <div className="table-toggle">
          {TABS.map((tab) => (
            <button key={tab.key} className={ranking === tab.key ? 'active' : ''} onClick={() => setRanking(tab.key)}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="product-thumb-col"></th>
            <th className="product-col">Anuncio</th>
            <th className="campaign-col">Campaña</th>
            <th className="numeric-col">Gasto</th>
            <th className="numeric-col">Compras</th>
            <th className="numeric-col">Costo/compra</th>
            <th className="numeric-col">ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((ad) => (
            <tr key={ad.adId}>
              <td className="product-thumb-col">
                <AdThumb adId={ad.adId} name={ad.adName} />
              </td>
              <td className="product-col" title={ad.adName}>{ad.adName}</td>
              <td className="campaign-col" title={ad.campaignName}>{ad.campaignName}</td>
              <td className="numeric-col">{formatCurrency(ad.spend)}</td>
              <td className="numeric-col">{formatNumber(ad.purchases)}</td>
              <td className="numeric-col">{ad.purchases ? formatCurrency(ad.costPerPurchase) : '—'}</td>
              <td className="numeric-col">{formatRoas(ad.roas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
