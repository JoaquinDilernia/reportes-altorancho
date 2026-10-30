import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getEventReport } from '../../api/client.js';
import { formatNumber } from '../../lib/format.js';
import {
  groupView, crossedMilestones, milestoneText, minutesAgo, buildTicker, loadSeen, markSeen, compactMoney,
} from '../../lib/eventLive.js';
import {
  weekday, shortDate, ratio, roasText, pctText, statusClass, statusLabel, sumAds, VIEW_LABELS,
} from './shared.js';
import FlapCounter from './FlapCounter.jsx';
import GoalTrack from './GoalTrack.jsx';
import TodayRing from './TodayRing.jsx';
import SalesFeed from './SalesFeed.jsx';
import Ticker from './Ticker.jsx';
import CelebrationToast from './CelebrationToast.jsx';
import CategoryRace from './CategoryRace.jsx';
import AdsPacing from './AdsPacing.jsx';
import DayByDayTable from './DayByDayTable.jsx';
import EventDetails from './EventDetails.jsx';
import '../../styles/event.css';

const POLL_MS = 2 * 60 * 1000;
const EVENTS = [{ id: 'cyber', label: 'Cyber' }, { id: 'black', label: 'Black' }];
const VIEWS = [{ id: 'total', label: 'Total' }, { id: 'web', label: 'Web' }, { id: 'locales', label: 'Locales' }];

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function phaseOf(data) {
  if (data.today < data.current.start) return 'pre';
  if (data.today > data.current.end) return 'post';
  return 'live';
}

function dayPhaseLabel(data) {
  const day = data.days.find(d => d.date === data.today);
  if (!day) return null;
  if (day.isLaunch) return 'lanzamiento';
  if (day.phase === 'oficial') {
    const n = data.days.filter(d => d.phase === 'oficial' && d.date <= day.date).length;
    return `día oficial ${n}`;
  }
  return day.phase === 'extension' ? 'extensión' : 'previa';
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div className="ev-seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.id} type="button" className={value === o.id ? 'on' : undefined} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Topbar({ data, eventId, onEvent, view, onView, now, stale }) {
  const label = data?.label ?? EVENTS.find(e => e.id === eventId).label;
  const year = data ? String(data.current.year).slice(2) : '26';
  let line = null;
  if (data) {
    const phase = phaseOf(data);
    const ago = minutesAgo(data.live?.updatedAt, now);
    const agoText = ago == null ? null : `act. hace ${ago} min`;
    const dateText = `${weekday(data.today).toLowerCase()} ${shortDate(data.today)}`;
    if (phase === 'live') {
      line = <span className="ev-live"><span className="ev-dot" />{['en vivo', dateText, dayPhaseLabel(data), agoText].filter(Boolean).join(' · ')}</span>;
    } else if (phase === 'pre') {
      const n = daysBetween(data.today, data.current.start);
      line = <span className="ev-live off"><span className="ev-dot" />{`cuenta regresiva · arranca el ${weekday(data.current.start).toLowerCase()} ${shortDate(data.current.start)} · faltan ${n} ${n === 1 ? 'día' : 'días'}`}</span>;
    } else {
      line = <span className="ev-live off"><span className="ev-dot" />{['terminó', `${shortDate(data.current.start)} al ${shortDate(data.current.end)}`, agoText].filter(Boolean).join(' · ')}</span>;
    }
  }
  return (
    <div className="ev-topbar">
      <div className="ev-brand">Alto<em>{label}</em> {year}</div>
      {line}
      {stale && <span className="ev-stale">no se pudo actualizar, reintento en 2 min</span>}
      <div className="ev-segs">
        <Segmented options={EVENTS} value={eventId} onChange={onEvent} label="Evento" />
        <Segmented options={VIEWS} value={view} onChange={onView} label="Vista" />
      </div>
    </div>
  );
}

function Tile({ label, value, chip, chipClass = '' }) {
  return (
    <div className="ev-tile">
      <div className="ev-l">{label}</div>
      <div className="v num">{value}</div>
      {chip && <span className={`ev-chip ${chipClass}`}>{chip}</span>}
    </div>
  );
}

