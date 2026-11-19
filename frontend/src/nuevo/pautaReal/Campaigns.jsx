import { useState } from 'react';
import { money } from '../format.js';
import { times } from './prFormat.js';
import { VerdictTag } from './Blocks.jsx';

// "…" mientras se calcula; "—" si la campaña no tuvo ventas con cliente identificado
function newPctOf(byCampaign, platform, id) {
  if (!byCampaign) return '…';
  const v = byCampaign[platform]?.[id]?.newPct;
  return v == null ? '—' : `${v}%`;
}

const SORTS = {
  spend: { label: 'Más inversión', fn: (a, b) => b.spend - a.spend },
  worst: { label: 'Las que pierden', fn: (a, b) => a.profitAfterAds - b.profitAfterAds },
  best: { label: 'Las que más dejan', fn: (a, b) => b.profitAfterAds - a.profitAfterAds },
};

export default function Campaigns({ campaigns, newByCampaign }) {
  const [platform, setPlatform] = useState('meta');
  const [sort, setSort] = useState('spend');
  const rows = [...(campaigns?.[platform]?.rows || [])].sort(SORTS[sort].fn);
  const unidentified = campaigns?.[platform]?.unidentified;
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
                <th className="r" title="De sus ventas, cuántas fueron la primera compra del cliente">% nuevos</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const unknown = c.verdict === 'sin-dato';
                return (
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
                  <td className="r">{unknown ? '—' : times(c.roas)}</td>
                  <td className="r"><b>{unknown ? '—' : times(c.poas)}</b></td>
                  <td className={`r ${!unknown && c.profitAfterAds < 0 ? 'nv-red' : ''}`}>{unknown ? '—' : money(c.profitAfterAds)}</td>
                  <td className="r nv-mute">{newPctOf(newByCampaign, platform, c.id)}</td>
                  <td><VerdictTag verdict={c.verdict} /></td>
                </tr>
                );
              })}
              {unidentified && (
                <tr className="nv-pr-unid">
                  <td>
                    <span className="nv-adtext">
                      <span className="nv-name">Sin campaña identificada</span>
                      <span className="nv-mute">clic de {label} sin el ID de la campaña{platform === 'google' ? ' (suele ser Performance Max)' : ''}</span>
                    </span>
                  </td>
                  <td className="r nv-mute">—</td>
                  <td className="r">{unidentified.sales}</td>
                  <td className="r">{money(unidentified.revenue)}</td>
                  <td className="r nv-mute">—</td>
                  <td className="r nv-mute">—</td>
                  <td className="r nv-mute">—</td>
                  <td className="r">{money(unidentified.grossProfit)}</td>
                  <td />
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="nv-note">Neto = ganancia bruta de sus ventas − inversión. “Sin dato”: gastó y no tiene ventas con su ID, pero puede tenerlas entre las ventas sin campaña identificada (en esa fila, Neto es la ganancia bruta, sin descontar inversión).</p>
    </section>
  );
}
