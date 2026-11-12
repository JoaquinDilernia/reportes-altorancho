import { useEffect, useState } from 'react';
import { getEventBehavior } from '../../api/client.js';
import { compactMoney, pctChange } from '../../lib/eventLive.js';
import { formatNumber } from '../../lib/format.js';
import Delta from './Delta.jsx';
import { shortDate } from './shared.js';

// Web behaviour from GA4 (own endpoint, refreshed every 30 min): funnel,
// traffic sources, devices, categories viewed vs bought, products with
// interest but no sales, searches, landing pages and hours. Volumes are
// compared per day, since this year's event runs longer than last year's.
const REFRESH_MS = 30 * 60 * 1000;

const CHANNELS = {
  'Cross-network': 'Google PMax / Demand Gen',
  'Paid Social': 'Redes pagas (Meta)',
  'Paid Search': 'Google búsqueda paga',
  'Organic Social': 'Redes orgánicas',
  Direct: 'Directo',
  Email: 'Email',
  'Organic Search': 'Google orgánico',
  Unassigned: 'Sin asignar',
  'Organic Video': 'Video orgánico',
  Referral: 'Referidos',
  'Organic Shopping': 'Shopping orgánico',
  'AI Assistant': 'Asistentes de IA',
  'Paid Other': 'Otros pagos',
};
const DEVICES = { mobile: 'Celular', desktop: 'Computadora', tablet: 'Tablet', 'smart tv': 'Smart TV' };
const VISITORS = { new: 'Nuevos', returning: 'Ya conocían el sitio' };

