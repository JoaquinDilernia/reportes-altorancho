import { money, num } from '../format.js';
import { STORES } from './stores.js';
import { heatLevel } from './localesFormat.js';

// Store color at 0/15/30/50/75% opacity.
const ALPHA = ['00', '26', '4d', '80', 'bf'];

export default function HoursCard({ hours }) {
  const max = Math.max(0, ...hours.rows.flatMap(r => STORES.map(s => r.byLocal[s.id].orders)));
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Por hora</h2><span>tickets por hora del POS (hora Argentina)</span></div>
      {hours.rows.length === 0 ? <p className="nv-empty">Sin ventas en el período.</p> : (
        <div className="nv-tscroll">
          <table className="nv-table nv-compact nv-heat">
            <thead><tr><th>Hora</th>{STORES.map(s => <th key={s.id} className="r">{s.label}</th>)}<th className="r">Total</th></tr></thead>
            <tbody>
              {hours.rows.map(r => {
                const total = STORES.reduce((n, s) => n + r.byLocal[s.id].orders, 0);
                return (
                  <tr key={r.hour}>
                    <td className="nv-mute">{String(r.hour).padStart(2, '0')} h</td>
                    {STORES.map(s => {
                      const c = r.byLocal[s.id];
                      return (
                        <td
                          key={s.id}
                          className="r"
                          title={`${s.label} ${r.hour} h: ${num(c.orders)} tickets · ${money(c.revenue)}`}
                          style={{ background: `${s.color}${ALPHA[heatLevel(c.orders, max)]}` }}
                        >
                          {c.orders ? num(c.orders) : ''}
                        </td>
                      );
                    })}
                    <td className="r"><b>{num(total)}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
