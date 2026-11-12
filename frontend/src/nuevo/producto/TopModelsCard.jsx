import { useState } from 'react';
import { money, num, pct, toneOf } from '../format.js';
import { LOC_SHORT, isExhibition } from '../stockLabels.js';

const SHOW = 15;
const delta = (cur, prev) => (prev > 0 ? ((cur / prev) - 1) * 100 : null);

export default function TopModelsCard({ topModels, prevYear }) {
  const [all, setAll] = useState(false);
  const rows = all ? topModels : topModels.slice(0, SHOW);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Más vendidos por modelo</h2><span>todos los colores juntos · stock a hoy</span></div>
      {topModels.length === 0 ? <p className="nv-empty">Sin ventas en el período.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table">
            <thead>
              <tr>
                <th>#</th><th>Modelo</th><th className="r">Unid.</th><th className="r">Facturación</th><th className="r">vs. {prevYear}</th>
                <th className="r">Stock web</th><th className="r">Stock total</th><th>Resto del stock</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => {
                const d = delta(m.revenue, m.prevRevenueToDateAdj);
                const locs = Object.entries(m.stock.byLoc).sort((a, b) => b[1] - a[1]);
                return (
                  <tr key={m.sku}>
                    <td className="nv-mute">{i + 1}</td>
                    <td><b className="nv-name">{m.name}</b><div className="nv-mute">{m.sku} · {m.category}</div></td>
                    <td className="r">{num(m.units)}</td>
                    <td className="r">{money(m.revenue)}</td>
                    <td className="r"><span className={`nv-pill ${toneOf(d)}`}>{d == null ? 'nuevo' : pct(d, { sign: true })}</span></td>
                    <td className={`r${m.stock.web === 0 ? ' nv-red' : ''}`}>{num(m.stock.web)}</td>
                    <td className="r">{num(m.stock.total)}</td>
                    <td>
                      <span className="nv-chips">
                        {locs.length === 0 && <span className="nv-mute">—</span>}
                        {locs.map(([k, n]) => <span key={k} className={`nv-chip${isExhibition(k) ? ' ex' : ''}`}>{LOC_SHORT[k] ?? k} {num(n)}</span>)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {topModels.length > SHOW && (
        <button type="button" className="nv-link nv-more" onClick={() => setAll(a => !a)}>{all ? 'Ver menos' : `Ver los ${topModels.length}`}</button>
      )}
    </section>
  );
}
