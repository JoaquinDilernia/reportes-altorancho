import { useEffect, useRef, useState } from 'react';
import { getProductSheet } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import { GROUPS } from '../resumen/ChannelsCard.jsx';
import { money, num } from '../format.js';
import { stockRows, toStockByLoc } from '../stockLabels.js';


function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Every day of the range (≤ 62), zeros included, so gaps show as gaps.
function fillDays(byDay, range) {
  if (!range) return byDay;
  const map = new Map(byDay.map(d => [d.date, d]));
  const out = [];
  for (let d = range.start; d <= range.end && out.length < 62; d = addDays(d, 1)) {
    out.push(map.get(d) ?? { date: d, units: 0, revenue: 0 });
  }
  return out;
}

export default function ProductSheet({ sku, state, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { period, date, start, end } = state;

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getProductSheet(sku, periodParams({ period, date, start, end }))
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [sku, period, date, start, end]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const days = data ? fillDays(data.byDay, data.range) : [];
  const maxDay = Math.max(...days.map(d => d.units), 1);
  // Web's own Odoo warehouse is the same boxes as Tiendanube's number: not listed twice.
  const locs = data ? stockRows(toStockByLoc(data)).filter(r => r.key !== 'web_odoo') : [];
  const totalUnits = data ? data.byChannel.reduce((s, c) => s + c.units, 0) : 0;
  const totalRevenue = data ? data.byChannel.reduce((s, c) => s + c.revenue, 0) : 0;

  return (
    <>
      <div className="nv-sheet-backdrop" onClick={onClose} />
      <aside className="nv-sheet" role="dialog" aria-modal="true" aria-label={data?.name || sku}>
        <div className="nv-sheet-head">
          <div>
            <div className="nv-lbl">{sku}{data?.category ? ` · ${data.category}` : ''}</div>
            <h2>{data?.name || (error ? 'Producto' : 'Cargando…')}</h2>
            {data?.origin && (
              <span className="nv-pill nt">{data.origin.clase || 'Sin origen'}{data.origin.pais ? ` · ${data.origin.pais}` : ''}</span>
            )}
          </div>
          <button type="button" className="nv-sheet-close" ref={closeRef} onClick={onClose} aria-label="Cerrar">✕</button>
        </div>

        {error && <p className="nv-empty">No se pudo cargar: {error}</p>}

        {data && (
          <>
            <section className="nv-sheet-sec">
              <div className="nv-h"><h3>Stock</h3><span>a hoy</span></div>
              <div className="nv-stock-web">
                <span>Web (Tiendanube)</span>
                <b className={data.webStock > 0 ? '' : 'nv-zero'}>{data.webStock == null ? '—' : num(data.webStock)}</b>
              </div>
              {locs.length === 0 && <p className="nv-empty">Sin stock en depósitos ni locales.</p>}
              {locs.map(r => (
                <div className="nv-stock-row" key={r.key}><span>{r.label}</span><span>{num(r.units)}</span></div>
              ))}
            </section>

            <section className="nv-sheet-sec">
              <div className="nv-h"><h3>Ventas del período</h3><span>{num(totalUnits)} u. · {money(totalRevenue)}</span></div>
              {GROUPS.map(g => {
                const c = data.byChannel.find(x => x.id === g.id) ?? { units: 0, revenue: 0 };
                return (
                  <div className="nv-stock-row" key={g.id}>
                    <span><span className="nv-dot" style={{ background: g.color }} />{g.label}</span>
                    <span>{num(c.units)} u. · {money(c.revenue)}</span>
                  </div>
                );
              })}
            </section>

            <section className="nv-sheet-sec">
              <div className="nv-h"><h3>Unidades por día</h3></div>
              {totalUnits === 0 ? <p className="nv-empty">Sin ventas en el período.</p> : (
                <div className="nv-mini-chart">
                  {days.map(d => (
                    <div key={d.date} className="nv-mini-col" title={`${d.date.split('-').reverse().join('/')}: ${num(d.units)} u. · ${money(d.revenue)}`}>
                      <i style={{ height: `${(d.units / maxDay) * 100}%` }} />
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </aside>
    </>
  );
}
