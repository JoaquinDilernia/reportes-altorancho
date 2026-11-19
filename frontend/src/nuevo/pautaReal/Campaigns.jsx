import { useState } from 'react';
import { money } from '../format.js';
import { times } from './prFormat.js';
import { VerdictTag } from './Blocks.jsx';

const SORTS = {
  spend: { label: 'Más inversión', fn: (a, b) => b.spend - a.spend },
  worst: { label: 'Las que pierden', fn: (a, b) => a.profitAfterAds - b.profitAfterAds },
  best: { label: 'Las que más dejan', fn: (a, b) => b.profitAfterAds - a.profitAfterAds },
};

export default function Campaigns({ campaigns }) {
  const [platform, setPlatform] = useState('meta');
  const [sort, setSort] = useState('spend');
  const rows = [...(campaigns?.[platform] || [])].sort(SORTS[sort].fn);
  const label = platform === 'meta' ? 'Meta' : 'Google';
  return (
    <section className="nv-card nv-sec">
      <div className="nv-titlebar">
        <div className="nv-h"><h2>Campañas</h2><span>qué deja cada una, con las ventas que llegaron a la tienda</span></div>
        <div className="nv-pr-controls">
          <div className="nv-seg" role="tablist" aria-label="Plataforma">
            {['meta', 'google'].map((p) => (
              <button key={p} type="button" role="tab" aria-selected={platform === p} className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>{p === 'meta' ? 'Meta' : 'Google'}</button>
            ))}
          </div>
          <div className="nv-seg" aria-label="Orden">
            {Object.entries(SORTS).map(([k, s]) => (
              <button key={k} type="button" className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{s.label}</button>
            ))}
          </div>
        </div>
      </div>
      {!campaigns && <p className="nv-empty">Falta conectar la atribución por campaña.</p>}
      {campaigns && rows.length === 0 && <p className="nv-empty">Sin campañas con inversión en el período.</p>}
      {rows.length > 0 && (
        <div className="nv-tscroll">
          <table className="nv-table nv-pr-table">
            <thead>
              <tr>
                <th>Campaña</th>
                <th className="r">Inversión</th>
                <th className="r">Ventas</th>
                <th className="r">Facturó</th>
                <th className="r" title={`ROAS que informa ${label}`}>Dice {label}</th>
                <th className="r" title="Ventas que llegaron a la tienda / inversión">ROAS real</th>
                <th className="r" title="Ganancia de esas ventas / inversión">POAS</th>
                <th className="r">Neto</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="nv-adcell">
                      {c.thumbnail ? <img className="nv-adthumb" src={c.thumbnail} alt="" loading="lazy" /> : null}
                      <span className="nv-adtext"><span className="nv-name nv-ellip" title={c.name}>{c.name}</span>{c.status && c.status !== 'ACTIVE' && c.status !== 'ENABLED' && <span className="nv-mute">{c.status === 'PAUSED' ? 'pausada' : c.status.toLowerCase()}</span>}</span>
                    </div>
                  </td>
                  <td className="r">{money(c.spend)}</td>
                  <td className="r">{c.sales}</td>
                  <td className="r">{money(c.revenue)}</td>
                  <td className="r nv-mute">{times(c.reportedRoas)}</td>
                  <td className="r">{times(c.roas)}</td>
                  <td className="r"><b>{times(c.poas)}</b></td>
                  <td className={`r ${c.profitAfterAds < 0 ? 'nv-red' : ''}`}>{money(c.profitAfterAds)}</td>
                  <td><VerdictTag verdict={c.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="nv-note">Neto = ganancia bruta de sus ventas − inversión. Las ventas que llegaron con un clic de {label} pero sin campaña identificable no entran acá (sí en el total de arriba).</p>
    </section>
  );
}