const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d).replace('.', ',')}%`);
const perDay = (v, days) => (days ? v / days : 0);
const mmss = (sec) => (sec == null ? '—' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);

function Kpis({ b }) {
  const { cur, prev } = b.totals;
  const dc = b.ranges.cur.days;
  const dp = b.ranges.prev.days;
  const items = [
    { l: 'Sesiones por día', v: formatNumber(Math.round(perDay(cur.sessions, dc))), d: pctChange(perDay(cur.sessions, dc), perDay(prev.sessions, dp)), s: `${formatNumber(cur.sessions)} en total` },
    { l: 'Conversión', v: pct(cur.conversion, 2), d: pctChange(cur.conversion, prev.conversion), s: `${b.prevYear}: ${pct(prev.conversion, 2)} · compras ÷ sesiones` },
    { l: 'Compras por día', v: formatNumber(Math.round(perDay(cur.purchases, dc))), d: pctChange(perDay(cur.purchases, dc), perDay(prev.purchases, dp)), s: `${formatNumber(cur.purchases)} en total (GA4)` },
    { l: 'Páginas por sesión', v: cur.pagesPerSession?.toFixed(1).replace('.', ',') ?? '—', d: pctChange(cur.pagesPerSession, prev.pagesPerSession), s: `${b.prevYear}: ${prev.pagesPerSession?.toFixed(1).replace('.', ',') ?? '—'}` },
    { l: 'Tiempo por sesión', v: mmss(cur.avgSessionSec), d: pctChange(cur.avgSessionSec, prev.avgSessionSec), s: `${b.prevYear}: ${mmss(prev.avgSessionSec)}` },
    { l: 'Usuarios nuevos', v: pct(cur.users ? cur.newUsers / cur.users : null, 0), d: null, s: `${formatNumber(cur.newUsers)} de ${formatNumber(cur.users)}` },
  ];
  return (
    <div className="ev-bkpis">
      {items.map(k => (
        <div className="ev-panel ev-bkpi" key={k.l}>
          <div className="ev-l">{k.l}</div>
          <div className="v num">{k.v} {k.d != null && <Delta pct={k.d} title={`vs ${b.prevYear}`} />}</div>
          <div className="ev-sub">{k.s}</div>
        </div>
      ))}
    </div>
  );
}

function Funnel({ b }) {
  const top = b.funnel.cur[0]?.users || 1;
  const topPrev = b.funnel.prev[0]?.users || 1;
  return (
    <div className="ev-panel">
      <div className="ev-l" style={{ marginBottom: 12 }}>Embudo (usuarios)</div>
      {b.funnel.cur.map((s, i) => {
        const p = b.funnel.prev[i];
        const share = s.users / top;
        const prevShare = (p?.users || 0) / topPrev;
        const step = i ? s.users / (b.funnel.cur[i - 1].users || 1) : null;
        return (
          <div className="ev-fstep" key={s.id}>
            <div className="ev-frow"><span>{s.label}</span><b className="num">{formatNumber(s.users)}</b></div>
            <div className="ev-fbar"><i style={{ width: `${Math.max(share * 100, 0.6)}%` }} /><em style={{ left: `${Math.min(prevShare * 100, 100)}%` }} title={`${b.prevYear}: ${pct(prevShare)}`} /></div>
            <div className="ev-sub num">
              {pct(share)} del total{step != null && <> · {pct(step)} del paso anterior</>} · {b.prevYear}: {pct(prevShare)}
            </div>
          </div>
        );
      })}
      <div className="ev-note">
        La marca blanca es {b.prevYear}. Los pasos del checkout (envío, pago) no se muestran: en GA4 aparecen menos en {b.year} que en {b.prevYear} con más compras, o sea que su medición cambió.
      </div>
    </div>
  );
}

function SplitCards({ b, rows, labels, title }) {
  const total = rows.reduce((s, r) => s + (r.cur?.sessions || 0), 0) || 1;
  const totalRev = rows.reduce((s, r) => s + (r.cur?.revenue || 0), 0) || 1;
  return (
    <div className="ev-panel">
      <div className="ev-l" style={{ marginBottom: 12 }}>{title}</div>
      <div className="ev-split">
        {rows.filter(r => (r.cur?.sessions || 0) / total > 0.005).map(r => (
          <div key={r.key}>
            <div className="ev-sub">{labels[r.key] || r.key}</div>
            <div className="v num">{pct((r.cur?.sessions || 0) / total, 0)} <span className="ev-sub">de las visitas</span></div>
            <div className="ev-sub num">
              {pct((r.cur?.revenue || 0) / totalRev, 0)} de la facturación · convierte {pct(r.cur?.conversion, 2)}
              <span className="ev-dim"> ({b.prevYear}: {pct(r.prev?.conversion, 2)})</span>
            </div>
            {r.cur?.purchases > 0 && <div className="ev-sub num">ticket {compactMoney(r.cur.revenue / r.cur.purchases)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Channels({ b }) {
  const total = b.channels.reduce((s, r) => s + (r.cur?.sessions || 0), 0) || 1;
  const rows = b.channels.filter(r => (r.cur?.sessions || 0) >= 100);
  const dc = b.ranges.cur.days;
  const dp = b.ranges.prev.days;
  return (
    <div className="ev-panel ev-tscroll">
      <table className="ev-table num">
        <thead>
          <tr>
            <th>Fuente</th><th>Sesiones</th><th>% visitas</th><th>vs {String(b.prevYear).slice(2)} / día</th>
            <th className="sepL">Compras</th><th>Facturación</th><th>Conversión</th><th>{String(b.prevYear).slice(2)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className={(r.cur?.sessions || 0) >= 5000 && r.cur.conversion < 0.002 ? 'ev-flag' : ''}>
              <td>{CHANNELS[r.key] || r.key}</td>
              <td>{formatNumber(r.cur?.sessions || 0)}</td>
              <td>{pct((r.cur?.sessions || 0) / total, 0)}</td>
              <td>{(r.prev?.sessions || 0) >= 100 ? <Delta pct={pctChange(perDay(r.cur?.sessions || 0, dc), perDay(r.prev.sessions, dp))} /> : <span className="ev-delta new">nuevo</span>}</td>
              <td className="sepL">{formatNumber(r.cur?.purchases || 0)}</td>
              <td>{compactMoney(r.cur?.revenue || 0)}</td>
              <td><b>{pct(r.cur?.conversion, 2)}</b></td>
              <td className="ev-dim">{pct(r.prev?.conversion, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ev-note">
        Fuente = canal por defecto de GA4 (último clic). En rojo, las fuentes que traen mucha visita y convierten menos de 0,2%.
        Facturación según GA4, con IVA y envío: no coincide exacto con Odoo.
      </div>
    </div>
  );
}

// No year-over-year here: many 2025 products are no longer in the catalog,
// so last year's views can't be put in categories reliably.
function Categories({ b }) {
  const maxViews = Math.max(...b.items.categories.map(c => c.views), 1);
  const totalViews = b.items.categories.reduce((s, c) => s + c.views, 0) || 1;
  return (
    <div className="ev-panel ev-tscroll">
      <table className="ev-table num ev-bcat">
        <thead>
          <tr>
            <th>Categoría</th><th style={{ width: '28%' }} /><th>Vistas</th><th>% de las vistas</th>
            <th className="sepL">% al carrito</th><th>% compra</th><th>Unidades</th>
          </tr>
        </thead>
        <tbody>
          {b.items.categories.map(c => (
            <tr key={c.id}>
              <td>{c.label}</td>
              <td><div className="ev-hbar"><i style={{ width: `${(c.views / maxViews) * 100}%` }} /></div></td>
              <td>{formatNumber(c.views)}</td>
              <td>{pct(c.views / totalViews, 0)}</td>
              <td className="sepL">{pct(c.cartRate)}</td>
              <td><b>{pct(c.buyRate, 2)}</b></td>
              <td>{formatNumber(c.purchases)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ev-note">
        Vistas = veces que se abrió un producto de la categoría. Categorías de Odoo (las de Tienda Nube dicen "Alto Cyber" casi todas);
        {' '}{pct(b.items.matchedViewShare, 0)} de las vistas se cruzaron con el catálogo. % compra = unidades compradas ÷ vistas.
        Sin comparación con {b.prevYear}: muchos productos de entonces ya no están en el catálogo y no se pueden ubicar en su categoría.
      </div>
    </div>
  );
}

function ItemTable({ rows, showStock }) {
  return (
    <table className="ev-table num ev-btbl">
      <thead>
        <tr><th>Producto</th><th>Vistas</th><th>Carrito</th><th>Compras</th><th>% compra</th>{showStock && <th>Stock web</th>}</tr>
      </thead>
      <tbody>
        {rows.map(i => (
          <tr key={i.name}>
            <td className="name" title={i.name}>{i.name}<span className="ev-sub ev-cat2">{i.category}</span></td>
            <td>{formatNumber(i.views)}</td>
            <td>{formatNumber(i.carts)}</td>
            <td><b>{formatNumber(i.purchases)}</b></td>
            <td>{pct(i.buyRate, 2)}</td>
            {showStock && <td className={i.webStock != null && i.webStock <= 3 ? 'ev-neg' : ''}>{i.webStock ?? '—'}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Searches({ b }) {
  const max = b.searches[0]?.count || 1;
  return (
    <div className="ev-panel">
      <div className="ev-l" style={{ marginBottom: 12 }}>Lo que más buscaron en el sitio</div>
      <div className="ev-search">
        {b.searches.slice(0, 15).map(s => (
          <div key={s.term} className="ev-srow">
            <span>{s.term}</span>
            <div className="ev-hbar"><i style={{ width: `${(s.count / max) * 100}%` }} /></div>
            <b className="num">{formatNumber(s.count)}</b>
          </div>
        ))}
      </div>
      <div className="ev-note">Búsquedas con resultados, juntando mayúsculas/minúsculas.</div>
    </div>
  );
}

function Landings({ b }) {
  return (
    <div className="ev-panel ev-tscroll">
      <div className="ev-l" style={{ marginBottom: 8 }}>Página por la que entraron</div>
      <table className="ev-table num ev-btbl">
        <thead><tr><th>Página</th><th>Sesiones</th><th>Compras</th><th>Conversión</th></tr></thead>
        <tbody>
          {b.landings.filter(l => l.page !== '(not set)').map(l => (
            <tr key={l.page} className={l.sessions > 3000 && l.conversion < 0.001 ? 'ev-flag' : ''}>
              <td className="name" title={l.page}>{l.label}</td>
              <td>{formatNumber(l.sessions)}</td>
              <td>{formatNumber(l.purchases)}</td>
              <td><b>{pct(l.conversion, 2)}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ev-note">En rojo: páginas que reciben mucha visita (seguramente de anuncios) y casi no venden.</div>
    </div>
  );
}

function Hours({ b }) {
  const maxS = Math.max(...b.hourly.map(h => h.sessions), 1);
  const maxC = Math.max(...b.hourly.map(h => h.conversion || 0), 0.0001);
  return (
    <div className="ev-panel">
      <div className="ev-l" style={{ marginBottom: 12 }}>Por hora: visitas (barra) y conversión (punto)</div>
      <div className="ev-hours">
        {b.hourly.map(h => (
          <div key={h.hour} className="ev-hcol" title={`${h.hour} h · ${formatNumber(h.sessions)} sesiones · ${formatNumber(h.purchases)} compras · conv. ${pct(h.conversion, 2)}`}>
            <div className="ev-hplot">
              <i style={{ height: `${(h.sessions / maxS) * 100}%` }} />
              {h.conversion != null && <em style={{ bottom: `${((h.conversion || 0) / maxC) * 100}%` }} />}
            </div>
            <span>{h.hour}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Daily({ b }) {
  const max = Math.max(...b.daily.map(d => d.sessions), 1);
  return (
    <div className="ev-panel">
      <div className="ev-l" style={{ marginBottom: 12 }}>Por día: sesiones y conversión</div>
      <div className="ev-hours">
        {b.daily.map(d => (
          <div key={d.date} className="ev-hcol" title={`${shortDate(d.date)} · ${formatNumber(d.sessions)} sesiones · ${formatNumber(d.carts)} al carrito · ${formatNumber(d.purchases)} compras`}>
            <div className="ev-hplot"><i style={{ height: `${(d.sessions / max) * 100}%` }} /></div>
            <span>{shortDate(d.date)}</span>
            <small className="num">{pct(d.conversion, 2)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function Regions({ b }) {
  const total = b.regions.reduce((s, r) => s + r.sessions, 0) || 1;
  return (
    <div className="ev-panel">
      <div className="ev-l" style={{ marginBottom: 12 }}>Desde dónde entran</div>
      <div className="ev-search">
        {b.regions.slice(0, 8).map(r => (
          <div key={r.region} className="ev-srow">
            <span>{r.region === 'Buenos Aires' ? 'CABA' : r.region === 'Buenos Aires Province' ? 'Prov. Buenos Aires' : r.region.replace(' Province', '')}</span>
            <div className="ev-hbar"><i style={{ width: `${Math.min((r.sessions / total) * 200, 100)}%` }} /></div>
            <b className="num">{pct(r.conversion, 2)}</b>
          </div>
        ))}
      </div>
      <div className="ev-note">Barra = visitas; número = conversión. Top 10 regiones: {formatNumber(total)} sesiones.</div>
    </div>
  );
}

export default function WebBehavior({ eventId, onLogout }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setB(null);
    setError(null);
    const load = () => getEventBehavior(eventId)
      .then(d => { if (!cancelled) { setB(d); setError(null); } })
      .catch(err => {
        if (cancelled) return;
        if (err.message === 'Unauthorized') { onLogout?.(); return; }
        setError(err.message);
      });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [eventId, onLogout]);

  if (error && !b) return <div className="ev-panel"><div className="ev-empty">No se pudo cargar GA4: {error}</div></div>;
  if (!b) return <div className="ev-panel"><div className="ev-empty">Cargando comportamiento web (GA4)…</div></div>;
  if (!b.available) return <div className="ev-panel"><div className="ev-empty">{b.reason}</div></div>;

  const range = `${shortDate(b.ranges.cur.start)}–${shortDate(b.ranges.cur.end)} (${b.ranges.cur.days} días) vs ${shortDate(b.ranges.prev.start)}–${shortDate(b.ranges.prev.end)}/${String(b.prevYear).slice(2)} (${b.ranges.prev.days} días)`;
  return (
    <>
      <h2 className="ev-sec">
        Comportamiento en la web
        <small>GA4 · {range} · volúmenes comparados por día · se actualiza cada 30 min (GA4 tiene unas horas de demora)</small>
      </h2>
      <Kpis b={b} />
      <div className="ev-grid2" style={{ marginTop: 18 }}>
        <Funnel b={b} />
        <div className="ev-bstack">
          <SplitCards b={b} rows={b.devices} labels={DEVICES} title="Celular vs computadora" />
          <SplitCards b={b} rows={b.visitors} labels={VISITORS} title="Nuevos vs ya conocían el sitio" />
        </div>
      </div>

      <h2 className="ev-sec">De dónde vienen <small>sesiones y conversión por fuente de tráfico</small></h2>
      <Channels b={b} />

      <h2 className="ev-sec">Qué miran vs qué compran <small>categorías vistas en {b.year}, con su tasa de carrito y de compra</small></h2>
      <Categories b={b} />

      <h2 className="ev-sec">Productos <small>los más vistos, los que miran mucho y no compran, y los que mejor convierten</small></h2>
      <div className="ev-grid2">
        <div className="ev-panel ev-tscroll">
          <div className="ev-l" style={{ marginBottom: 8 }}>Mucho interés, poca venta</div>
          <ItemTable rows={b.items.lowConversion} showStock />
          <div className="ev-note">Productos con 2.000 vistas o más, ordenados de menor a mayor % de compra. Stock web de Tienda Nube (en rojo, 3 o menos): ahí puede estar la explicación, o en el precio o el anuncio.</div>
        </div>
        <div className="ev-panel ev-tscroll">
          <div className="ev-l" style={{ marginBottom: 8 }}>Los más vistos</div>
          <ItemTable rows={b.items.topViewed.slice(0, 10)} showStock />
        </div>
      </div>
      <div className="ev-grid2" style={{ marginTop: 18 }}>
        <div className="ev-panel ev-tscroll">
          <div className="ev-l" style={{ marginBottom: 8 }}>Los que mejor convierten (1.000 vistas o más)</div>
          <ItemTable rows={b.items.bestConversion} showStock />
        </div>
        <Searches b={b} />
      </div>

      <h2 className="ev-sec">Cuándo y por dónde entran</h2>
      <div className="ev-grid2">
        <Landings b={b} />
        <div className="ev-bstack">
          <Hours b={b} />
          <Daily b={b} />
          <Regions b={b} />
        </div>
      </div>
    </>
  );
}
