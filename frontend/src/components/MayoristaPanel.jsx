import { useState, useEffect } from 'react';
import { getReport } from '../api/client.js';
import { formatCurrency, formatNumber } from '../lib/format.js';
import { getChannelColor, getChannelLabel } from '../lib/channels.js';

export default function MayoristaPanel({ period, date, customStart, customEnd }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (period === 'custom' && customStart > customEnd) { setData(null); return; }
    let cancelled = false;
    setData(null);
    const base = period === 'custom' ? { period, start: customStart, end: customEnd } : { period, date };
    getReport({ ...base, channel: 'mayorista' })
      .then((result) => { if (!cancelled) setData(result); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [period, date, customStart, customEnd]);

  if (!data) return null;

  return (
    <div className="panel-card">
      <h3 className="chart-title">Mayorista</h3>
      <div className="panel-item" style={{ '--tab-color': getChannelColor('mayorista') }}>
        <div className="panel-item-label">{getChannelLabel('mayorista')}</div>
        <div className="panel-item-value">{formatCurrency(data.current.totals.revenue)}</div>
        <div className="panel-item-sub">{formatNumber(data.current.totals.orders)} ventas</div>
      </div>
    </div>
  );
}
