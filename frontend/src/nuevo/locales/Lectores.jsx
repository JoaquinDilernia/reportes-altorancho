import { num, pct, toneOf } from '../format.js';
import { STORES } from './stores.js';
import { upt } from './localesFormat.js';

// Lectores de precios (pick.altorancho.com): cada vez que un cliente escanea
// un producto queda registrado. Solo los locales que tienen lector.
const withReader = (lectores) => STORES.map(s => ({ store: s, l: lectores.byLocal[s.id] })).filter(x => x.l?.hasReader);

function peak(hours) {
  if (!hours.length) return null;
  const top = hours.reduce((a, b) => (b.searches > a.searches ? b : a));
  return `${String(top.hour).padStart(2, '0')}–${String(top.hour + 1).padStart(2, '0')} h`;
}

export function LectoresSummary({ lectores, error, period }) {
  const prevLabel = period === 'month' ? 'mes anterior' : period === 'week' ? 'semana anterior' : 'período anterior';
  if (error) return <section className="nv-card nv-sec"><div className="nv-h"><h2>Lector de precios</h2></div><p className="nv-empty">No se pudieron leer las consultas de los lectores.</p></section>;
  if (!lectores) return <div className="nv-card nv-skel-box nv-sec" style={{ height: 150 }} aria-busy="true" aria-label="Cargando lectores" />;
  const rows = withReader(lectores);
  if (!rows.length) return null;
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Lector de precios</h2><span>consultas de clientes en las pantallas de los locales</span></div>
      <div className="nv-lect">
        {rows.map(({ store, l }) => (
          <div key={store.id} className="nv-lect-loc">
            <div className="nv-lbl"><i className="nv-dot" style={{ background: store.color }} />{store.label}</div>
            <div className="nv-big nv-mid">{num(l.searches)} <span className="nv-mute nv-lect-u">consultas</span></div>
            <div><span className={`nv-pill ${toneOf(l.vsPrev)}`}>{l.vsPrev == null ? 'sin dato' : pct(l.vsPrev, { sign: true })}</span> <span className="nv-mute">vs. {prevLabel} ({num(l.prevSearches)})</span></div>
            <dl className="nv-lect-kv">
              <div><dt>Por ticket</dt><dd title={`${num(l.searches)} consultas · ${num(l.tickets)} tickets del POS`}>{upt(l.searchesPerTicket)}</dd></div>
              <div><dt>Se vendió</dt><dd title={`De los ${num(l.consultedSkus)} productos consultados, cuántos tuvieron al menos una venta en el local`}>{pct(l.soldOfConsultedPct)}</dd></div>
              <div><dt>Pico</dt><dd>{peak(l.hours) ?? '—'}</dd></div>
            </dl>
          </div>
        ))}
      </div>
      <div className="nv-note">
        <b>Por ticket</b>: consultas por cada venta del local. <b>Se vendió</b>: de los productos que se consultaron, qué parte tuvo al menos una venta en ese local en el período.
      </div>
    </section>
  );
}

export function LectoresTop({ local, label, onOpenSku }) {
  if (!local?.hasReader) return null;
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Lo más consultado en {label}</h2><span>lector de precios · cruzado con las ventas del local</span></div>
      {local.top.length === 0 ? <p className="nv-empty">Sin consultas en el período.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table nv-compact">
            <thead><tr><th>#</th><th>Producto</th><th className="r">Consultas</th><th className="r">Vendidas acá</th></tr></thead>
            <tbody>
              {local.top.map((p, i) => (
                <tr key={p.sku}>
                  <td className="nv-mute">{i + 1}</td>
                  <td>
                    <button type="button" className="nv-link nv-name" onClick={() => onOpenSku(p.model)}>{p.name}</button>
                    <div className="nv-mute">{p.sku}</div>
                  </td>
                  <td className="r">{num(p.searches)}</td>
                  <td className={`r${p.unitsSold === 0 ? ' nv-red' : ''}`}>{num(p.unitsSold)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="nv-note">En rojo: se consultó y no se vendió ninguno en el local. Vale mirar precio, stock o cómo está exhibido.</div>
    </section>
  );
}
