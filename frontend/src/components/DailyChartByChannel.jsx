import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatCurrency } from '../lib/format.js';
import { CHANNELS } from '../lib/channels.js';

function formatDayTick(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

export default function DailyChartByChannel({ data }) {
  return (
    <div className="chart-card">
      <h3 className="chart-title">Facturación por día y canal</h3>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="date" tickFormatter={formatDayTick} stroke="var(--ink-secondary)" fontSize={12} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={(v) => formatCurrency(v)} width={90} />
          <Tooltip formatter={(value) => formatCurrency(value)} labelFormatter={formatDayTick} />
          <Legend />
          {CHANNELS.map((ch) => (
            <Bar key={ch.id} dataKey={ch.id} name={ch.label} fill={ch.color} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
