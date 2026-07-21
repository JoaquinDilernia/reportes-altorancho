import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '../lib/format.js';

const DONUT_COLORS = ['#2A78D6', '#1BAF7A', '#EB6834', '#4A3AA7', '#008300', '#6B6968'];

export default function PaymentMethodsChart({ paymentMethods }) {
  return (
    <div className="chart-card">
      <h3 className="chart-title">Medios de pago</h3>
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={paymentMethods} dataKey="revenue" nameKey="method" innerRadius={60} outerRadius={90}>
            {paymentMethods.map((entry, i) => (
              <Cell key={entry.method} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => formatCurrency(value)} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
