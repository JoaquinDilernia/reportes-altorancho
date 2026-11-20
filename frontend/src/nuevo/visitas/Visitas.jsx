import { useEffect, useMemo, useState } from 'react';
import { getVisitas } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import { money, num, pct } from '../format.js';
import ChannelChip from '../ventas/ChannelChip.jsx';
import { longDate, when } from '../ventas/vFormat.js';
import ChannelsTable, { ratio } from './ChannelsTable.jsx';
import SellerLink from './SellerLink.jsx';

const TITLE = { week: 'Visitas de la semana', month: 'Visitas del mes', custom: 'Visitas del período' };
const DEVICE = { mobile: 'Celular', desktop: 'Computadora', tablet: 'Tablet' };

// Barra fina para comparar dentro de una columna (magnitud: un solo color).
function Bar({ v, max, tone = 'var(--nv-info)' }) {
  return (
    <span className="nv-vz-bar" aria-hidden="true">
      <span style={{ width: `${max ? Math.max(2, (v / max) * 100) : 0}%`, background: tone }} />
    </span>
  );
}

function Section({ title, sub, children, note }) {
  return (
    <section className="nv-card nv-sec">
      <div className="nv-titlebar"><div className="nv-h"><h2>{title}</h2>{sub && <span>{sub}</span>}</div></div>
      {children}
      {note && <p className="nv-note">{note}</p>}
    </section>
  );
}

function Alerts({ alerts }) {
  if (!alerts?.length) return null;
  return (
    <div className="nv-vz-alerts">
      {alerts.map((a, i) => (
        <div key={i} className={`nv-vz-alert ${a.level}`}>
          {a.kind === 'checkout' ? (
            <>
              <b>{money(a.total)}</b> en un checkout abandonado {when(a.at)} · <ChannelChip channel={a.channel} /> · {a.products}
              {a.email && <> · <a href={`mailto:${a.email}`}>{a.email}</a></>}
              <span className="nv-mute"> — {a.text}</span>
            </>
          ) : a.text}
        </div>
      ))}
    </div>
  );
}

