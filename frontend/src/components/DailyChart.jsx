import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatCurrency } from '../lib/format.js';
import { getChannelColor } from '../lib/channels.js';

function formatDayTick(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

export default function DailyChart({
  data, channel, dataKey = 'revenue', title = 'Facturación por día', color, label,
  secondaryDataKey, secondaryLabel, secondaryColor,
}) {
  const resolvedColor = color || getChannelColor(channel);
  const hasSecondary = Boolean(secondaryDataKey);

  return (
    <div className="chart-card">
      <h3 className="chart-title">{title}</h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis dataKey="date" tickFormatter={formatDayTick} stroke="var(--ink-secondary)" fontSize={12} />
          <YAxis stroke="var(--ink-secondary)" fontSize={12} tickFormatter={(v) => formatCurrency(v)} width={90} />
          <Tooltip formatter={(value) => formatCurrency(value)} labelFormatter={formatDayTick} />
          {hasSecondary && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <Bar dataKey={dataKey} name={label || title} fill={resolvedColor} radius={[4, 4, 0, 0]} />
          {hasSecondary && (
            <Bar dataKey={secondaryDataKey} name={secondaryLabel} fill={secondaryColor} radius={[4, 4, 0, 0]} />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
