import { useCallback, useEffect, useState } from 'react';
import { getPauta } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import AdsBlocks from './AdsBlocks.jsx';
import AdsDaily from './AdsDaily.jsx';
import MetaAdsCard from './MetaAdsCard.jsx';
import GoogleCampaignsCard from './GoogleCampaignsCard.jsx';

const TITLE = { week: 'Pauta de la semana', month: 'Pauta del mes', custom: 'Pauta del rango' };
const ddmm = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando pauta">
      <div className="nv-locs nv-ads3">{[0, 1, 2].map(i => <div key={i} className="nv-card nv-skel-box" style={{ height: 230 }} />)}</div>
      <div className="nv-card nv-skel-box nv-sec" style={{ height: 240 }} />
      <p className="nv-note">Armando la pestaña… la primera vez de cada período puede tardar unos segundos (Google Ads y GA4).</p>
    </div>
  );
}

export default function Pauta({ state, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const { period, date, start, end } = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPauta(periodParams({ period, date, start, end }))
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
        <b>No se pudo armar la pestaña Pauta.</b>
        <p>{error}</p>
        <button type="button" className="nv-btn" onClick={retry}>Reintentar</button>
      </section>
    );
  }
  if (!data) return null;

  return (
    <div className="nv-pauta">
      <h1 className="nv-h1">{TITLE[period]}</h1>
      <div className="nv-sub">Meta: compras a 1 día del clic · Google: ventas de GA4 de google / cpc. El ROAS de Google incluye la búsqueda de marca.</div>
      {data.prevRange.partial && (
        <div className="nv-running">Período en curso: todo se compara con los mismos días del período anterior y de {data.prevYear} (hasta el {ddmm(data.prevRange.end)}).</div>
      )}
      <AdsBlocks summary={data.summary} period={period} prevYear={data.prevYear} prevRange={data.prevRange} />
      <AdsDaily daily={data.daily} />
      <MetaAdsCard ads={data.ads} />
      <GoogleCampaignsCard campaigns={data.campaigns} error={data.campaignsError} />
    </div>
  );
}
