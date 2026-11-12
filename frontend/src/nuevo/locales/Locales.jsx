import { useCallback, useEffect, useState } from 'react';
import { getLocales } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import DailyStacked from '../resumen/DailyStacked.jsx';
import CompareCards from './CompareCards.jsx';
import HoursCard from './HoursCard.jsx';
import LocalDetail from './LocalDetail.jsx';
import { STORES } from './stores.js';

const TITLE = { week: 'Locales de la semana', month: 'Locales del mes', custom: 'Locales del rango' };
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando locales">
      <div className="nv-locs">{[0, 1, 2, 3].map(i => <div key={i} className="nv-card nv-skel-box" style={{ height: 220 }} />)}</div>
      <div className="nv-card nv-skel-box nv-sec" style={{ height: 260 }} />
    </div>
  );
}

export default function Locales({ state, onUpdate, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const { period, date, start, end, loc } = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getLocales(periodParams({ period, date, start, end }))
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
  const openSku = (sku) => onUpdate({ sku }, { push: true });

  if (loading) return <><h1 className="nv-h1">{TITLE[period]}</h1><Skeleton /></>;
  if (error) {
    return (
      <section className="nv-card nv-error">
        <b>No se pudo armar la pestaña Locales.</b>
        <p>{error}</p>
        <button type="button" className="nv-btn" onClick={retry}>Reintentar</button>
      </section>
    );
  }
  if (!data) return null;

  return (
    <div className="nv-locales">
      <h1 className="nv-h1">{TITLE[period]}</h1>
      <div className="nv-sub">Ventas del POS (Odoo), con IVA · stock a hoy ({ddmm(data.stockAsOf)})</div>
      {data.prevRange.partial && (
        <div className="nv-running">Período en curso: todo se compara con los mismos días del período anterior y de {data.prevYear} (hasta el {ddmm(data.prevRange.end)}).</div>
      )}
      <CompareCards compare={data.compare} period={period} prevYear={data.prevYear} prevRange={data.prevRange} />
      <DailyStacked daily={data.daily} prevYear={data.prevYear} groups={STORES} subtitle="apilado por local" prevLabel={data.inflationAdjusted ? 'ajustado' : 'nominal'} />
      <HoursCard hours={data.hours} />
      <LocalDetail data={data} loc={loc} onUpdate={onUpdate} onOpenSku={openSku} />
    </div>
  );
}