function adsSummary(days) {
  const played = days.filter(d => d.played);
  const actual = sumAds(played, d => d.ads?.actual);
  const prev = sumAds(played, d => d.ads?.prev);
  const plan = days.reduce((s, d) => s + (d.ads?.plan?.meta || 0) + (d.ads?.plan?.google || 0), 0);
  const roas = {
    meta: ratio(actual.meta.value, actual.meta.spend),
    google: ratio(actual.google.value, actual.google.spend),
    prevMeta: ratio(prev.meta.value, prev.meta.spend),
    prevGoogle: ratio(prev.google.value, prev.google.spend),
  };
  return { spent: actual.meta.spend + actual.google.spend, plan, roas };
}

function roasChipClass({ meta, google, prevMeta, prevGoogle }) {
  if ([meta, google, prevMeta, prevGoogle].some(v => v == null)) return '';
  const up = (meta >= prevMeta) + (google >= prevGoogle);
  return up === 2 ? 'g' : up === 0 ? 'r' : 'y';
}

function projectionChip(projection, v) {
  if (projection == null) return ['sin datos todavía', ''];
  if (v.target > 0 && projection >= v.target) return ['pasa el objetivo', 'g'];
  if (v.floor > 0 && projection >= v.floor) return ['pasa el piso, no el obj.', 'y'];
  return ['no llega al piso', 'r'];
}

function todayChip(v, phase) {
  if (phase === 'post') return null;
  return v.today.pct != null ? `${Math.round(v.today.pct)}% del obj. a esta hora` : 'todavía sin datos';
}

function LiveHero({ data, v, view, phase }) {
  const ads = adsSummary(data.days);
  const realPct = v.floorElapsed ? (v.revenue / v.floorElapsed - 1) * 100 : null;
  const avgTicket = v.orders ? v.revenue / v.orders : null;
  const [projText, projClass] = projectionChip(v.projection, v);
  return (
    <div className="ev-panel">
      <div className="ev-l">Facturado {data.label} {data.current.year} · {VIEW_LABELS[view]}</div>
      <FlapCounter value={v.revenue} />
      <div className="ev-sub">
        {formatNumber(v.orders)} ventas
        {avgTicket != null && <> · ticket promedio {compactMoney(avgTicket)}</>}
        {realPct != null && (
          <> · <span className={realPct >= 0 ? 'pos' : 'neg'}>{pctText(realPct, { sign: true })} real vs mismos días {data.previous.year}</span></>
        )}
      </div>
      <GoalTrack value={v.revenue} floor={v.floor} target={v.target} />
      <div className="ev-tiles">
        <Tile
          label="Hoy"
          value={v.today.revenue == null ? '—' : compactMoney(v.today.revenue)}
          chip={todayChip(v, phase)}
          chipClass={statusClass(v.today.status)}
        />
        <Tile label="Si seguimos así" value={v.projection == null ? '—' : compactMoney(v.projection)} chip={projText} chipClass={projClass} />
        <Tile label="Pauta invertida" value={compactMoney(ads.spent)} chip={`de ${compactMoney(ads.plan)} del plan`} />
        <Tile
          label="ROAS Meta · Google"
          value={`${roasText(ads.roas.meta)} · ${roasText(ads.roas.google)}`}
          chip={`vs ${roasText(ads.roas.prevMeta)} · ${roasText(ads.roas.prevGoogle)} ${data.previous.year}`}
          chipClass={roasChipClass(ads.roas)}
        />
      </div>
    </div>
  );
}

function recapFor(data, view) {
  const groups = view === 'total' ? ['web', 'locales'] : [view];
  const rec = groups.map(g => data.previousRecap?.[g]).filter(Boolean);
  const revenue = rec.reduce((s, r) => s + r.revenue, 0);
  const orders = rec.reduce((s, r) => s + r.orders, 0);
  return { revenue, orders, avgTicket: orders ? revenue / orders : null };
}

