import { useCallback, useEffect, useState } from 'react';
import { getWeb } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import WebSalesCard from './WebSalesCard.jsx';
import BehaviorKpis from './BehaviorKpis.jsx';
import FunnelCard from './FunnelCard.jsx';
import SourcesCard from './SourcesCard.jsx';
import SplitCard from './SplitCard.jsx';
import ViewedCategoriesCard from './ViewedCategoriesCard.jsx';
import ItemsCard from './ItemsCard.jsx';
import SearchesCard from './SearchesCard.jsx';
import EntryCard from './EntryCard.jsx';
import { DEVICES, VISITORS } from './webFormat.js';

const TITLE = { week: 'Web de la semana', month: 'Web del mes', custom: 'Web del rango' };

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando la web">
      <div className="nv-kpis nv-kpis4">{[0, 1, 2, 3].map(i => <div key={i} className="nv-card nv-skel-box" style={{ height: 110 }} />)}</div>
      <div className="nv-card nv-skel-box nv-sec" style={{ height: 260 }} />
      <p className="nv-note">Armando la pestaña… la primera vez de cada período puede tardar unos segundos (GA4).</p>
    </div>
  );
}

export default function Web({ state, onUpdate, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const { period, date, start, end } = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWeb(periodParams({ period, date, start, end }))
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
        <b>No se pudo armar la pestaña Web.</b>
        <p>{error}</p>
        <button type="button" className="nv-btn" onClick={retry}>Reintentar</button>
      </section>
    );
  }
  if (!data) return null;

  const b = data.behavior;
  return (
    <div className="nv-web">
      <h1 className="nv-h1">{TITLE[period]}</h1>
      <div className="nv-sub">Venta: Odoo · comportamiento: GA4 (tiene unas horas de demora) · experiencia: Clarity</div>

      <h2 className="nv-section">Venta web</h2>
      <WebSalesCard sales={data.sales} period={period} prevYear={data.prevYear} prevRange={data.prevRange} />

      <h2 className="nv-section">Comportamiento</h2>
      {!b && <section className="nv-card nv-sec"><p className="nv-empty">{data.behaviorError || 'GA4 no respondió'}: sin datos de comportamiento. La venta sigue siendo la de Odoo.</p></section>}
      {b && (
        <>
          <BehaviorKpis totals={b.totals} period={period} prevYear={data.prevYear} />
          <div className="nv-grid2">
            <FunnelCard funnel={b.funnel} period={period} />
            <div>
              <SplitCard title="Celular vs computadora" rows={b.devices} labels={DEVICES} />
              <SplitCard title="Nuevos vs ya conocían el sitio" rows={b.visitors} labels={VISITORS} />
            </div>
          </div>
          <SourcesCard channels={b.channels} siteConversion={b.totals.cur.conversion} period={period} />
          <div className="nv-grid2">
            <ViewedCategoriesCard categories={b.items.categories} matchedViewShare={b.items.matchedViewShare} />
            <SearchesCard searches={b.searches} />
          </div>
          <ItemsCard items={b.items} onOpenSku={openSku} />
          <EntryCard behavior={b} />
        </>
      )}
    </div>
  );
}
