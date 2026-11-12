import { useCallback, useEffect, useState } from 'react';
import { getMayorista } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import DailyStacked from '../resumen/DailyStacked.jsx';
import { GROUPS } from '../resumen/ChannelsCard.jsx';
import TopModelsCard from '../producto/TopModelsCard.jsx';
import MayoristaKpis from './MayoristaKpis.jsx';
import FeriaTeamsCard from './FeriaTeamsCard.jsx';

const TITLE = { week: 'Mayorista de la semana', month: 'Mayorista del mes', custom: 'Mayorista del rango' };
const MAY_ONLY = GROUPS.filter(g => g.id === 'mayorista');
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando mayorista">
      <div className="nv-kpis">{[0, 1, 2, 3, 4].map(i => <div key={i} className="nv-card nv-skel-box" style={{ height: 110 }} />)}</div>
      <div className="nv-card nv-skel-box nv-sec" style={{ height: 260 }} />
    </div>
  );
}

export default function Mayorista({ state, onUpdate, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const { period, date, start, end } = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMayorista(periodParams({ period, date, start, end }))
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
        <b>No se pudo armar la pestaña Mayorista.</b>
        <p>{error}</p>
        <button type="button" className="nv-btn" onClick={retry}>Reintentar</button>
      </section>
    );
  }
  if (!data) return null;

  return (
    <div className="nv-mayorista">
      <div className="nv-titlebar">
        <div>
          <h1 className="nv-h1">{TITLE[period]}</h1>
          <div className="nv-sub">Pedidos de venta de Odoo (mayorista y ferias) · stock a hoy ({ddmm(data.stockAsOf)})</div>
        </div>
        <button type="button" className="nv-link" onClick={() => onUpdate({ tab: 'producto', ch: 'mayorista' }, { push: true })}>Ver categorías y origen →</button>
      </div>
      {data.prevRange.partial && (
        <div className="nv-running">Período en curso: todo se compara con los mismos días del período anterior y de {data.prevYear} (hasta el {ddmm(data.prevRange.end)}).</div>
      )}
      <MayoristaKpis summary={data.summary} period={period} prevYear={data.prevYear} prevRange={data.prevRange} />
      <div className="nv-grid2">
        <DailyStacked daily={data.daily} prevYear={data.prevYear} groups={MAY_ONLY} subtitle="mayorista y ferias" prevLabel={data.inflationAdjusted ? 'ajustado' : 'nominal'} />
        <FeriaTeamsCard sources={data.summary.sources} teams={data.feriaTeams} />
      </div>
      <TopModelsCard topModels={data.topModels} prevYear={data.prevYear} />
    </div>
  );
}
