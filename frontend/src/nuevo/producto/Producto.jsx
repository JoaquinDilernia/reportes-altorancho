import { useCallback, useEffect, useState } from 'react';
import { getProducto } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import PasarALaWeb from './PasarALaWeb.jsx';
import CategoriesCard from './CategoriesCard.jsx';
import OriginsCard from './OriginsCard.jsx';
import TopModelsCard from './TopModelsCard.jsx';
import OverstockCard from './OverstockCard.jsx';
import WarehousesCard from './WarehousesCard.jsx';

const CHANNELS = [['all', 'Todos'], ['web', 'Web'], ['locales', 'Locales'], ['mayorista', 'Mayorista']];
const CH_NOTE = { all: 'todos los canales', web: 'solo web', locales: 'solo locales', mayorista: 'mayorista y ferias' };

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando productos">
      <div className="nv-card nv-skel-box nv-sec" style={{ height: 280 }} />
      <div className="nv-grid2">
        <div className="nv-card nv-skel-box" style={{ height: 320 }} />
        <div className="nv-card nv-skel-box" style={{ height: 320 }} />
      </div>
      <p className="nv-note">Armando la pestaña… la primera vez de cada período puede tardar un poco.</p>
    </div>
  );
}

export default function Producto({ state, onUpdate, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const { period, date, start, end, ch } = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProducto({ ...periodParams({ period, date, start, end }), ch })
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout?.();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, date, start, end, ch, attempt, onLogout]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);
  const openSku = (sku) => onUpdate({ sku }, { push: true });

  const filter = (
    <div className="nv-seg" role="group" aria-label="Canal">
      {CHANNELS.map(([id, label]) => (
        <button key={id} type="button" className={ch === id ? 'on' : ''} aria-pressed={ch === id} onClick={() => onUpdate({ ch: id })}>{label}</button>
      ))}
    </div>
  );

  let body;
  if (loading) body = <Skeleton />;
  else if (error) {
    body = (
      <section className="nv-card nv-error">
        <b>No se pudo armar la pestaña Producto.</b>
        <p>{error}</p>
        <button type="button" className="nv-btn" onClick={retry}>Reintentar</button>
      </section>
    );
  } else if (data) {
    body = (
      <>
        <PasarALaWeb coverage={data.coverage} onOpenSku={openSku} />
        <div className="nv-grid2">
          <CategoriesCard categories={data.categories} prevYear={data.prevYear} adjusted={data.inflationAdjusted} />
          <OriginsCard origins={data.origins} prevYear={data.prevYear} adjusted={data.inflationAdjusted} />
        </div>
        <TopModelsCard topModels={data.topModels} prevYear={data.prevYear} />
        <div className="nv-grid2">
          <OverstockCard overstock={data.overstock} onOpenSku={openSku} />
          <WarehousesCard warehouses={data.warehouses} />
        </div>
      </>
    );
  }

  return (
    <div className="nv-producto">
      <div className="nv-titlebar">
        <div>
          <h1 className="nv-h1">Producto y stock</h1>
          <div className="nv-sub">Ventas: {CH_NOTE[ch]} · stock a hoy{data ? ` (${data.stockAsOf.split('-').reverse().slice(0, 2).join('/')})` : ''}
            {data?.prevRange?.partial && ` · período en curso: se compara con ${data.prevYear} hasta el ${data.prevRange.end.split('-').reverse().slice(0, 2).join('/')}`}</div>
        </div>
        {filter}
      </div>
      {body}
    </div>
  );
}