function CountdownHero({ data, v, view }) {
  const n = daysBetween(data.today, data.current.start);
  const recap = recapFor(data, view);
  const prevAds = sumAds(data.days, d => d.ads?.prev);
  const plan = data.days.reduce((s, d) => s + (d.ads?.plan?.meta || 0) + (d.ads?.plan?.google || 0), 0);
  return (
    <div className="ev-panel">
      <div className="ev-l">{data.label} {data.current.year} · {VIEW_LABELS[view]} · arranca el {weekday(data.current.start).toLowerCase()} {shortDate(data.current.start)}</div>
      <div className="ev-countdown">Faltan <em className="num">{n}</em> {n === 1 ? 'día' : 'días'}</div>
      <div className="ev-sub">
        {data.label} {data.previous.year}: {compactMoney(recap.revenue)} facturados · {formatNumber(recap.orders)} ventas
        {recap.avgTicket != null && <> · ticket promedio {compactMoney(recap.avgTicket)}</>}
      </div>
      <GoalTrack value={0} floor={v.floor} target={v.target} />
      <div className="ev-tiles">
        <Tile label="Piso" value={compactMoney(v.floor)} chip={`${data.previous.year} + inflación`} />
        <Tile label="Objetivo" value={compactMoney(v.target)} chip="piso + crecimiento real" />
        <Tile label="Plan de pauta" value={compactMoney(plan)} chip="Meta + Google" />
        <Tile
          label={`ROAS ${data.previous.year} Meta · Google`}
          value={`${roasText(ratio(prevAds.meta.value, prevAds.meta.spend))} · ${roasText(ratio(prevAds.google.value, prevAds.google.spend))}`}
          chip="días alineados"
        />
      </div>
    </div>
  );
}

// Status against the floor/target of the time elapsed (today pro-rated).
function GroupRow({ label, data, group }) {
  const totals = groupView(data, group);
  return (
    <div className="row">
      <span className="ev-l">{label}</span>
      <span>
        <b className="num">{compactMoney(totals?.revenue ?? 0)}</b>{' '}
        <span className={`ev-chip ${statusClass(totals?.status)}`}>{statusLabel(totals?.status)}</span>
      </span>
    </div>
  );
}

function filterFeed(feed, view) {
  if (view === 'web') return feed.filter(f => f.channel === 'ecommerce');
  if (view === 'locales') return feed.filter(f => f.channel !== 'ecommerce');
  return feed;
}

