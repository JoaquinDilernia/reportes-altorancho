import { useState } from 'react';
import { num } from '../format.js';

const SHOW = 10;

function coverage(days) {
  if (days == null) return 'sin ventas';
  if (days >= 730) return `${num(days / 365)} años`;
  return `${num(days / 30)} meses`;
}

export default function OverstockCard({ overstock, onOpenSku }) {
  const [all, setAll] = useState(false);
  const rows = all ? overstock : overstock.slice(0, SHOW);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Mucho stock, poca venta</h2><span>más de 6 meses de stock al ritmo de las últimas 8 semanas · todos los canales</span></div>
      {overstock.length === 0 ? <p className="nv-empty">Nada con stock de sobra.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table nv-compact">
            <thead><tr><th>Producto</th><th className="r">Stock</th><th className="r">Venta/sem.</th><th className="r">Alcanza para</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.sku}>
                  <td><button type="button" className="nv-link" onClick={() => onOpenSku(r.sku)}>{r.name}</button><div className="nv-mute">{r.sku}</div></td>
                  <td className="r">{num(r.stockTotal)}</td>
                  <td className="r">{r.weeklyUnits.toLocaleString('es-AR')}</td>
                  <td className="r">{coverage(r.coverageDays)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {overstock.length > SHOW && (
        <button type="button" className="nv-link nv-more" onClick={() => setAll(a => !a)}>{all ? 'Ver menos' : `Ver los ${overstock.length}`}</button>
      )}
      <div className="nv-note">Candidatos a empujar con pauta o precio.</div>
    </section>
  );
}
