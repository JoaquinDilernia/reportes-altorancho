import { useCallback, useEffect, useState } from 'react';
import { getPautaReal, getPautaClientes } from '../../api/client.js';
import Customers from './Customers.jsx';
import { periodParams } from '../urlState.js';
import Pauta from '../pauta/Pauta.jsx';
import { Headline, TruthCard, Sources, ProfitDaily, Glossary } from './Blocks.jsx';
import Campaigns from './Campaigns.jsx';

const TITLE = { week: '¿Cuánto deja la pauta esta semana?', month: '¿Cuánto deja la pauta este mes?', custom: '¿Cuánto dejó la pauta en el rango?' };

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando pauta">
      <div className="nv-card nv-skel-box nv-sec" style={{ height: 250 }} />
      <div className="nv-pr-truths">{[0, 1].map((i) => <div key={i} className="nv-card nv-skel-box" style={{ height: 260 }} />)}</div>
      <p className="nv-note">Cruzando ventas, costos de Odoo y atribución de cada pedido… la primera vez de cada período tarda unos segundos.</p>
    </div>
  );
}

export default function PautaReal({ state, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [showPlatforms, setShowPlatforms] = useState(false);
  const { period, date, start, end } = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPautaReal(periodParams({ period, date, start, end }))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout?.();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, date, start, end, attempt, onLogout]);

  // Clientes nuevos vs. recurrentes: aparte, cuando el tablero ya cargó (tarda más).
  const [cust, setCust] = useState({ data: null, error: null, loading: false });
  useEffect(() => {
    if (!data) return undefined;
    let cancelled = false;
    setCust({ data: null, error: null, loading: true });
    getPautaClientes(periodParams({ period, date, start, end }))
      .then((d) => { if (!cancelled) setCust({ data: d, error: null, loading: false }); })
      .catch((err) => { if (!cancelled) setCust({ data: null, error: err.message, loading: false }); });
    return () => { cancelled = true; };
  }, [data, period, date, start, end]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  if (loading) return <><h1 className="nv-h1">{TITLE[period]}</h1><Skeleton /></>;
  if (error) {
    return (
      <section className="nv-card nv-error">
        <b>No se pudo armar el tablero de Pauta.</b>
        <p>{error}</p>
        <button type="button" className="nv-btn" onClick={retry}>Reintentar</button>
      </section>
    );
  }
  if (!data) return null;
  const { headline, platforms, platformSpend, errors } = data;
  const lowCost = headline.costCoverage != null && headline.costCoverage < 0.9;

  return (
    <div className="nv-pauta nv-pr">
      <h1 className="nv-h1">{TITLE[period]}</h1>
      <div className="nv-sub">Ventas reales de la tienda y los locales, costo de cada producto en Odoo y la inversión de Meta y Google.</div>
      {(errors.attribution || errors.costs || lowCost) && (
        <div className="nv-running nv-pr-warn">
          {errors.costs || (lowCost && `Solo el ${Math.round(headline.costCoverage * 100)}% de lo vendido tiene costo cargado en Odoo: el resto se estimó con el margen promedio.`)}
          {(errors.costs || lowCost) && errors.attribution && ' · '}
          {errors.attribution}
        </div>
      )}
      <Headline h={headline} period={period} />

      <h2 className="nv-section">Lo que dicen las plataformas vs. lo que pasó</h2>
      <div className="nv-pr-truths">
        <TruthCard id="meta" p={platforms?.meta} reported={platformSpend.meta} />
        <TruthCard id="google" p={platforms?.google} reported={platformSpend.google} />
      </div>

      <ProfitDaily rows={data.daily} />
      {platforms ? (
        <div className="nv-grid2 nv-pr-grid">
          <Sources rows={data.sources} />
          <Glossary />
        </div>
      ) : <Glossary />}
      <Customers {...cust} />
      <Campaigns campaigns={data.campaigns} newByCampaign={cust.data?.campaigns} />

      <h2 className="nv-section">
        <button type="button" className="nv-link nv-pr-toggle" aria-expanded={showPlatforms} onClick={() => setShowPlatforms((s) => !s)}>
          {showPlatforms ? '▾' : '▸'} Detalle por plataforma (números de Meta y Google)
        </button>
      </h2>
      {showPlatforms && <Pauta state={state} onLogout={onLogout} embedded />}
    </div>
  );
}