function Side({ data, v, view, now, phase }) {
  const vsPrev = v.todayPrev ? (v.today.revenue / v.todayPrev - 1) * 100 : null;
  if (phase === 'pre') {
    return (
      <div className="ev-side">
        <div className="ev-panel">
          <div className="ev-l" style={{ marginBottom: 10 }}>Cómo fue {data.label} {data.previous.year}</div>
          <div className="ev-split">
            {['web', 'locales'].map(g => data.previousRecap?.[g] && (
              <div className="row" key={g}>
                <span className="ev-l">{g === 'web' ? 'Web' : 'Locales'}</span>
                <span><b className="num">{compactMoney(data.previousRecap[g].revenue)}</b> <span className="ev-sub">{formatNumber(data.previousRecap[g].orders)} ventas</span></span>
              </div>
            ))}
          </div>
          <div className="ev-note">El contador, el feed de ventas y los festejos arrancan cuando empieza el evento.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="ev-side">
      <div className="ev-panel ev-ringrow">
        <TodayRing pct={v.today.pct} />
        <div className="ev-split">
          <GroupRow label="Web" data={data} group="web" />
          <GroupRow label="Locales" data={data} group="locales" />
          <div className="row">
            <span className="ev-l">Hoy vs mismo día {data.previous.year}</span>
            <span><b className={`num ${vsPrev == null ? '' : vsPrev >= 0 ? 'pos' : 'neg'}`}>{pctText(vsPrev, { sign: true })}</b></span>
          </div>
        </div>
      </div>
      <div className="ev-panel">
        <div className="ev-l" style={{ marginBottom: 4 }}>Últimas ventas · en vivo</div>
        <SalesFeed items={filterFeed(data.live?.feed || [], view)} now={now} />
      </div>
    </div>
  );
}

export default function EventLive({ onLogout }) {
  const [eventId, setEventId] = useState('cyber');
  const [view, setView] = useState('total');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [toasts, setToasts] = useState([]);
  const prevViews = useRef(new Map());
  const toastSeq = useRef(0);
  const hasData = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setStale(false);
    hasData.current = false;
    const load = () => getEventReport(eventId)
      .then((d) => {
        if (cancelled) return;
        hasData.current = true;
        setData(d);
        setStale(false);
        setNow(Date.now());
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.message === 'Unauthorized') { onLogout(); return; }
        // Keep showing the last good numbers if a refresh fails.
        if (hasData.current) setStale(true); else setError(err.message);
      });
    load();
    const poll = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(poll); };
  }, [eventId, onLogout]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  const v = useMemo(() => (data ? groupView(data, view) : null), [data, view]);
  const ticker = useMemo(() => (data ? buildTicker(data, view) : []), [data, view]);
  const phase = data ? phaseOf(data) : null;

  // Celebrations: milestones crossed since the last fetch (or already crossed
  // on entry), once per browser session each.
  useEffect(() => {
    if (!data || !v || data.event !== eventId) return;
    const key = `${eventId}:${view}`;
    const prev = prevViews.current.get(key) ?? null;
    prevViews.current.set(key, v);
    if (phase === 'pre') return;
    const seen = loadSeen(eventId);
    const fresh = [];
    for (const id of crossedMilestones(prev, v)) {
      const seenId = id.endsWith('_dia') ? `${view}:${id}:${v.today.date}` : `${view}:${id}`;
      if (seen.has(seenId)) continue;
      markSeen(eventId, seenId);
      fresh.push({ id: ++toastSeq.current, text: milestoneText(id, data.label, view) });
    }
    if (fresh.length) setToasts(q => [...q, ...fresh]);
  }, [data, v, view, eventId, phase]);

  const nextToast = useCallback(() => setToasts(q => q.slice(1)), []);

  const changeEvent = (id) => { if (id !== eventId) { setToasts([]); setEventId(id); } };

  return (
    <div className="event-live">
      {data && <Ticker items={ticker} />}
      {toasts[0] && <CelebrationToast key={toasts[0].id} message={toasts[0].text} onDone={nextToast} />}
      <div className="ev-wrap">
        <Topbar data={data} eventId={eventId} onEvent={changeEvent} view={view} onView={setView} now={now} stale={stale} />

        {error && <p className="ev-status err">Error: {error}</p>}
        {!data && !error && <p className="ev-status">Cargando…</p>}

        {data && v && (
          <>
            <div className="ev-hero">
              {phase === 'pre'
                ? <CountdownHero data={data} v={v} view={view} />
                : <LiveHero data={data} v={v} view={view} phase={phase} />}
              <Side data={data} v={v} view={view} now={now} phase={phase} />
            </div>

            <h2 className="ev-sec">
              Categorías
              <small>
                unidades {data.label} {data.previous.year} (gris) vs {data.current.year} (naranja)
                {phase === 'pre' ? ` · ${data.previous.year} completo` : ' · mismos días'} · stock hoy · sin objetivo · web + locales
              </small>
            </h2>
            <div className="ev-grid2">
              <div className="ev-panel">
                <CategoryRace
                  categories={data.live?.categories}
                  started={phase !== 'pre'}
                  label={data.label}
                  prevYear={data.previous.year}
                  year={data.current.year}
                />
                <div className="ev-note">
                  Al pasar el mouse (o tocar) se ve la facturación ajustada de {data.previous.year} contra la
                  de {data.current.year}, y los 5 productos que más se vendieron de la categoría. El stock suma todos los
                  depósitos (locales, web, depósito y mayorista). "No alcanza" = lo vendido más el stock no llega a las
                  unidades de todo el {data.label} {data.previous.year}.
                </div>
              </div>
              <div className="ev-panel">
                <div className="ev-l" style={{ marginBottom: 10 }}>Pauta acumulada vs plan</div>
                <AdsPacing days={data.days} prevYear={data.previous.year} />
                <div className="ev-note">
                  La marca en la barra es el plan a hoy. Google se mide con GA4 (google / cpc), como en el resto del
                  reporte, e incluye la búsqueda de marca.
                </div>
              </div>
            </div>

            <h2 className="ev-sec">
              Día por día
              <small>{data.current.year} contra el mismo día de {data.previous.year} (alineado al día oficial) · pauta y venta</small>
            </h2>
            <DayByDayTable
              days={data.days}
              group={view}
              today={data.today}
              todayStatus={data.live?.todayStatus?.[view] ?? null}
              totalStatus={v.status}
              elapsed={{ floor: v.floorElapsed, target: v.targetElapsed }}
              realGrowth={data.assumptions?.realGrowth}
            />

            <EventDetails data={data} view={view} />
          </>
        )}
      </div>
    </div>
  );
}
