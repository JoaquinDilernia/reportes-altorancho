import { useState } from 'react';
import { compactMoney, pctChange } from '../../lib/eventLive.js';
import { formatNumber } from '../../lib/format.js';
import Delta from './Delta.jsx';

// The event's best-selling models (by revenue, colors grouped by reduced SKU)
// vs the same models last year up to the same point. A model that didn't sell
// last year shows "nuevo".
const PAGE = 15;

export default function ProductsTable({ products, prevYear, year }) {
  const [shown, setShown] = useState(PAGE);
  const all = products || [];
  const rows = all.slice(0, shown);
  if (!rows.length) return <div className="ev-panel"><div className="ev-empty">Todavía no hay ventas de productos.</div></div>;
  const yy = (y) => String(y).slice(2);
  const vs = (now, before) => (before ? <Delta pct={pctChange(now, before)} /> : <span className="ev-delta new">nuevo</span>);
  return (
    <div className="ev-panel ev-tscroll">
      <table className="ev-table num ev-prod">
        <thead>
          <tr>
            <th />
            <th />
            <th colSpan={3} className="grp" style={{ borderColor: 'var(--mint)', color: 'var(--mint)' }}>Unidades</th>
            <th colSpan={3} className="grp" style={{ borderColor: 'var(--lime)', color: 'var(--lime)' }}>Facturación</th>
          </tr>
          <tr>
            <th>Producto</th>
            <th>Categoría</th>
            <th className="sepL">{yy(prevYear)}</th><th>{yy(year)}</th><th>vs {yy(prevYear)}</th>
            <th className="sepL">{yy(prevYear)} ajust.</th><th>{yy(year)}</th><th>vs {yy(prevYear)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.sku}>
              <td className="name" title={`${p.sku} · ${p.name}`}>{p.name} <span className="ev-sub">{p.sku}</span></td>
              <td className="cat">{p.category}</td>
              <td className="sepL">{formatNumber(p.prevUnitsToDate)}</td>
              <td><b>{formatNumber(p.units)}</b></td>
              <td>{vs(p.units, p.prevUnitsToDate)}</td>
              <td className="sepL">{compactMoney(p.prevRevenueToDateAdj)}</td>
              <td><b>{compactMoney(p.revenue)}</b></td>
              <td>{vs(p.revenue, p.prevRevenueToDateAdj)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(all.length > shown || shown > PAGE) && (
        <div className="ev-more">
          {all.length > shown && (
            <button type="button" onClick={() => setShown(s => s + PAGE)}>
              Ver más ({Math.min(PAGE, all.length - shown)})
            </button>
          )}
          {shown > PAGE && (
            <button type="button" onClick={() => setShown(PAGE)}>Ver menos</button>
          )}
        </div>
      )}
      <div className="ev-note">
        Los {rows.length} modelos que más facturaron en {year}, sumando todos sus colores (SKU reducido). {prevYear} = el mismo modelo en los días alineados,
        con el día de hoy cortado a la misma hora. "Nuevo" = no se vendió en {prevYear} en esos días.
      </div>
    </div>
  );
}
