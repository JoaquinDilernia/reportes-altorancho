import { useState, useEffect } from 'react';
import { getReport } from '../api/client.js';
import { shiftPeriod } from '../lib/periods.js';
import PeriodSelector from '../components/PeriodSelector.jsx';
import ChannelTabs from '../components/ChannelTabs.jsx';
import KpiCards, { SALES_METRICS } from '../components/KpiCards.jsx';
import DailyChart from '../components/DailyChart.jsx';
import DailyChartByChannel from '../components/DailyChartByChannel.jsx';
import TopProductsTable from '../components/TopProductsTable.jsx';
import CategoryBreakdown from '../components/CategoryBreakdown.jsx';
import PaymentMethodsChart from '../components/PaymentMethodsChart.jsx';
import ProvincesChart from '../components/ProvincesChart.jsx';
import LocalesPanel from '../components/LocalesPanel.jsx';
import MayoristaPanel from '../components/MayoristaPanel.jsx';
import TopAdsTable from '../components/TopAdsTable.jsx';
import InsightsButton from '../components/InsightsButton.jsx';
import ChatWidget from '../components/ChatWidget.jsx';
import { META_ADS_METRICS } from '../lib/metaAdsMetrics.js';
import { MAYORISTA_EXTRA_METRICS } from '../lib/mayoristaMetrics.js';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Joins the sales daily series (revenue) and the Meta Ads daily series
// (spend) by date so the Meta Ads chart can show both bars side by side —
// the two series come from separate backend sections and don't share rows.
function mergeDailyRevenueAndSpend(salesDaily, adsDaily) {
  const byDate = new Map();
  for (const row of salesDaily) byDate.set(row.date, { date: row.date, revenue: row.revenue, spend: 0 });
  for (const row of adsDaily) {
    if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date, revenue: 0, spend: 0 });
    byDate.get(row.date).spend = row.spend;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export default function Dashboard({ onLogout }) {
  const [period, setPeriod] = useState('week');
  const [date, setDate] = useState(todayISO());
  const [customStart, setCustomStart] = useState(todayISO());
  const [customEnd, setCustomEnd] = useState(todayISO());
  const [channel, setChannel] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const rangeInvalid = period === 'custom' && customStart > customEnd;
  // "Meta Ads" is a dashboard tab, not a real sales channel — it has no
  // effect on the /api/report channels filter (metaAds data is account-wide
  // and comes back regardless of which channel was requested).
  const apiChannel = channel === 'meta_ads' ? null : channel;
  const salesMetrics = apiChannel === 'mayorista' ? [...SALES_METRICS, ...MAYORISTA_EXTRA_METRICS] : SALES_METRICS;

  useEffect(() => {
    if (rangeInvalid) {
      setLoading(false);
      setError('El rango de fechas es inválido');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = period === 'custom'
      ? { period, start: customStart, end: customEnd, channel: apiChannel }
      : { period, date, channel: apiChannel };
    getReport(params)
      .then((data) => { if (!cancelled) setReport(data); })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, date, customStart, customEnd, rangeInvalid, channel, onLogout]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <span className="logo">altorancho.</span>
        <PeriodSelector
          period={period}
          date={date}
          onPeriodChange={setPeriod}
          onNavigate={(direction) => setDate((prev) => shiftPeriod(prev, period, direction))}
          customStart={customStart}
          customEnd={customEnd}
          onCustomChange={(start, end) => { setCustomStart(start); setCustomEnd(end); }}
        />
        <ChannelTabs channel={channel} onChannelChange={setChannel} />
      </header>

      <InsightsButton period={period} date={date} customStart={customStart} customEnd={customEnd} channel={apiChannel} />

      {loading && <p className="status-text">Cargando...</p>}
      {error && <p className="status-text status-error">Error: {error}</p>}

      {report && !loading && channel === 'meta_ads' && report.current.metaAds && (
        <main className="dashboard-body">
          <KpiCards
            current={report.current.metaAds.totals}
            comparisons={report.comparisons}
            metrics={META_ADS_METRICS}
            deltasKey="metaAdsDeltas"
          />
          <DailyChart
            data={mergeDailyRevenueAndSpend(report.current.dailyBreakdown, report.current.metaAds.dailyBreakdown)}
            dataKey="spend"
            label="Gasto en Meta Ads"
            title="Gasto en Meta Ads vs. facturación por día"
            color="#1877F2"
            secondaryDataKey="revenue"
            secondaryLabel="Facturación"
            secondaryColor="#1BAF7A"
          />
          <TopAdsTable ads={report.current.metaAds.topAds} />
        </main>
      )}

      {report && !loading && channel !== 'meta_ads' && (
        <main className="dashboard-body">
          <KpiCards current={report.current.totals} comparisons={report.comparisons} metrics={salesMetrics} />
          <DailyChart
            data={report.current.dailyBreakdown}
            channel={apiChannel}
            secondaryDataKey="orders"
            secondaryLabel="Cantidad de ventas"
            secondaryColor="#2A78D6"
            secondaryAxis
          />
          {apiChannel === null && (
            <DailyChartByChannel data={report.current.dailyBreakdownByChannel} />
          )}
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
          {apiChannel === null && (
            <div className="dashboard-grid">
              <LocalesPanel period={period} date={date} customStart={customStart} customEnd={customEnd} />
              <MayoristaPanel period={period} date={date} customStart={customStart} customEnd={customEnd} />
            </div>
          )}
        </main>
      )}

      <ChatWidget period={period} date={date} customStart={customStart} customEnd={customEnd} channel={apiChannel} />
    </div>
  );
}
