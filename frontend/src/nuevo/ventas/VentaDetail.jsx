import { useEffect, useState } from 'react';
import { getVenta } from '../../api/client.js';
import { money } from '../format.js';
import ChannelChip from './ChannelChip.jsx';
import { chLong, when, longDate, duration, CUSTOMER } from './vFormat.js';

const DEVICE = { mobile: 'celular', desktop: 'computadora', store: 'tienda', api: 'sistema' };
const CONFIDENCE = {
  ad: 'Se sabe el anuncio exacto.',
  campaign: 'Se sabe la campaña (el link no traía el anuncio).',
  none: 'El clic no traía la campaña.',
};

function Step({ dot, title, at, children }) {
  return (
    <li className="nv-v-step">
      <span className="nv-v-dot" style={dot ? { background: dot } : undefined} aria-hidden="true" />
      <div>
        <div className="nv-v-stitle"><b>{title}</b>{at && <span className="nv-mute">{at}</span>}</div>
        {children}
      </div>
    </li>
  );
}

function Journey({ v }) {
  return (
    <ol className="nv-v-steps">
      {v.steps.map((s, i) => {
        if (s.kind === 'first') {
          return (
            <Step key={i} title="Primer contacto con la marca" at="según Google Analytics">
              <p><ChannelChip channel={s.channel} long={chLong(s.channel)} />{s.source && <span className="nv-mute"> · {s.source}{s.medium ? ` / ${s.medium}` : ''}</span>}</p>
            </Step>
          );
        }
        if (s.kind === 'history') {
          return (
            <Step key={i} title={`Ya había comprado ${s.count === 1 ? '1 vez' : `${s.count} veces`} (${money(s.revenue)})`} at={`la primera el ${longDate(s.firstAt)}`}>
              <ul className="nv-v-prior">
                {s.orders.map((h) => (
                  <li key={h.id}><span className="nv-mute">{when(h.at)}</span> <ChannelChip channel={h.channel} /> <span>#{h.number}</span> <b>{money(h.total)}</b></li>
                ))}
              </ul>
              {s.count > s.orders.length && <p className="nv-mute">y {s.count - s.orders.length} más antes</p>}
            </Step>
          );
        }
        if (s.kind === 'visit') {
          const paid = s.channel === 'meta' || s.channel === 'google';
          return (
            <Step key={i} title="Entró a la tienda" at={s.at ? when(s.at) : null}>
              <p><ChannelChip channel={s.channel} long={chLong(s.channel)} /></p>
              {paid && (
                <div className="nv-v-ad">
                  {s.thumbnail && <img src={s.thumbnail} alt="" loading="lazy" />}
                  <dl>
                    {s.ad && <><dt>Anuncio</dt><dd>{s.ad}</dd></>}
                    {s.adset && <><dt>Conjunto</dt><dd>{s.adset}</dd></>}
                    <dt>Campaña</dt><dd>{s.campaign || 'sin identificar'}</dd>
                  </dl>
                </div>
              )}
              {paid && s.confidence && <p className="nv-mute">{CONFIDENCE[s.confidence]}</p>}
              {!paid && s.utm?.source && <p className="nv-mute">link: {s.utm.source}{s.utm.medium ? ` / ${s.utm.medium}` : ''}{s.utm.campaign ? ` · ${s.utm.campaign}` : ''}</p>}
              {s.landing && (
                <p>Primera página: <b>{s.landing.type}</b>{s.landing.title ? ` · ${s.landing.title}` : ''}</p>
              )}
            </Step>
          );
        }
        if (s.kind === 'purchase') {
          return (
            <Step key={i} dot="var(--nv-ink)" title="Compró" at={when(s.at)}>
              {s.minutesSinceVisit != null && <p>{duration(s.minutesSinceVisit)} después de entrar</p>}
            </Step>
          );
        }
        if (s.kind === 'paid') {
          return <Step key={i} dot="#1BAF7A" title="Pagó" at={when(s.at)}>{s.minutesSincePurchase > 5 && <p>{duration(s.minutesSincePurchase)} después de comprar</p>}</Step>;
        }
        if (s.kind === 'after') {
          return <Step key={i} title={`Volvió a comprar ${s.count === 1 ? '1 vez' : `${s.count} veces`} después`} at={`la siguiente el ${longDate(s.nextAt)}`}><p>{money(s.revenue)} más</p></Step>;
        }
        return null;
      })}
    </ol>
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Recorrido completo (script propio en la tienda): cada visita, lo que vio y lo que agregó al carrito
function FullJourney({ t }) {
  const [all, setAll] = useState(false);
  if (!t) return null;
  if (!t.tracked) return <p className="nv-mute">{t.reason ? `Sin recorrido completo: ${t.reason}.` : 'Sin recorrido completo.'}</p>;
  const list = all ? t.timeline : t.timeline.slice(-12);
  const facts = [
    [plural(t.sessions, 'visita', 'visitas'), t.daysToBuy != null && t.sessions > 1 ? `en ${t.daysToBuy < 1 ? 'el mismo día' : plural(Math.round(t.daysToBuy), 'día', 'días')}` : null],
    [plural(t.productViews, 'producto visto', 'productos vistos'), plural(t.pageviews, 'página', 'páginas')],
    [plural(t.addToCart, 'vez agregó al carrito', 'veces agregó al carrito'), null],
    [plural(t.checkouts, 'checkout empezado', 'checkouts empezados'), null],
    [t.devices.map((d) => DEVICE[d] || d).join(' y ') || '—', t.visitors > 1 ? plural(t.visitors, 'navegador', 'navegadores') : null],
  ];
  return (
    <div className="nv-v-full">
      <dl className="nv-v-tfacts">
        {facts.map(([a, b], i) => <div key={i}><dt>{a}</dt>{b && <dd>{b}</dd>}</div>)}
      </dl>
      {t.path.length > 1 && (
        <p className="nv-v-path">{t.path.map((c, i) => <span key={i}>{i > 0 && <span className="nv-mute" aria-hidden="true"> → </span>}<ChannelChip channel={c} /></span>)}</p>
      )}
      <ol className="nv-v-sessions">
        {t.timeline.length > list.length && (
          <li><button type="button" className="nv-link" onClick={() => setAll(true)}>ver las {t.timeline.length - list.length} visitas anteriores</button></li>
        )}
        {list.map((s, i) => (
          <li key={i} className={s.purchase ? 'buy' : ''}>
            <span className="nv-mute nv-v-sat">{when(s.at)}</span>
            <span>
              <ChannelChip channel={s.channel} />
              {(s.campaign || s.source) && <span className="nv-mute"> · {s.campaign || s.source}</span>}
              <span className="nv-mute"> · {plural(s.pageviews || 0, 'página', 'páginas')}{s.productViews ? `, ${plural(s.productViews, 'producto', 'productos')}` : ''}{s.device ? ` · ${DEVICE[s.device] || s.device}` : ''}</span>
              {s.searches?.length > 0 && <span className="nv-v-seen">🔎 buscó {s.searches.map((q) => `"${q}"`).join(', ')}</span>}
              {s.products?.length > 0 && <span className="nv-v-seen">👀 {s.products.slice(0, 6).join(' · ')}{s.products.length > 6 ? ` y ${s.products.length - 6} más` : ''}</span>}
              {s.carts.map((c, j) => (
                <span key={j} className="nv-v-cart">🛒 {c.name || c.sku || 'producto'}{c.qty > 1 ? ` ×${c.qty}` : ''}</span>
              ))}
              {s.checkout && !s.purchase && <span className="nv-v-cart nv-v-ck">llegó al checkout y no compró</span>}
              {s.purchase && <b className="nv-v-cart nv-v-buy">compró</b>}
            </span>
          </li>
        ))}
      </ol>
      {t.abandonedCheckouts?.length > 0 && (
        <div className="nv-v-abandoned">
          <b>Antes había abandonado {plural(t.abandonedCheckouts.length, 'checkout', 'checkouts')}:</b>
          {t.abandonedCheckouts.map((c, i) => (
            <span key={i} className="nv-mute">{when(c.at)} · {money(c.total)} · {c.products.join(', ')}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Behavior({ b }) {
  const facts = [
    ['Desde', DEVICE[b.device] || b.device || '—'],
    ['Cuándo', `${b.weekday} ${b.hour} h`],
    ['Tardó en decidir', b.minutesToBuy == null ? '—' : b.sameSession ? `${duration(b.minutesToBuy)} (en la misma visita)` : duration(b.minutesToBuy)],
    ['¿Compró lo que vio al entrar?', b.landedOnBought == null ? '—' : b.landedOnBought ? 'Sí' : 'Se llevó otro producto'],
    ['Productos', `${b.units} ${b.units === 1 ? 'unidad' : 'unidades'}${b.lines > 1 ? ` de ${b.lines} productos` : ''}`],
    ['Descuento', b.discountPct ? `${String(b.discountPct).replace('.', ',')}%` : 'sin descuento'],
    ['Envío', b.freeShipping ? 'gratis' : money(b.shipping)],
    ['Pago', b.gateway || '—'],
  ];
  return (
    <dl className="nv-v-facts">
      {facts.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}
    </dl>
  );
}

function Economics({ e }) {
  return (
    <div className="nv-v-econ">
      <div><span className="nv-lbl">Facturó</span><b>{money(e.revenue)}</b></div>
      <div><span className="nv-lbl">Ganancia bruta</span><b>{e.grossProfit == null ? '—' : money(e.grossProfit)}</b>{e.marginPct != null && <span className="nv-mute">{String(e.marginPct).replace('.', ',')}% de margen</span>}</div>
      <div><span className="nv-lbl">Pauta (promedio)</span><b>{e.adCost == null ? '—' : money(e.adCost)}</b><span className="nv-mute">{e.adCost == null ? 'no vino de un anuncio' : 'lo que costó cada venta de ese anuncio esa semana'}</span></div>
      <div className={e.net != null && e.net < 0 ? 'neg' : e.net != null ? 'pos' : ''}><span className="nv-lbl">Le quedó</span><b>{e.net == null ? (e.grossProfit == null ? '—' : money(e.grossProfit)) : money(e.net)}</b><span className="nv-mute">{e.net == null ? 'sin costo de pauta' : 'ganancia − pauta'}</span></div>
    </div>
  );
}

export default function VentaDetail({ id, onClose }) {
  const [state, setState] = useState({ v: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ v: null, error: null });
    getVenta(id)
      .then((d) => { if (!cancelled) setState({ v: d.venta, error: null }); })
      .catch((err) => { if (!cancelled) setState({ v: null, error: err.message }); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { v, error } = state;
  const c = v && CUSTOMER[v.customer.type];
  return (
    <>
      <div className="nv-sheet-backdrop" onClick={onClose} />
      <aside className="nv-sheet nv-v-drawer" role="dialog" aria-modal="true" aria-label="Detalle de la venta">
        <button type="button" className="nv-sheet-close nv-v-close" onClick={onClose} aria-label="Cerrar">✕</button>
        {error && <p className="nv-empty">No se pudo cargar la venta: {error}</p>}
        {!v && !error && <div className="nv-skel-box nv-card" style={{ height: 400 }} aria-busy="true" />}
        {v && (
          <>
            <div className="nv-v-head">
              <h2>#{v.number} · {money(v.total)}</h2>
              <p>
                {v.customerName || 'Sin nombre'} · {when(v.createdAt)}
                {' '}<span className={`nv-v-cust ${c.tone}`}>{c.label}</span>
                {v.status !== 'pagada' && <span className="nv-v-cust nt">{v.status}</span>}
              </p>
              {v.customer.type === 'recurrente' && <p className="nv-mute">En total nos compró {money(v.customer.lifetimeRevenue)}</p>}
            </div>

            <h3 className="nv-v-h">El recorrido</h3>
            <Journey v={v} />

            {v.tracking && (
              <>
                <h3 className="nv-v-h">Todas sus visitas</h3>
                <FullJourney t={v.tracking} />
              </>
            )}

            <h3 className="nv-v-h">Lo que dejó</h3>
            <Economics e={v.economics} />
            {v.economics.costCoverage != null && v.economics.costCoverage < 1 && (
              <p className="nv-mute">Hay productos sin costo en Odoo: se estimaron con el margen del resto del pedido.</p>
            )}

            <h3 className="nv-v-h">Cómo compró</h3>
            <Behavior b={v.behavior} />

            <h3 className="nv-v-h">Productos</h3>
            <ul className="nv-v-items">
              {v.items.map((it, i) => (
                <li key={i}>
                  <span><span className="nv-name">{it.name}</span><span className="nv-mute">{it.sku || 'sin SKU'} · {it.qty} u.{it.unitCost != null ? ` · costo ${money(it.unitCost)}` : ' · sin costo en Odoo'}</span></span>
                  <b>{money(it.price * it.qty)}</b>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </>
  );
}
