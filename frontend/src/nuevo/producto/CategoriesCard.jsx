import { money, num, pct, toneOf } from '../format.js';

const delta = (cur, prev) => (prev > 0 ? ((cur / prev) - 1) * 100 : null);

export default function CategoriesCard({ categories, prevYear, adjusted }) {
  const rows = [...categories].filter(c => c.revenue > 0 || c.prevRevenueToDateAdj > 0).sort((a, b) => b.revenue - a.revenue);
  const max = Math.max(...rows.map(c => c.revenue), 1);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Categorías</h2><span>vs. {prevYear}{adjusted ? ' ajustado por inflación' : ''} · stock a hoy</span></div>
      {rows.length === 0 && <p className="nv-empty">Sin ventas en el período.</p>}
      {rows.length > 0 && (
        <div className="nv-catrow nv-cathead">
          <span>Categoría</span><span /><span className="r">Facturación</span><span className="r">vs. {prevYear}</span><span className="r">Unid.</span><span className="r">Stock</span>
        </div>
      )}
      {rows.map(c => {
        const d = delta(c.revenue, c.prevRevenueToDateAdj);
        return (
          <div className="nv-catrow" key={c.id}>
            <span className="nv-ellip" title={c.label}>{c.label}</span>
            <div className="nv-track"><i style={{ width: `${(c.revenue / max) * 100}%`, background: 'var(--nv-ink)' }} /></div>
            <span className="r">{money(c.revenue)}</span>
            <span className="r"><span className={`nv-pill ${toneOf(d)}`}>{d == null ? 'nuevo' : pct(d, { sign: true })}</span></span>
            <span className="r" title={`${num(c.prevUnitsToDate)} u. en ${prevYear}`}>{num(c.units)}</span>
            <span className="r nv-mute">{num(c.stock)}</span>
          </div>
        );
      })}
      <div className="nv-note">Facturación por producto, sin envío.</div>
    </section>
  );
}
