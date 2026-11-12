import { num } from '../format.js';

export default function SearchesCard({ searches }) {
  const max = Math.max(...searches.map(s => s.count), 1);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Qué buscan</h2><span>búsquedas en el buscador del sitio</span></div>
      {searches.length === 0 && <p className="nv-empty">Sin búsquedas registradas en el período.</p>}
      {searches.map(s => (
        <div className="nv-whrow nv-srow" key={s.term}>
          <span className="nv-ellip" title={s.term}>{s.term}</span>
          <div className="nv-track"><i style={{ width: `${(s.count / max) * 100}%`, background: 'var(--nv-ink)' }} /></div>
          <span className="r">{num(s.count)}</span>
        </div>
      ))}
    </section>
  );
}
