import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { formatNumber } from '../lib/format.js';

export default function ProvincesChart({ provinces }) {
  const top5 = provinces.slice(0, 5);

  return (
    <div className="chart-card">
      <h3 className="chart-title">Top provincias</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={top5} layout="vertical" margin={{ left: 24 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="province" stroke="var(--ink-secondary)" fontSize={12} width={110} />
          <Tooltip formatter={(value) => formatNumber(value)} />
          <Bar dataKey="orders" fill="#1BAF7A" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
