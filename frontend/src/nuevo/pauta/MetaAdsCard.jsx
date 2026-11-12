import { useState } from 'react';
import { API_URL } from '../../api/client.js';
import { money, num } from '../format.js';
import { roasText } from './AdsBlocks.jsx';

const VIEWS = [['spend', 'Más gasto'], ['best', 'Mejores'], ['worst', 'Peores']];

function Thumb({ adId }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="nv-adthumb" aria-hidden="true" />;
  return <img className="nv-adthumb" src={`${API_URL}/api/ad-image/${encodeURIComponent(adId)}`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export default function MetaAdsCard({ ads }) {
  const [view, setView] = useState('spend');
  const rows = ads[view] ?? [];
  return (
    <section className="nv-card nv-sec">
      <div className="nv-titlebar">
        <div className="nv-h"><h2>Anuncios de Meta</h2><span>del período</span></div>
        <div className="nv-seg" role="group" aria-label="Orden de anuncios">
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" className={view === id ? 'on' : ''} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? <p className="nv-empty">Sin anuncios con inversión en el período.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table">
            <thead><tr><th>Anuncio</th><th className="r">Inversión</th><th className="r">Compras</th><th className="r">Valor</th><th className="r">ROAS</th><th className="r">Costo/compra</th></tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.adId}>
                  <td>
                    <span className="nv-adcell">
                      <Thumb adId={a.adId} />
                      <span className="nv-adtext"><b className="nv-name nv-ellip nv-block" title={a.adName}>{a.adName}</b><span className="nv-mute nv-ellip nv-block" title={a.campaignName}>{a.campaignName}</span></span>
                    </span>
                  </td>
                  <td className="r">{money(a.spend)}</td>
                  <td className="r">{num(a.purchases)}</td>
                  <td className="r">{money(a.value)}</td>
                  <td className={`r${a.roas != null && a.roas < 1 ? ' nv-red' : ''}`}>{roasText(a.roas)}</td>
                  <td className="r">{money(a.costPerPurchase)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="nv-note">Mejores y peores: solo anuncios con al menos el 1% de la inversión del período. ROAS en rojo: devuelve menos de lo que cuesta.</div>
    </section>
  );
}
