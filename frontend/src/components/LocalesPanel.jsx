import { useState, useEffect } from 'react';
import { getReport } from '../api/client.js';
import { formatCurrency, formatNumber } from '../lib/format.js';
import { getChannelColor, getChannelLabel } from '../lib/channels.js';

const LOCAL_CHANNELS = ['local_lomas', 'local_belgrano', 'local_alcorta'];

export default function LocalesPanel({ period, date, customStart, customEnd }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (period === 'custom' && customStart > customEnd) { setData(null); return; }
    let cancelled = false;
    setData(null);
    const base = period === 'custom' ? { period, start: customStart, end: customEnd } : { period, date };
    Promise.all(LOCAL_CHANNELS.map((channel) => getReport({ ...base, channel })))
      .then((results) => { if (!cancelled) setData(results); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [period, date, customStart, customEnd]);

  if (!data) return null;

  return (
    <div className="panel-card">
      <h3 className="chart-title">Locales</h3>
      <div className="panel-grid">
        {LOCAL_CHANNELS.map((channel, i) => (
          <div className="panel-item" key={channel} style={{ '--tab-color': getChannelColor(channel) }}>
            <div className="panel-item-label">{getChannelLabel(channel)}</div>
            <div className="panel-item-value">{formatCurrency(data[i].current.totals.revenue)}</div>
            <div className="panel-item-sub">{formatNumber(data[i].current.totals.orders)} ventas</div>
          </div>
        ))}
      </div>
    </div>
  );
}
