import { num } from '../format.js';
import { rate } from './webFormat.js';

export default function ViewedCategoriesCard({ categories, matchedViewShare }) {
  const rows = categories.filter(c => c.views > 0);
  const max = Math.max(...rows.map(c => c.views), 1);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Qué miran vs qué compran</h2><span>vistas de producto por categoría · sin comparación con el año pasado</span></div>
      {rows.length === 0 && <p className="nv-empty">Sin vistas de producto en el período.</p>}
      {rows.length > 0 && (
        <div className="nv-vcrow nv-cathead"><span>Categoría</span><span /><span className="r">Vistas</span><span className="r">Al carrito</span><span className="r">Compra</span></div>
      )}
      {rows.map(c => (
        <div className="nv-vcrow" key={c.id}>
          <span className="nv-ellip" title={c.label}>{c.label}</span>
          <div className="nv-track"><i style={{ width: `${(c.views / max) * 100}%`, background: 'var(--nv-info)' }} /></div>
          <span className="r">{num(c.views)}</span>
          <span className="r">{rate(c.cartRate, 1)}</span>
          <span className="r">{rate(c.buyRate, 2)}</span>
        </div>
      ))}
      {matchedViewShare != null && <div className="nv-note">El {rate(matchedViewShare, 0)} de las vistas se pudo cruzar con el catálogo de Odoo.</div>}
    </section>
  );
}
