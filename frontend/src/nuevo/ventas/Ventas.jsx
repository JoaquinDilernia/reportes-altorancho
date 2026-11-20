import { useCallback, useEffect, useState } from 'react';
import { getVentas } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import { money } from '../format.js';
import ChannelChip from './ChannelChip.jsx';
import VentaDetail from './VentaDetail.jsx';
import { chShort, chColor, when, CUSTOMER } from './vFormat.js';

const TITLE = { week: 'Ventas web de la semana', month: 'Ventas web del mes', custom: 'Ventas web del rango' };
const CHANNEL_ORDER = ['meta', 'google', 'pinterest', 'organic', 'social_organic', 'email', 'whatsapp', 'vendedor', 'influencer', 'ai', 'other', 'unknown'];

function ChannelFilter({ summary, channel, onChange }) {
  if (!summary) return null;
  const by = new Map(summary.channels.map((c) => [c.channel, c]));
  const list = CHANNEL_ORDER.filter((c) => by.get(c)?.orders > 0);
  return (
    <div className="nv-v-chips" role="group" aria-label="Filtrar por origen">
      <button type="button" className={!channel ? 'on' : ''} aria-pressed={!channel} onClick={() => onChange(null)}>
        <span>Todas</span><b>{summary.orders}</b><span className="nv-mute">{money(summary.revenue)}</span>
      </button>
      {list.map((c) => (
        <button type="button" key={c} className={channel === c ? 'on' : ''} aria-pressed={channel === c} onClick={() => onChange(channel === c ? null : c)}>
          <span><span className="nv-dot" style={{ background: chColor(c) }} />{chShort(c)}</span>
          <b>{by.get(c).orders}</b>
          <span className="nv-mute">{money(by.get(c).revenue)}</span>
        </button>
      ))}
    </div>
  );
}

export default function Ventas({ state, onLogout }) {
  const { period, date, start, end } = state;
  const [channel, setChannel] = useState(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState({ items: [], nextCursor: null, summary: null, typesReady: false });
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  // La búsqueda espera a que se deje de escribir.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const params = useCallback((extra = {}) => ({ ...periodParams({ period, date, start, end }), channel, q: query, ...extra }), [period, date, start, end, channel, query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getVentas(params())
      .then((d) => {
        if (cancelled) return;
        setList((prev) => ({ items: d.items, nextCursor: d.nextCursor, summary: d.summary || prev.summary, typesReady: d.customerTypesReady }));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        if (err.message === 'Unauthorized') onLogout?.();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [params, onLogout]);

  const loadMore = () => {
    setMore(true);
    getVentas(params({ cursor: list.nextCursor }))
      .then((d) => setList((prev) => ({ ...prev, items: [...prev.items, ...d.items], nextCursor: d.nextCursor })))
      .catch((err) => setError(err.message))
      .finally(() => setMore(false));
  };

  const closeDetail = useCallback(() => setOpen(null), []);

  return (
    <div className="nv-ventas">
      <h1 className="nv-h1">{TITLE[period]}</h1>
      <div className="nv-sub">Cada pedido de la tienda online: de dónde vino, por dónde pasó antes y cuánto dejó. Tocá una venta para ver su recorrido.</div>

      <ChannelFilter summary={list.summary} channel={channel} onChange={setChannel} />

      <section className="nv-card nv-sec">
        <div className="nv-titlebar">
          <div className="nv-h"><h2>Pedidos</h2>{list.summary && <span>ticket promedio {money(list.summary.avgTicket)}</span>}</div>
          <label className="nv-v-search">
            <span className="nv-sr">Buscar</span>
            <input type="search" placeholder="Nº de pedido, cliente, mail o producto" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        {error && <p className="nv-empty">No se pudieron traer las ventas: {error}</p>}
        {loading && !error && <div className="nv-skel-box nv-card" style={{ height: 300 }} aria-busy="true" />}
        {!loading && !error && list.items.length === 0 && <p className="nv-empty">No hay ventas con ese filtro.</p>}
        {!loading && list.items.length > 0 && (
          <div className="nv-tscroll">
            <table className="nv-table nv-v-table">
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Vino por</th>
                  <th>Campaña / anuncio</th>
                  <th title="Primer contacto con la marca según Google Analytics">Primer contacto</th>
                  <th className="r">Total</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((it) => {
                  const ct = it.customerType && CUSTOMER[it.customerType];
                  return (
                    <tr key={it.id} className={`nv-v-row ${it.status !== 'pagada' ? 'unpaid' : ''}`} tabIndex={0}
                      onClick={() => setOpen(it.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(it.id); } }}>
                      <td className="nv-mute">{when(it.createdAt)}</td>
                      <td>#{it.number}{it.status !== 'pagada' && <span className="nv-v-cust nt">{it.status}</span>}</td>
                      <td>
                        <span className="nv-ellip nv-v-name">{it.customerName || '—'}</span>
                        {ct && ct.tone !== 'nt' && <span className={`nv-v-cust ${ct.tone}`}>{ct.label}</span>}
                      </td>
                      <td><ChannelChip channel={it.channel} /></td>
                      <td><span className="nv-ellip nv-v-camp" title={[it.campaign, it.ad].filter(Boolean).join(' · ')}>{it.ad || it.campaign || <span className="nv-mute">—</span>}</span></td>
                      <td>{it.firstChannel && it.firstChannel !== it.channel ? <ChannelChip channel={it.firstChannel} /> : <span className="nv-mute">{it.firstChannel ? 'el mismo' : '—'}</span>}</td>
                      <td className="r"><b>{money(it.total)}</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && list.nextCursor && (
          <button type="button" className="nv-btn nv-v-more" onClick={loadMore} disabled={more}>{more ? 'Cargando…' : 'Ver más ventas'}</button>
        )}
        <p className="nv-note">
          “Vino por” es el último clic antes de comprar (lo que guarda Tienda Nube). “Primer contacto” es cómo nos conoció según Google Analytics: tarda unas horas en aparecer.
          {!list.typesReady && ' La marca nuevo/recurrente aparece cuando termina de calcularse (en el tablero de Pauta o al recargar en un minuto).'}
        </p>
      </section>

      {open && <VentaDetail id={open} onClose={closeDetail} />}
    </div>
  );
}
