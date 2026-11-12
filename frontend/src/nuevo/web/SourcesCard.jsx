import { num, pct, pp, toneOf } from '../format.js';
import { rate, sourceLabel, convPpDelta, weakSources } from './webFormat.js';

const PREV = { week: 'sem. ant.', month: 'mes ant.', custom: 'per. ant.' };

export default function SourcesCard({ channels, siteConversion, period }) {
  const rows = channels.filter(r => r.cur?.sessions);
  const total = rows.reduce((s, r) => s + r.cur.sessions, 0);
  const weak = weakSources(rows, siteConversion);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>De dónde vienen</h2><span>sesiones y conversión por fuente (GA4) · promedio del sitio {rate(siteConversion)}</span></div>
      <div className="nv-tscroll">
        <table className="nv-table nv-compact">
          <thead>
            <tr><th>Fuente</th><th className="r">Sesiones</th><th className="r">Part.</th><th className="r">vs. {PREV[period]}</th><th className="r">Compras</th><th className="r">Conversión</th><th className="r">vs. {PREV[period]}</th></tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const ds = r.prev?.sessions ? ((r.cur.sessions / r.prev.sessions) - 1) * 100 : null;
              const dc = convPpDelta(r.cur.conversion, r.prev?.conversion);
              const isWeak = weak.has(r.key);
              return (
                <tr key={r.key} className={isWeak ? 'nv-weak' : ''}>
                  <td>{sourceLabel(r.key)}{isWeak && <span className="nv-tag t-y nv-tag-inline" title="Trae más del 10% de las sesiones y convierte menos de un tercio del promedio">convierte poco</span>}</td>
                  <td className="r">{num(r.cur.sessions)}</td>
                  <td className="r nv-mute">{total ? pct((r.cur.sessions / total) * 100) : '—'}</td>
                  <td className="r"><span className={`nv-pill ${toneOf(ds)}`}>{pct(ds, { sign: true })}</span></td>
                  <td className="r">{num(r.cur.purchases)}</td>
                  <td className="r">{rate(r.cur.conversion)}</td>
                  <td className="r"><span className={`nv-pill ${toneOf(dc, 0.02)}`}>{pp(dc)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
