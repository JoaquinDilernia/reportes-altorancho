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

export default function TopAdsTable({ ads }) {
  return (
    <div className="table-card">
      <div className="table-header">
        <h3 className="chart-title">Top anuncios</h3>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="product-thumb-col"></th>
            <th className="product-col">Anuncio</th>
            <th className="product-col">Campaña</th>
            <th className="numeric-col">Gasto</th>
            <th className="numeric-col">Compras</th>
            <th className="numeric-col">ROAS</th>
          </tr>
        </thead>
        <tbody>
          {ads.map((ad) => (
            <tr key={ad.adId}>
              <td className="product-thumb-col">
                <AdThumb adId={ad.adId} name={ad.adName} />
              </td>
              <td className="product-col" title={ad.adName}>{ad.adName}</td>
              <td className="product-col" title={ad.campaignName}>{ad.campaignName}</td>
              <td className="numeric-col">{formatCurrency(ad.spend)}</td>
              <td className="numeric-col">{formatNumber(ad.purchases)}</td>
              <td className="numeric-col">{formatRoas(ad.roas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
