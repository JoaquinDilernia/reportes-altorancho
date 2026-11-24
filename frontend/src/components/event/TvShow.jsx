import { useCallback, useEffect, useRef, useState } from 'react';
import { getEventPulse } from '../../api/client.js';
import { formatCurrency, formatNumber } from '../../lib/format.js';
import { getChannelLabel } from '../../lib/channels.js';
import { compactMoney } from '../../lib/eventLive.js';
import { tierOf, tierInfo, newSales, feedIds, liveTotals } from '../../lib/tvShow.js';
import { unlockSounds, soundsReady, playSale } from '../../lib/saleSounds.js';
import FlapCounter from './FlapCounter.jsx';
import GoalTrack from './GoalTrack.jsx';
import SalesFeed from './SalesFeed.jsx';
import { useFireworks } from './GoalCelebration.jsx';
import { prefersReducedMotion } from './shared.js';

const PULSE_MS = 20 * 1000;
const RAIN = { 1: '🪙', 2: '⭐', 3: '💎', 4: '🏆' };

function where(sale) {
  if (sale.channel === 'ecommerce') return sale.province ? `Web · ${sale.province}` : 'Web';
  return getChannelLabel(sale.channel);
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15 * 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// Keeps the TV from dimming/sleeping while the screen is up (where supported).
function useWakeLock() {
  useEffect(() => {
    let lock = null;
    const take = () => globalThis.navigator?.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => {});
    take();
    const onVisible = () => { if (document.visibilityState === 'visible') take(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); lock?.release?.().catch(() => {}); };
  }, []);
}

// Controls fade out after a few seconds without moving the mouse (TV look).
function useIdle(ms = 4000) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), ms); };
    wake();
    globalThis.addEventListener('mousemove', wake);
    globalThis.addEventListener('keydown', wake);
    return () => { clearTimeout(t); globalThis.removeEventListener('mousemove', wake); globalThis.removeEventListener('keydown', wake); };
  }, [ms]);
  return idle;
}

function Fireworks() {
  const ref = useRef(null);
  useFireworks(ref, prefersReducedMotion());
  return <canvas ref={ref} className="ev-fj-canvas" aria-hidden="true" />;
}

