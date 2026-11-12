import { getChannelColor } from '../../lib/channels.js';
import { money, pct, toneOf } from '../format.js';

// Resumen channel groups → the colors the rest of the app uses.
export const GROUPS = [
  { id: 'web', label: 'Web', color: getChannelColor('ecommerce') },
  { id: 'lomas', label: 'Lomas', color: getChannelColor('local_lomas') },
  { id: 'belgrano', label: 'Belgrano', color: getChannelColor('local_belgrano') },
  { id: 'alcorta', label: 'Alcorta', color: getChannelColor('local_alcorta') },
  { id: 'mayorista', label: 'Mayorista', color: getChannelColor('mayorista') },
];
const PREV = { week: 'vs. semana anterior', month: 'vs. mes anterior', custom: 'vs. período anterior' };

export default function ChannelsCard({ channels, period }) {
  const byId = Object.fromEntries(channels.map(c => [c.id, c]));
  const max = Math.max(...channels.map(c => c.revenue), 1);
  return (
    <section className="nv-card">
      <div className="nv-h"><h2>Por canal</h2><span>{PREV[period]}</span></div>
      {GROUPS.map(g => {
        const c = byId[g.id] ?? { revenue: 0, deltaPct: null, sharePct: 0, orders: 0 };
        return (
          <div className="nv-chrow" key={g.id}>
            <span className="nv-chname"><span className="nv-dot" style={{ background: g.color }} />{g.label}</span>
            <div className="nv-track"><i style={{ width: `${(c.revenue / max) * 100}%`, background: g.color }} /></div>
            <span className="r" title={`${c.orders} ventas`}>{money(c.revenue)}</span>
            <span className="r"><span className={`nv-pill ${toneOf(c.deltaPct)}`}>{pct(c.deltaPct, { sign: true })}</span></span>
            <span className="r nv-mute">{pct(c.sharePct)}</span>
          </div>
        );
      })}
      <div className="nv-note">Mayorista incluye ferias. Web sin IVA ni envío; locales con IVA.</div>
    </section>
  );
}
