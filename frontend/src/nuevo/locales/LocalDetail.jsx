import { money, num, pct, toneOf } from '../format.js';
import OriginsCard from '../producto/OriginsCard.jsx';
import { STORES } from './stores.js';

const delta = (cur, prev) => (prev > 0 ? ((cur / prev) - 1) * 100 : null);

function YearPill({ cur, prev }) {
  const d = delta(cur, prev);
  return <span className={`nv-pill ${toneOf(d)}`}>{d == null ? 'nuevo' : pct(d, { sign: true })}</span>;
}

function StockStrip({ stock, label, asOf }) {
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Stock de {label}</h2><span>stock a hoy ({asOf})</span></div>
      <div className="nv-locstock">
        <div><div className="nv-lbl">Depósito del local</div><div className="nv-big nv-mid">{num(stock.stock.units)} u.</div><div className="nv-mute">{num(stock.stock.products)} productos</div></div>
        <div><div className="nv-lbl">Exhibición</div><div className="nv-big nv-mid">{num(stock.exhibition.units)} u.</div><div className="nv-mute">{num(stock.exhibition.products)} productos</div></div>
      </div>
    </section>
  );
}

function TopTable({ rows, prevYear, label, onOpenSku }) {
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Más vendidos en {label}</h2><span>por modelo, todos los colores · stock a hoy</span></div>
      {rows.length === 0 ? <p className="nv-empty">Sin ventas en el período.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table">
            <thead>
              <tr>
                <th>#</th><th>Modelo</th><th className="r">Unid.</th><th className="r">Facturación</th><th className="r">vs. {prevYear}</th>
                <th className="r" title="Depósito + exhibición del local">Stock local</th>
                <th className="r" title="Rolón: reserva, mayorista y Alcorta en Rolón">Rolón</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => {
                const local = m.local.stock + m.local.exhibition;
                return (
                  <tr key={m.sku}>
                    <td className="nv-mute">{i + 1}</td>
                    <td>
                      <button type="button" className="nv-link nv-name" onClick={() => onOpenSku(m.sku)}>{m.name}</button>
                      <div className="nv-mute">{m.sku} · {m.category}</div>
                    </td>
                    <td className="r">{num(m.units)}</td>
                    <td className="r">{money(m.revenue)}</td>
                    <td className="r"><YearPill cur={m.revenue} prev={m.prevRevenueToDateAdj} /></td>
                    <td className={`r${local === 0 ? ' nv-red' : ''}`} title={`Depósito ${num(m.local.stock)} · exhibición ${num(m.local.exhibition)}`}>{num(local)}</td>
                    <td className="r">{num(m.rolon)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="nv-note">En rojo: se vende en el local y no le queda stock ahí (ni en depósito ni exhibido). Si Rolón tiene, se puede reponer.</div>
    </section>
  );
}

function CategoriesTable({ rows, prevYear }) {
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Categorías</h2><span>vs. {prevYear}</span></div>
      {rows.length === 0 ? <p className="nv-empty">Sin ventas en el período.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table nv-compact">
            <thead><tr><th>Categoría</th><th className="r">Unid.</th><th className="r">Facturación</th><th className="r">vs. {prevYear}</th></tr></thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td className="r">{num(c.units)}</td>
                  <td className="r">{money(c.revenue)}</td>
                  <td className="r"><YearPill cur={c.revenue} prev={c.prevRevenueToDateAdj} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Payments({ rows, color }) {
  const max = Math.max(1, ...rows.map(p => p.revenue));
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Medios de pago</h2><span>facturación por medio</span></div>
      {rows.length === 0 ? <p className="nv-empty">Sin ventas en el período.</p> : rows.map(p => (
        <div className="nv-chrow nv-payrow" key={p.method}>
          <span className="nv-ellip" title={p.method}>{p.method}</span>
          <div className="nv-track"><i style={{ width: `${Math.max(0, p.revenue / max) * 100}%`, background: color }} /></div>
          <span className="r" title={`${num(p.orders)} tickets`}>{money(p.revenue)}</span>
          <span className="r nv-mute">{pct(p.sharePct)}</span>
        </div>
      ))}
    </section>
  );
}

export default function LocalDetail({ data, loc, onUpdate, onOpenSku }) {
  const store = STORES.find(s => s.id === loc) ?? STORES[0];
  const d = data.detail[store.id];
  const asOf = data.stockAsOf.split('-').reverse().slice(0, 2).join('/');
  return (
    <>
      <div className="nv-titlebar nv-loctitle">
        <h2 className="nv-section">Adentro de un local</h2>
        <div className="nv-seg" role="group" aria-label="Local">
          {STORES.map(s => (
            <button key={s.id} type="button" className={s.id === store.id ? 'on' : ''} aria-pressed={s.id === store.id} onClick={() => onUpdate({ loc: s.id })}>{s.label}</button>
          ))}
        </div>
      </div>
      <StockStrip stock={d.stock} label={store.label} asOf={asOf} />
      <TopTable rows={d.topModels} prevYear={data.prevYear} label={store.label} onOpenSku={onOpenSku} />
      <div className="nv-grid2">
        <CategoriesTable rows={d.categories} prevYear={data.prevYear} />
        <div>
          <Payments rows={d.payments} color={store.color} />
          <OriginsCard origins={d.origins} prevYear={data.prevYear} adjusted={data.inflationAdjusted} />
        </div>
      </div>
    </>
  );
}
