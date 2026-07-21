import { useState, useEffect } from 'react';
import { getReport } from '../api/client.js';
import { shiftPeriod } from '../lib/periods.js';
import PeriodSelector from '../components/PeriodSelector.jsx';
import ChannelTabs from '../components/ChannelTabs.jsx';
import KpiCards from '../components/KpiCards.jsx';
import DailyChart from '../components/DailyChart.jsx';
import TopProductsTable from '../components/TopProductsTable.jsx';
import CategoryBreakdown from '../components/CategoryBreakdown.jsx';
import PaymentMethodsChart from '../components/PaymentMethodsChart.jsx';
import ProvincesChart from '../components/ProvincesChart.jsx';
import LocalesPanel from '../components/LocalesPanel.jsx';
import MayoristaPanel from '../components/MayoristaPanel.jsx';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Dashboard({ onLogout }) {
  const [period, setPeriod] = useState('week');
  const [date, setDate] = useState(todayISO());
  const [channel, setChannel] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getReport({ period, date, channel })
      .then((data) => { if (!cancelled) setReport(data); })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, date, channel, onLogout]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <span className="logo">altorancho.</span>
        <PeriodSelector
          period={period}
          date={date}
          onPeriodChange={setPeriod}
          onNavigate={(direction) => setDate((prev) => shiftPeriod(prev, period, direction))}
        />
        <ChannelTabs channel={channel} onChannelChange={setChannel} />
      </header>

      {loading && <p className="status-text">Cargando...</p>}
      {error && <p className="status-text status-error">Error: {error}</p>}

      {report && !loading && (
        <main className="dashboard-body">
          <KpiCards current={report.current.totals} comparisons={report.comparisons} />
          <DailyChart data={report.current.dailyBreakdown} channel={channel} />
          <div className="dashboard-grid">
            <TopProductsTable
              byUnits={report.current.topProductsByUnits}
              byRevenue={report.current.topProductsByRevenue}
            />
            <CategoryBreakdown categories={report.current.categories} />
            <PaymentMethodsChart paymentMethods={report.current.paymentMethods} />
            {report.current.provinces.length > 0 && (
              <ProvincesChart provinces={report.current.provinces} />
            )}
          </div>
          {channel === null && (
            <div className="dashboard-grid">
              <LocalesPanel period={period} date={date} />
              <MayoristaPanel period={period} date={date} />
            </div>
          )}
        </main>
      )}
    </div>
  );
}