function Funnel({ funnel, channels }) {
  const rows = channels.filter((c) => c.visits >= 20).map((c) => {
    const f = funnel.find((x) => x.channel === c.channel) || {};
    return { channel: c.channel, visits: c.visits, product: f.with_product || 0, cart: c.sessionsWithCart, orders: c.orders };
  });
  const cell = (v, base) => (
    <td className="num"><div className="nv-vz-cell"><span>{pct(ratio(v, base), { decimals: v && ratio(v, base) < 10 ? 1 : 0 })}</span><Bar v={v} max={base} /></div></td>
  );
  return (
    <div className="nv-tscroll">
      <table className="nv-table nv-vz-funnel">
        <thead><tr><th>Canal</th><th className="num">Entraron</th><th className="num">Vieron un producto</th><th className="num">Agregaron al carrito</th><th className="num">Compraron</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.channel}>
              <td><ChannelChip channel={r.channel} /></td>
              <td className="num">{num(r.visits)}</td>
              {cell(r.product, r.visits)}
              {cell(r.cart, r.visits)}
              {cell(r.orders, r.visits)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Journeys({ j }) {
  if (!j.orders) return <p className="nv-empty">Todavía no hay compras con recorrido registrado en este período.</p>;
  const dist = (obj, order) => {
    const max = Math.max(...order.map((k) => obj[k] || 0), 1);
    return order.map((k) => (
      <div key={k} className="nv-vz-dist"><span>{k}</span><Bar v={obj[k] || 0} max={max} /><b>{obj[k] || 0}</b></div>
    ));
  };
  return (
    <>
      <div className="nv-grid2">
        <div>
          <h3 className="nv-sub-h">Cuántas visitas hasta comprar</h3>
          {dist(j.visits, ['1 visita', '2 a 3 visitas', '4 a 9 visitas', '10 o más'])}
          <p className="nv-note">En promedio, {j.avgVisits?.toLocaleString('es-AR', { maximumFractionDigits: 1 })} visitas por compra (últimos 30 días de cada comprador).</p>
        </div>
        <div>
          <h3 className="nv-sub-h">Cuánto tardaron</h3>
          {dist(j.days, ['el mismo día', 'en la semana', 'más de una semana'])}
        </div>
      </div>
      <h3 className="nv-sub-h">Por dónde llegaron la primera vez y por dónde compraron</h3>
      <div className="nv-tscroll">
        <table className="nv-table">
          <thead><tr><th>Primera visita</th><th>Compró entrando por</th><th className="num">Compras</th><th className="num">Facturado</th></tr></thead>
          <tbody>
            {j.paths.slice(0, 15).map((p) => (
              <tr key={`${p.first}>${p.last}`}>
                <td><ChannelChip channel={p.first} /></td>
                <td>{p.first === p.last ? <span className="nv-mute">el mismo</span> : <ChannelChip channel={p.last} />}</td>
                <td className="num">{p.orders}</td><td className="num">{money(p.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Landings({ rows }) {
  const [sort, setSort] = useState('visits');
  const sorted = useMemo(() => {
    const r = rows.filter((l) => l.visits >= 10);
    if (sort === 'bounce') return [...r].sort((a, b) => b.bounces / b.visits - a.bounces / a.visits);
    return r;
  }, [rows, sort]);
  return (
    <>
      <div className="nv-vz-toggle">
        <button type="button" className={sort === 'visits' ? 'on' : ''} onClick={() => setSort('visits')}>Más visitadas</button>
        <button type="button" className={sort === 'bounce' ? 'on' : ''} onClick={() => setSort('bounce')}>Las que más espantan</button>
      </div>
      <div className="nv-tscroll">
        <table className="nv-table">
          <thead><tr><th>Página de entrada</th><th>Canal principal</th><th className="num">Visitas</th><th className="num">Se fueron enseguida</th><th className="num">Agregaron al carrito</th><th className="num">Compras</th></tr></thead>
          <tbody>
            {sorted.slice(0, 25).map((l) => {
              const b = ratio(l.bounces, l.visits);
              return (
                <tr key={l.path}>
                  <td className="nv-vz-path"><a href={`https://altorancho.com${l.path === '/' ? '' : l.path}`} target="_blank" rel="noreferrer">{l.path}</a></td>
                  <td><ChannelChip channel={l.channel} /></td>
                  <td className="num">{num(l.visits)}</td>
                  <td className={`num ${b >= 80 ? 'nv-bad' : ''}`}>{pct(b)}</td>
                  <td className="num">{pct(ratio(l.withCart, l.visits), { decimals: 1 })}</td>
                  <td className="num">{l.orders || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Devices({ rows }) {
  return (
    <div className="nv-tscroll">
      <table className="nv-table">
        <thead><tr><th>Dispositivo</th><th className="num">Visitas</th><th className="num">Páginas / visita</th><th className="num">Se fueron enseguida</th><th className="num">Agregaron al carrito</th><th className="num">Compras</th><th className="num">Conversión</th><th className="num">Facturado</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.device}>
              <td>{DEVICE[d.device] || d.device}</td>
              <td className="num">{num(d.visits)}</td>
              <td className="num">{d.visits ? (d.pageviews / d.visits).toLocaleString('es-AR', { maximumFractionDigits: 1 }) : '—'}</td>
              <td className="num">{pct(ratio(d.bounces, d.visits))}</td>
              <td className="num">{pct(ratio(d.withCart, d.visits), { decimals: 1 })}</td>
              <td className="num">{d.orders}</td>
              <td className="num">{pct(ratio(d.orders, d.visits), { decimals: 2 })}</td>
              <td className="num">{money(d.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Products({ rows }) {
  const [mode, setMode] = useState('views');
  const list = useMemo(() => {
    if (mode === 'cold') return rows.filter((p) => p.views >= 15).sort((a, b) => a.adds / a.views - b.adds / b.views || b.views - a.views);
    return rows;
  }, [rows, mode]);
  const max = Math.max(...rows.map((p) => p.views), 1);
  return (
    <>
      <div className="nv-vz-toggle">
        <button type="button" className={mode === 'views' ? 'on' : ''} onClick={() => setMode('views')}>Más vistos</button>
        <button type="button" className={mode === 'cold' ? 'on' : ''} onClick={() => setMode('cold')}>Mucho mirados, poco agregados</button>
      </div>
      <div className="nv-tscroll">
        <table className="nv-table">
          <thead><tr><th>Producto</th><th className="num">Vistas</th><th className="num">Personas</th><th className="num">Agregados al carrito</th><th className="num">% que lo agregó</th><th className="num">Pedidos</th><th className="num">Facturado</th></tr></thead>
          <tbody>
            {list.slice(0, 30).map((p) => (
              <tr key={p.productId}>
                <td>{p.name}</td>
                <td className="num"><div className="nv-vz-cell"><span>{num(p.views)}</span><Bar v={p.views} max={max} /></div></td>
                <td className="num">{num(p.people)}</td>
                <td className="num">{p.adds || '—'}</td>
                <td className="num">{pct(ratio(p.adds, p.people), { decimals: 1 })}</td>
                <td className="num">{p.orders || '—'}</td>
                <td className="num">{p.revenue ? money(p.revenue) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Searches({ rows }) {
  if (!rows.length) return <p className="nv-empty">Todavía no hay búsquedas registradas en este período.</p>;
  return (
    <div className="nv-tscroll">
      <table className="nv-table">
        <thead><tr><th>Buscaron</th><th className="num">Veces</th><th className="num">Visitas</th><th className="num">Agregaron al carrito</th><th className="num">Compraron</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.q}>
              <td><a href={`https://altorancho.com/search/?q=${encodeURIComponent(s.q)}`} target="_blank" rel="noreferrer">{s.q}</a></td>
              <td className="num">{s.searches}</td><td className="num">{s.sessions}</td>
              <td className={`num ${s.sessions >= 5 && !s.withCart ? 'nv-bad' : ''}`}>{pct(ratio(s.withCart, s.sessions))}</td>
              <td className="num">{s.orders || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Checkouts({ c }) {
  if (!c?.abandoned) return <p className="nv-empty">No hay checkouts abandonados en este período (se traen de Tienda Nube cada hora).</p>;
  return (
    <>
      <div className="nv-vz-tiles">
        <div><span className="nv-mute">Checkouts abandonados</span><b>{num(c.abandoned)}</b><span className="nv-mute">{money(c.value)} en carritos</span></div>
        <div><span className="nv-mute">Volvieron y compraron</span><b>{pct(ratio(c.recovered, c.abandoned))}</b><span className="nv-mute">{c.recovered} · {money(c.recovered_value)} (en 14 días)</span></div>
        <div><span className="nv-mute">Se perdieron</span><b>{money(c.value - c.recovered_value)}</b><span className="nv-mute">{c.abandoned - c.recovered} checkouts</span></div>
      </div>
      <div className="nv-grid2">
        <div>
          <h3 className="nv-sub-h">De dónde venían</h3>
          <table className="nv-table"><tbody>
            {c.byChannel.map((r) => <tr key={r.channel}><td><ChannelChip channel={r.channel} /></td><td className="num">{r.abandoned}</td><td className="num">{money(r.value)}</td></tr>)}
          </tbody></table>
        </div>
        <div>
          <h3 className="nv-sub-h">Productos que más quedan en el checkout</h3>
          <table className="nv-table"><tbody>
            {c.products.slice(0, 10).map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{p.checkouts}</td><td className="num">{money(p.value)}</td></tr>)}
          </tbody></table>
        </div>
      </div>
    </>
  );
}

export default function Visitas({ state, onLogout }) {
  const { period, date, start, end } = state;
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

  const i = data?.insights;
  return (
    <div className="nv-ventas">
      <h1 className="nv-h1">{TITLE[period]}</h1>
      <div className="nv-sub">
        Cómo navega la gente en la tienda online: de dónde viene, qué mira, qué busca, qué abandona y cuántas vueltas da antes de comprar.
        {data?.trackingSince && <> Se registra desde el {longDate(data.trackingSince)}.</>}
      </div>
      {error && <p className="nv-empty">No se pudieron traer las visitas: {error}</p>}
      {!data && !error && <div className="nv-skel-box nv-card" style={{ height: 300 }} aria-busy="true" />}
      {data && (
        <>
          <Alerts alerts={data.alerts} />
          <Section title="Visitas por canal" sub={`${num(data.total.visits)} visitas · ${num(data.total.visitors)} personas`}>
            <ChannelsTable channels={data.channels} total={data.total} />
          </Section>
          <Section title="Embudo" sub="de cada 100 que entran, cuántos llegan a cada paso"
            note="El checkout de Tienda Nube no corre nuestro script: lo que pasa ahí lo cuentan los checkouts abandonados, más abajo.">
            <Funnel funnel={i.funnel} channels={data.channels} />
          </Section>
          <Section title="Recorridos de compra" sub={`${i.journeys.orders} compras con recorrido`}>
            <Journeys j={i.journeys} />
          </Section>
          <Section title="Páginas de entrada" sub="dónde aterriza la gente y cuánta se va sin mirar nada más"
            note="En rojo, las que pierden a 8 de cada 10. Si es una página de campaña, conviene revisar el anuncio (promete otra cosa) o la página (lenta, sin stock, poco clara).">
            <Landings rows={i.landings} />
          </Section>
          <Section title="Celular vs. computadora">
            <Devices rows={i.devices} />
          </Section>
          <Section title="Productos: vistos, agregados y comprados"
            note="'Mucho mirados, poco agregados': productos que atraen pero no convencen. Suele ser precio, fotos, medidas o envío.">
            <Products rows={i.products} />
          </Section>
          <Section title="Qué buscan en la tienda" note="En rojo, búsquedas frecuentes que nunca terminan en carrito: puede faltar el producto o el buscador no lo encuentra.">
            <Searches rows={i.searches} />
          </Section>
          <Section title="Checkouts abandonados" sub="los trae Tienda Nube">
            <Checkouts c={i.checkouts} />
          </Section>
          <Section title="Links para vendedores" note="Cada venta que entre por estos links aparece como canal 'Vendedor' con el nombre en la campaña.">
            <SellerLink />
          </Section>
        </>
      )}
    </div>
  );
}