function SaleCelebration({ sale, tier, test }) {
  const info = tierInfo(tier);
  const drops = Array.from({ length: 10 + tier * 8 }, (_, i) => i);
  return (
    <div className={`ev-tv-cele t${tier}`} role="status" aria-live="assertive">
      <div className="ev-fj-rays" aria-hidden="true" />
      {tier >= 3 && <div className="ev-fj-flash" aria-hidden="true" />}
      {tier === 4 && <Fireworks />}
      <div className="ev-tv-rain" aria-hidden="true">
        {drops.map(i => (
          <span key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 7) * 0.18}s`, animationDuration: `${1.6 + (i % 5) * 0.3}s` }}>{RAIN[tier]}</span>
        ))}
      </div>
      <div className="ev-tv-cele-body">
        <div className="kicker">{where(sale)}{test ? ' · prueba' : ''}</div>
        <div className="title">{info.title}</div>
        <div className="amount num">{formatCurrency(sale.total)}</div>
        {sale.label && <div className="what">{sale.itemCount > 1 ? `${sale.label} y ${sale.itemCount - 1} más` : sale.label}</div>}
      </div>
    </div>
  );
}

const TEST_AMOUNTS = { 0: 180_000, 1: 650_000, 2: 1_200_000, 3: 1_700_000, 4: 2_600_000 };

export default function TvShow({ data, v, eventId, statusText, isLive, onExit, onLogout }) {
  const [pulse, setPulse] = useState(null);
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [soundOn, setSoundOn] = useState(soundsReady());
  const [muted, setMuted] = useState(false);
  const seen = useRef(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const clock = useClock();
  const idle = useIdle();
  useWakeLock();

  // Poll today's sales; queue the ones that weren't there before.
  useEffect(() => {
    let cancelled = false;
    const load = () => getEventPulse(eventId)
      .then((p) => {
        if (cancelled) return;
        const fresh = newSales(seen.current, p.feed);
        seen.current = feedIds(p.feed, seen.current ?? new Set());
        setPulse(p);
        if (!fresh.length) return;
        const small = fresh.filter(s => tierOf(s.total) === 0);
        small.forEach((s, i) => setTimeout(() => { if (!mutedRef.current) playSale(0); }, i * 350));
        const big = fresh.filter(s => tierOf(s.total) > 0).map(s => ({ sale: s, tier: tierOf(s.total) }));
        if (big.length) setQueue(q => [...q, ...big]);
      })
      .catch((err) => { if (!cancelled && err.message === 'Unauthorized') onLogout?.(); });
    load();
    const id = setInterval(load, PULSE_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [eventId, onLogout]);

  // One celebration at a time, each as long as its tier asks for.
  useEffect(() => {
    if (current || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    // With a backlog, shorter shows so they don't pile up for minutes.
    setCurrent({ ...next, ms: tierInfo(next.tier).ms * (rest.length > 2 ? 0.6 : 1) });
  }, [queue, current]);

  useEffect(() => {
    if (!current) return undefined;
    if (!mutedRef.current) playSale(current.tier);
    const t = setTimeout(() => setCurrent(null), current.ms);
    return () => clearTimeout(t);
  }, [current]);

  const enableSound = useCallback(() => { unlockSounds().then(setSoundOn); }, []);
  const test = (tier) => {
    if (!soundOn) enableSound();
    const sale = { id: `test-${Date.now()}`, channel: tier % 2 ? 'ecommerce' : 'local_lomas', province: 'Córdoba', total: TEST_AMOUNTS[tier], label: 'Mesa de luz de MDF y hierro', itemCount: 1, date: new Date().toISOString() };
    if (tier === 0) { playSale(0); return; }
    setQueue(q => [...q, { sale, tier, test: true }]);
  };

  const fullscreen = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) onExit(); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onExit]);

  const live = liveTotals(v, pulse, 'total');
  const todayPct = v?.today?.target ? (live.todayRevenue / v.today.target) * 100 : null;
  const time = clock.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Argentina/Buenos_Aires' });

  return (
    <div className={`ev-tv${idle ? ' idle' : ''}`}>
      <div className="ev-tv-top">
        <div className="ev-brand">Alto<em>{data.label}</em> {String(data.current.year).slice(2)}</div>
        <span className={`ev-live${isLive ? '' : ' off'}`}><span className="ev-dot" />{statusText}</span>
        <div className="ev-tv-clock num">{time}</div>
      </div>

      <div className="ev-tv-main">
        <div className="ev-tv-hero">
          <div className="ev-l">Facturado {data.label} {data.current.year} · web + locales</div>
          <FlapCounter value={live.revenue} />
          <GoalTrack value={live.revenue} floor={v?.floor} target={v?.target} />
          <div className="ev-tv-stats">
            <div><span className="ev-l">Hoy</span><b className="num">{compactMoney(live.todayRevenue)}</b></div>
            <div><span className="ev-l">Ventas hoy</span><b className="num">{formatNumber(live.todayOrders)}</b></div>
            <div><span className="ev-l">Ventas del {data.label}</span><b className="num">{formatNumber(live.orders)}</b></div>
            <div><span className="ev-l">Objetivo de hoy</span><b className="num">{todayPct == null ? '—' : `${Math.round(todayPct)}%`}</b></div>
          </div>
        </div>
        <div className="ev-tv-feed">
          <div className="ev-l">Últimas ventas</div>
          <SalesFeed items={pulse?.feed ?? data.live?.feed ?? []} now={clock.getTime()} />
        </div>
      </div>

      {!soundOn && (
        <button type="button" className="ev-tv-unlock" onClick={enableSound}>🔊 Tocá acá para activar el sonido</button>
      )}

      <div className="ev-tv-ctrl">
        <button type="button" onClick={() => setMuted(m => !m)}>{muted ? '🔇 Sin sonido' : '🔊 Con sonido'}</button>
        <span className="ev-tv-tests">
          Probar:
          {[0, 1, 2, 3, 4].map(t => (
            <button type="button" key={t} onClick={() => test(t)}>{t === 0 ? '<500k' : t === 1 ? '500k' : t === 2 ? '1M' : t === 3 ? '1,5M' : '+2M'}</button>
          ))}
        </span>
        <button type="button" onClick={fullscreen}>⛶ Pantalla completa</button>
        <button type="button" onClick={onExit}>✕ Salir</button>
      </div>

      {current && <SaleCelebration key={current.sale.id} sale={current.sale} tier={current.tier} test={current.test} />}
    </div>
  );
}
