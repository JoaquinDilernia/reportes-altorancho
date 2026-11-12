import { useCallback, useEffect, useState } from 'react';
import { getResumen } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import KpiStrip from './KpiStrip.jsx';
import AlertsCard from './AlertsCard.jsx';
import ChannelsCard from './ChannelsCard.jsx';
import DailyStacked from './DailyStacked.jsx';

const TITLE = { week: 'Resumen de la semana', month: 'Resumen del mes', custom: 'Resumen del rango' };

function Skeleton() {
  return (
    <div className="nv-skel" aria-busy="true" aria-label="Cargando el resumen">
      <div className="nv-kpis">{[0, 1, 2, 3, 4].map(i => <div key={i} className="nv-card nv-skel-box" style={{ height: 132 }} />)}</div>
      <div className="nv-grid2">
        <div className="nv-card nv-skel-box" style={{ height: 300 }} />
        <div className="nv-card nv-skel-box" style={{ height: 300 }} />
      </div>
      <p className="nv-note">Armando el resumen… la primera vez de cada período puede tardar hasta un minuto.</p>
    </div>
  );
}

export default function Resumen({ state, onNavigate, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const { period, date, start, end } = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getResumen(periodParams({ period, date, start, end }))
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout?.();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, date, start, end, attempt, onLogout]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  if (loading) return <><h1 className="nv-h1">{TITLE[period]}</h1><Skeleton /></>;
  if (error) {
    return (
      <section className="nv-card nv-error">
        <b>No se pudo armar el resumen.</b>
        <p>{error}</p>
        <button type="button" className="nv-btn" onClick={retry}>Reintentar</button>
      </section>
    );
  }
  if (!data) return null;

  const prevYear = Number(data.ranges.prevYear.start.slice(0, 4));
  const stockDay = data.stockAsOf.split('-').reverse().slice(0, 2).join('/');
  return (
    <div className="nv-resumen">
      <h1 className="nv-h1">{TITLE[period]}</h1>
      <div className="nv-sub">
        Todos los canales · stock a hoy ({stockDay})
        {!data.sources.ga4 && <span className="nv-warn-note"> · GA4 no respondió: sin conversión ni alertas web</span>}
      </div>
      <KpiStrip kpis={data.kpis} period={period} prevYear={prevYear} />
      <div className="nv-grid2">
        <AlertsCard alerts={data.alerts} period={period} onNavigate={onNavigate} />
        <ChannelsCard channels={data.channels} period={period} />
      </div>
      <DailyStacked daily={data.daily} prevYear={prevYear} />
    </div>
  );
}
