import { money, num, pct } from '../format.js';
import ChannelChip from '../ventas/ChannelChip.jsx';

export const ratio = (a, b) => (b ? (a / b) * 100 : null);
const perVisit = (a, b) => (b ? (a / b).toLocaleString('es-AR', { maximumFractionDigits: 1 }) : '—');

function Row({ c, total }) {
  return (
    <tr>
      <td>{total ? <strong>Total</strong> : <ChannelChip channel={c.channel} />}</td>
      <td className="num">{num(c.visits)}</td>
      <td className="num">{perVisit(c.pageviews, c.visits)}</td>
      <td className="num">{pct(ratio(c.bounces, c.visits))}</td>
      <td className="num">{pct(ratio(c.sessionsWithCart, c.visits), { decimals: 1 })}</td>
      <td className="num">{num(c.orders)}</td>
      <td className="num">{pct(ratio(c.orders, c.visits), { decimals: 2 })}</td>
      <td className="num">{money(c.revenue)}</td>
      <td className="num">{total ? '' : c.assistedOrders ? `${c.assistedOrders} · ${money(c.assistedRevenue)}` : '—'}</td>
    </tr>
  );
}

// Visitas, carritos y compras por canal.
export default function ChannelsTable({ channels, total }) {
  return (
    <>
      <div className="nv-tscroll">
        <table className="nv-table">
          <thead>
            <tr>
              <th>Canal</th>
              <th className="num">Visitas</th>
              <th className="num" title="Páginas vistas por visita">Páginas / visita</th>
              <th className="num" title="Visitas que vieron una sola página y se fueron">Se fueron enseguida</th>
              <th className="num" title="Visitas en las que agregaron algo al carrito">Agregaron al carrito</th>
              <th className="num" title="Compras hechas en una visita de este canal">Compras</th>
              <th className="num" title="Compras / visitas">Conversión</th>
              <th className="num">Facturado</th>
              <th className="num" title="Compras en las que este canal trajo al cliente al menos una vez en los 30 días anteriores, aunque haya comprado desde otro">Participó en</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => <Row key={c.channel} c={c} />)}
            <Row c={total} total />
          </tbody>
        </table>
      </div>
      <p className="nv-note">
        <strong>Compras</strong>: el canal de la visita en la que compró. <strong>Participó en</strong>: compras en las que ese canal lo trajo al menos una vez en los 30 días anteriores, aunque haya comprado entrando por otro lado.
      </p>
    </>
  );
}
