import { compactMoney, pctChange } from '../../lib/eventLive.js';
import { formatNumber } from '../../lib/format.js';
import Delta from './Delta.jsx';

// Sales by product origin (Odoo "Clasificación Origen": Fábrica / Proveedor
// nacional / Importado) vs last year up to the same point, 2025 adjusted for
// inflation. Ticket = the origin's revenue ÷ orders that include it.
export default function OriginsTable({ origins, prevYear, year }) {
  if (!origins) return <div className="ev-panel"><div className="ev-empty">No se pudo leer el origen de los productos desde Odoo.</div></div>;
  if (!origins.length) return <div className="ev-panel"><div className="ev-empty">Todavía no hay ventas.</div></div>;
  const yy = (y) => String(y).slice(2);
  const pctTxt = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const imp = origins.find(o => o.id === 'importado');
  return (
    <div className="ev-panel ev-tscroll">
      <table className="ev-table num ev-prod">
        <thead>
          <tr>
            <th />
            <th colSpan={4} className="grp" style={{ borderColor: 'var(--lime)', color: 'var(--lime)' }}>Facturación</th>
            <th colSpan={3} className="grp" style={{ borderColor: 'var(--mint)', color: 'var(--mint)' }}>Unidades</th>
            <th colSpan={3} className="grp" style={{ borderColor: 'var(--sky)', color: 'var(--sky)' }}>Pedidos</th>
            <th colSpan={3} className="grp" style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }}>Ticket promedio</th>
          </tr>
          <tr>
            <th>Origen</th>
            <th>{yy(prevYear)} ajust.</th><th>{yy(year)}</th><th>vs {yy(prevYear)}</th><th>% venta</th>
            <th className="sepL">{yy(prevYear)}</th><th>{yy(year)}</th><th>vs</th>
            <th className="sepL">{yy(prevYear)}</th><th>{yy(year)}</th><th>vs</th>
            <th className="sepL">{yy(prevYear)} ajust.</th><th>{yy(year)}</th><th>vs</th>
          </tr>
        </thead>
        <tbody>
          {origins.map(o => (
            <tr key={o.id}>
              <td className="name">{o.label}</td>
              <td>{compactMoney(o.prev.revenue)}</td>
              <td><b>{compactMoney(o.cur.revenue)}</b></td>
              <td><Delta pct={pctChange(o.cur.revenue, o.prev.revenue)} /></td>
              <td>{pctTxt(o.cur.share)} <span className="ev-dim">({pctTxt(o.prev.share)})</span></td>
              <td className="sepL">{formatNumber(o.prev.units)}</td>
              <td><b>{formatNumber(o.cur.units)}</b></td>
              <td><Delta pct={pctChange(o.cur.units, o.prev.units)} /></td>
              <td className="sepL">{formatNumber(o.prev.orders)}</td>
              <td><b>{formatNumber(o.cur.orders)}</b></td>
              <td><Delta pct={pctChange(o.cur.orders, o.prev.orders)} /></td>
              <td className="sepL">{o.prev.avgTicket ? compactMoney(o.prev.avgTicket) : '—'}</td>
              <td><b>{o.cur.avgTicket ? compactMoney(o.cur.avgTicket) : '—'}</b></td>
              <td><Delta pct={pctChange(o.cur.avgTicket, o.prev.avgTicket)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {imp?.countries?.length > 0 && (
        <div className="ev-note">
          Importado {year} por país: {imp.countries.filter(c => c.revenue > 0).slice(0, 5).map(c => `${c.name} ${compactMoney(c.revenue)}`).join(' · ')}.
        </div>
      )}
      <div className="ev-note">
        Origen = "Clasificación Origen" del producto en Odoo. {prevYear} en los mismos días alineados y a esta hora, en pesos de hoy.
        Pedidos = ventas que incluyen al menos un producto de ese origen (una venta con productos de dos orígenes cuenta en los dos),
        por eso el ticket es la facturación de ese origen ÷ sus pedidos. "% venta" entre paréntesis = {prevYear}.
      </div>
    </div>
  );
}
