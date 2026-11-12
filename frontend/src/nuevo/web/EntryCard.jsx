import { num } from '../format.js';
import { rate } from './webFormat.js';

function Landings({ landings }) {
  return (
    <div className="nv-tscroll">
      <table className="nv-table nv-compact">
        <thead><tr><th>Página de entrada</th><th className="r">Sesiones</th><th className="r">Compras</th><th className="r">Conversión</th></tr></thead>
        <tbody>
          {landings.map(l => (
            <tr key={l.page}>
              <td><span className="nv-ellip nv-block" title={l.page}>{l.label}</span></td>
              <td className="r">{num(l.sessions)}</td>
              <td className="r">{num(l.purchases)}</td>
              <td className="r">{rate(l.conversion)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hours({ hourly }) {
  const max = Math.max(...hourly.map(h => h.sessions), 1);
  return (
    <>
      <div className="nv-hours">
        {hourly.map(h => (
          <div key={h.hour} className="nv-hcol" title={`${h.hour} h · ${num(h.sessions)} sesiones · ${num(h.purchases)} compras · conv. ${rate(h.conversion)}`}>
            <i style={{ height: `${(h.sessions / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="nv-hlabels">{[0, 6, 12, 18, 23].map(h => <span key={h} style={{ left: `${(h / 23) * 100}%` }}>{h} h</span>)}</div>
    </>
  );
}

function Regions({ regions }) {
  return (
    <div className="nv-tscroll">
      <table className="nv-table nv-compact">
        <thead><tr><th>Región</th><th className="r">Sesiones</th><th className="r">Compras</th><th className="r">Conversión</th></tr></thead>
        <tbody>
          {regions.map(r => (
            <tr key={r.region}><td>{r.region === '(not set)' ? 'Sin dato' : r.region}</td><td className="r">{num(r.sessions)}</td><td className="r">{num(r.purchases)}</td><td className="r">{rate(r.conversion)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EntryCard({ behavior }) {
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Por dónde y cuándo entran</h2><span>GA4</span></div>
      <div className="nv-grid2 nv-grid-inner">
        <div>
          <div className="nv-lbl nv-sublbl">Páginas de entrada</div>
          <Landings landings={behavior.landings} />
        </div>
        <div>
          <div className="nv-lbl nv-sublbl">Sesiones por hora del día</div>
          <Hours hourly={behavior.hourly} />
          <div className="nv-lbl nv-sublbl" style={{ marginTop: 18 }}>Regiones</div>
          <Regions regions={behavior.regions} />
        </div>
      </div>
    </section>
  );
}
