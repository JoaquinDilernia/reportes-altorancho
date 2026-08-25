import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatCurrency } from '../lib/format.js';
import { getChannelColor } from '../lib/channels.js';

function formatDayTick(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

export default function DailyChart({ data, channel, dataKey = 'revenue', title = 'Facturación por día', color }) {
  const resolvedColor = color || getChannelColor(channel);

  return (
    <div className="chart-card">
      <h3 className="chart-title">{title}</h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="date" tickFormatter={formatDayTick} stroke="var(--ink-secondary)" fontSize={12} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={(v) => formatCurrency(v)} width={90} />
          <Tooltip formatter={(value) => formatCurrency(value)} labelFormatter={formatDayTick} />
          <Bar dataKey={dataKey} fill={resolvedColor} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
