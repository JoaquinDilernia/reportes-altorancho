import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '../lib/format.js';

const DONUT_COLORS = ['#2A78D6', '#1BAF7A', '#EB6834', '#4A3AA7', '#008300', '#6B6968'];

export default function PaymentMethodsChart({ paymentMethods }) {
  return (
    <div className="chart-card">
      <h3 className="chart-title">Medios de pago</h3>
      {/* Vertical legend on the right instead of the default horizontal/
          bottom layout: with many payment methods the horizontal legend
          wraps to several rows and, at narrower card widths, overlaps the
          donut instead of pushing it up. A side legend scales with row
          count instead of colliding with the chart. */}
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={paymentMethods} dataKey="revenue" nameKey="method" cx="38%" cy="50%" innerRadius={55} outerRadius={80}>
            {paymentMethods.map((entry, i) => (
              <Cell key={entry.method} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => formatCurrency(value)} />
          <Legend layout="vertical" verticalAlign="middle" align="right" wrapperStyle={{ fontSize: 12, lineHeight: '20px' }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
