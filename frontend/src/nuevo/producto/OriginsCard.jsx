import { money, num, pct, toneOf } from '../format.js';

const delta = (cur, prev) => (prev > 0 ? ((cur / prev) - 1) * 100 : null);

function Delta({ cur, prev }) {
  const d = delta(cur, prev);
  return <span className={`nv-pill ${toneOf(d)}`}>{d == null ? '—' : pct(d, { sign: true })}</span>;
}

export default function OriginsCard({ origins, prevYear, adjusted }) {
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Origen del producto</h2><span>vs. {prevYear}{adjusted ? ' ajustado' : ''}</span></div>
      {!origins && <p className="nv-empty">Odoo no respondió con el origen de los productos. Probá de nuevo en un rato.</p>}
      {origins && (
        <div className="nv-tscroll">
          <table className="nv-table nv-compact">
            <thead>
              <tr><th>Origen</th><th className="r">Facturación</th><th className="r">vs. {prevYear}</th><th className="r">Unid.</th><th className="r">Ticket prom.</th><th className="r">Part.</th></tr>
            </thead>
            <tbody>
              {origins.map(o => (
                <OriginRows key={o.id} o={o} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="nv-note">Ticket promedio = facturación del origen ÷ ventas que tuvieron algo de ese origen.</div>
    </section>
  );
}

function OriginRows({ o }) {
  return (
    <>
      <tr>
        <td><b>{o.label}</b></td>
        <td className="r">{money(o.cur.revenue)}</td>
        <td className="r"><Delta cur={o.cur.revenue} prev={o.prev.revenue} /></td>
        <td className="r" title={`${num(o.prev.units)} u. el año pasado`}>{num(o.cur.units)}</td>
        <td className="r" title={`${money(o.prev.avgTicket)} el año pasado`}>{money(o.cur.avgTicket)}</td>
        <td className="r nv-mute">{o.cur.share == null ? '—' : pct(o.cur.share * 100)}</td>
      </tr>
      {(o.countries || []).slice(0, 6).map(c => (
        <tr key={c.name} className="nv-subrow">
          <td>{c.name}</td>
          <td className="r">{money(c.revenue)}</td>
          <td colSpan={3} />
          <td className="r nv-mute">{o.cur.revenue ? pct((c.revenue / o.cur.revenue) * 100) : '—'}</td>
        </tr>
      ))}
    </>
  );
}
