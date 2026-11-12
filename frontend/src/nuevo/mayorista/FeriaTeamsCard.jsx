import { money, num, pct } from '../format.js';
import { getChannelColor } from '../../lib/channels.js';

const MAY = getChannelColor('mayorista');
const FERIA = getChannelColor('feria');

function Bars({ rows, color, label }) {
  const max = Math.max(1, ...rows.map(r => r.revenue));
  return rows.map(r => (
    <div className="nv-chrow nv-payrow" key={r[label]}>
      <span className="nv-ellip" title={r[label]}>{r[label]}</span>
      <div className="nv-track"><i style={{ width: `${(Math.max(0, r.revenue) / max) * 100}%`, background: r.color ?? color }} /></div>
      <span className="r" title={`${num(r.orders)} pedidos`}>{money(r.revenue)}</span>
      <span className="r nv-mute">{pct(r.sharePct)}</span>
    </div>
  ));
}

export default function FeriaTeamsCard({ sources, teams }) {
  const split = sources.map(s => ({ ...s, color: s.id === 'feria' ? FERIA : MAY }));
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Mayorista y ferias</h2><span>facturación del período</span></div>
      <Bars rows={split} label="label" />
      <div className="nv-h nv-subh"><h2>Ferias por equipo de venta</h2><span>cada equipo de Odoo es una feria</span></div>
      {teams.length === 0
        ? <p className="nv-empty">Sin ventas de ferias en el período.</p>
        : <Bars rows={teams} color={FERIA} label="team" />}
      {teams.some(t => t.team === 'Sin equipo') && (
        <div className="nv-note">"Sin equipo": ventas sincronizadas antes de que se guardara el equipo. Se completan solas con la próxima sincronización de ferias.</div>
      )}
    </section>
  );
}
