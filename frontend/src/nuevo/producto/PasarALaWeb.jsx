import { useState } from 'react';
import { money, num } from '../format.js';
import { LOC_SHORT, isExhibition } from '../stockLabels.js';

const GROUPS = [
  { id: 'rolon', title: 'Se pasa desde Rolón', hint: 'hay stock en el depósito central' },
  { id: 'local', title: 'Solo en locales', hint: 'habría que traerlo de un local' },
  { id: 'none', title: 'No hay en ningún lado — recomprar', hint: '' },
];
const SHOW = 15;

function Where({ where }) {
  const keys = Object.keys(where);
  if (!keys.length) return <span className="nv-mute">—</span>;
  return (
    <span className="nv-chips">
      {keys.map(k => (
        <span key={k} className={`nv-chip${isExhibition(k) ? ' ex' : ''}`} title={isExhibition(k) ? 'En exhibición (piso del local)' : undefined}>
          {LOC_SHORT[k] ?? k} {num(where[k])}
        </span>
      ))}
    </span>
  );
}

function Group({ group, rows, onOpenSku }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, SHOW);
  return (
    <>
      <tr className="nv-tgroup">
        <th colSpan={6}>
          {group.title} <span className="nv-count">{rows.length}</span>
          {group.hint && <span className="nv-mute"> · {group.hint}</span>}
        </th>
      </tr>
      {shown.map(r => (
        <tr key={r.sku}>
          <td>
            <button type="button" className="nv-link" onClick={() => onOpenSku(r.sku)}>{r.name}</button>
            <div className="nv-mute">{r.sku}{r.onlyExhibition && <span className="nv-tag t-y nv-tag-inline">solo exhibición</span>}</div>
          </td>
          <td className="r">{r.weeklyUnits.toLocaleString('es-AR')}</td>
          <td className={`r${r.webStock === 0 ? ' nv-red' : ''}`}>{num(r.webStock)}</td>
          <td className={`r${r.coverageDays === 0 ? ' nv-red' : ''}`}>{r.coverageDays === 0 ? '0' : r.coverageDays.toLocaleString('es-AR')}</td>
          <td><Where where={r.where} /></td>
          <td className="r">{money(r.lostPerDay)}</td>
        </tr>
      ))}
      {rows.length > SHOW && (
        <tr><td colSpan={6}><button type="button" className="nv-link nv-more" onClick={() => setAll(a => !a)}>
          {all ? 'Ver menos' : `Ver todos (${rows.length})`}
        </button></td></tr>
      )}
    </>
  );
}

export default function PasarALaWeb({ coverage, onOpenSku }) {
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h">
        <h2>Pasar a la web</h2>
        <span>se venía vendiendo en la web y le queda menos de una semana · stock a hoy · venta de las últimas 4 semanas</span>
      </div>
      {coverage.length === 0 ? <p className="nv-empty">Nada para pasar: todo lo que se vende en la web tiene stock para más de una semana.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table">
            <thead>
              <tr>
                <th>Producto</th><th className="r">Venta web/sem.</th><th className="r">Stock web</th>
                <th className="r">Días de cobertura</th><th>Dónde hay</th><th className="r">Venta en juego/día</th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.map(g => <Group key={g.id} group={g} rows={coverage.filter(r => r.group === g.id)} onOpenSku={onOpenSku} />)}
            </tbody>
          </table>
        </div>
      )}
      <div className="nv-note">Stock web = Tiendanube. "Venta en juego" = lo que vendía por día en la web; si se queda sin stock, es lo que se pierde.</div>
    </section>
  );
}
