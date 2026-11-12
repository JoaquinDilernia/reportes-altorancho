import { num } from '../format.js';

const SECTIONS = [
  { id: 'rolon', title: 'Rolón (depósito central)' },
  { id: 'locales', title: 'Locales' },
];

export default function WarehousesCard({ warehouses }) {
  const max = Math.max(...warehouses.map(w => w.units), 1);
  const noExhibition = warehouses.filter(w => w.key.endsWith('_exhibicion')).every(w => w.units === 0);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Stock por depósito</h2><span>unidades y productos distintos · a hoy</span></div>
      {SECTIONS.map(s => (
        <div key={s.id} className="nv-wh">
          <div className="nv-lbl">{s.title}</div>
          {warehouses.filter(w => w.group === s.id).map(w => (
            <div className="nv-whrow" key={w.key}>
              <span className="nv-ellip">{w.label}</span>
              <div className="nv-track"><i style={{ width: `${(w.units / max) * 100}%`, background: 'var(--nv-ink)' }} /></div>
              <span className="r">{num(w.units)}</span>
              <span className="r nv-mute">{num(w.products)} prod.</span>
            </div>
          ))}
        </div>
      ))}
      {noExhibition && <div className="nv-note">La exhibición de los locales aparece después de la próxima sincronización de productos.</div>}
    </section>
  );
}
