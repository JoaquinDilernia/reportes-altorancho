import { useState } from 'react';
import { num } from '../format.js';
import { rate } from './webFormat.js';

const VIEWS = [
  ['topViewed', 'Más vistos', 'los productos con más vistas'],
  ['lowConversion', 'Mucho interés, poca venta', 'más de 2.000 vistas y la peor tasa de compra: precio, fotos, stock o el anuncio que los trae'],
  ['bestConversion', 'Mejor conversión', 'más de 1.000 vistas y la mejor tasa de compra'],
];

export default function ItemsCard({ items, onOpenSku }) {
  const [view, setView] = useState('topViewed');
  const rows = items[view] || [];
  const hint = VIEWS.find(v => v[0] === view)[2];
  return (
    <section className="nv-card nv-sec">
      <div className="nv-titlebar">
        <div className="nv-h"><h2>Productos en la web</h2><span>{hint}</span></div>
        <div className="nv-seg" role="group" aria-label="Lista de productos">
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" className={view === id ? 'on' : ''} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? <p className="nv-empty">Ningún producto llega al mínimo de vistas en este período.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table nv-compact">
            <thead>
              <tr><th>Producto</th><th className="r">Vistas</th><th className="r">Al carrito</th><th className="r">Compras</th><th className="r">% compra</th><th className="r">Stock web</th></tr>
            </thead>
            <tbody>
              {rows.map(i => (
                <tr key={i.name}>
                  <td>
                    {i.sku ? <button type="button" className="nv-link" onClick={() => onOpenSku(i.sku)}>{i.name}</button> : <span className="nv-name">{i.name}</span>}
                    <div className="nv-mute">{i.category}</div>
                  </td>
                  <td className="r">{num(i.views)}</td>
                  <td className="r">{num(i.carts)}</td>
                  <td className="r">{num(i.purchases)}</td>
                  <td className="r">{rate(i.buyRate)}</td>
                  <td className={`r${i.webStock === 0 ? ' nv-red' : ''}`}>{i.webStock == null ? '—' : num(i.webStock)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
