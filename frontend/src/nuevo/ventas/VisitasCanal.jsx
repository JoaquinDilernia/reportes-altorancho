import { useEffect, useState } from 'react';
import { getVisitas } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import { money, num, pct } from '../format.js';
import ChannelChip from './ChannelChip.jsx';
import { longDate } from './vFormat.js';

const ratio = (a, b) => (b ? (a / b) * 100 : null);
const perVisit = (a, b) => (b ? (a / b).toLocaleString('es-AR', { maximumFractionDigits: 1 }) : '—');

function Row({ c, total }) {
  return (
    <tr>
      <td>{total ? <strong>Total</strong> : <ChannelChip channel={c.channel} />}</td>
      <td className="num">{num(c.visits)}</td>
      <td className="num">{perVisit(c.pageviews, c.visits)}</td>
      <td className="num">{pct(ratio(c.bounces, c.visits))}</td>
      <td className="num">{num(c.productViews)}</td>
      <td className="num">{pct(ratio(c.sessionsWithCart, c.visits), { decimals: 1 })}</td>
      <td className="num">{num(c.orders)}</td>
      <td className="num">{pct(ratio(c.orders, c.visits), { decimals: 2 })}</td>
      <td className="num">{money(c.revenue)}</td>
      <td className="num">{total ? '' : c.assistedOrders ? `${c.assistedOrders} · ${money(c.assistedRevenue)}` : '—'}</td>
    </tr>
  );
}

// Visitas, carritos y compras por canal, según el script propio de la tienda.
export default function VisitasCanal({ period, date, start, end, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getVisitas(periodParams({ period, date, start, end }))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout?.();
      });
    return () => { cancelled = true; };
  }, [period, date, start, end, onLogout]);

  return (
    <section className="nv-card nv-sec">
      <div className="nv-titlebar">
        <div className="nv-h"><h2>Visitas por canal</h2>{data?.trackingSince && <span>se registran desde el {longDate(data.trackingSince)}</span>}</div>
      </div>
      {error && <p className="nv-empty">No se pudieron traer las visitas: {error}</p>}
      {!data && !error && <div className="nv-skel-box nv-card" style={{ height: 180 }} aria-busy="true" />}
      {data && data.channels.length === 0 && <p className="nv-empty">No hay visitas registradas en este período.</p>}
      {data && data.channels.length > 0 && (
        <>
          <div className="nv-tscroll">
            <table className="nv-table nv-vc-table">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th className="num">Visitas</th>
                  <th className="num" title="Páginas vistas por visita">Páginas / visita</th>
                  <th className="num" title="Visitas que vieron una sola página y se fueron">Se fueron enseguida</th>
                  <th className="num">Productos vistos</th>
                  <th className="num" title="Visitas en las que agregaron algo al carrito">Agregaron al carrito</th>
                  <th className="num" title="Compras hechas en una visita de este canal">Compras</th>
                  <th className="num" title="Compras / visitas">Conversión</th>
                  <th className="num">Facturado</th>
                  <th className="num" title="Compras en las que este canal trajo al cliente al menos una vez en los 30 días anteriores, aunque haya comprado desde otro">Participó en</th>
                </tr>
              </thead>
              <tbody>
                {data.channels.map((c) => <Row key={c.channel} c={c} />)}
                <Row c={data.total} total />
              </tbody>
            </table>
          </div>
          <p className="nv-note">
            <strong>Compras</strong>: el canal de la visita en la que compró. <strong>Participó en</strong>: compras en las que ese canal lo trajo al menos una vez en los 30 días anteriores, aunque haya comprado entrando por otro lado.
            Solo cuenta lo que pasa en la tienda (no el checkout de Tienda Nube) y no ve a quien bloquea el seguimiento.
          </p>
        </>
      )}
    </section>
  );
}
