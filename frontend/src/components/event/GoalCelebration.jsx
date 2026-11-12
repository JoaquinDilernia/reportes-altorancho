import { useCallback, useEffect, useRef, useState } from 'react';
import { compactMoney } from '../../lib/eventLive.js';
import { playFestejo } from '../../lib/festejoSound.js';

const COLORS = ['#C6F432', '#ff7a45', '#ffc83c', '#2ee6a0', '#7cc4ff', '#ff5ac8', '#ffffff'];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Confetti cannons, confetti rain and fireworks on one canvas.
function useFireworks(canvasRef, reduced) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const g = canvas.getContext('2d');
    if (!g) return undefined;
    let w = 0; let h = 0;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const resize = () => {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    globalThis.addEventListener('resize', resize);

    const parts = [];
    const scale = reduced ? 0.25 : 1;
    const confetti = (x, y, n, angle, spread, speed) => {
      for (let i = 0; i < n * scale; i++) {
        const a = angle + rnd(-spread, spread);
        const s = rnd(speed * 0.5, speed);
        parts.push({ k: 'c', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: rnd(0, 6.28), vr: rnd(-0.3, 0.3), w: rnd(6, 12), h: rnd(3, 7), c: pick(COLORS), life: rnd(220, 340) });
      }
    };
    const firework = () => {
      const x = rnd(w * 0.12, w * 0.88); const y = rnd(h * 0.1, h * 0.45);
      const c = pick(COLORS); const n = Math.round(rnd(60, 110) * scale);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2; const s = rnd(2, 7);
        parts.push({ k: 'f', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, c, life: rnd(50, 80), max: 80 });
      }
    };

    // Opening: two cannons from the bottom corners.
    confetti(0, h, 160, -Math.PI / 3, 0.35, 22);
    confetti(w, h, 160, -2 * Math.PI / 3, 0.35, 22);
    const timers = [
      setTimeout(() => { confetti(0, h, 120, -Math.PI / 3, 0.4, 20); confetti(w, h, 120, -2 * Math.PI / 3, 0.4, 20); }, 2600),
      setInterval(firework, reduced ? 1600 : 520),
      setInterval(() => confetti(rnd(0, w), -20, 14, Math.PI / 2, 0.6, 4), 120),
    ];

    let raf;
    const tick = () => {
      g.clearRect(0, 0, w, h);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life -= 1;
        if (p.life <= 0 || p.y > h + 40) { parts.splice(i, 1); continue; }
        if (p.k === 'c') {
          p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.32; p.x += p.vx + Math.sin(p.life / 9); p.y += p.vy; p.r += p.vr;
          g.save(); g.translate(p.x, p.y); g.rotate(p.r);
          g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
          g.restore();
        } else {
          p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.06; p.x += p.vx; p.y += p.vy;
          g.globalAlpha = Math.max(0, p.life / p.max);
          g.fillStyle = p.c; g.beginPath(); g.arc(p.x, p.y, 2.6, 0, 6.28); g.fill();
          g.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timers[0]); clearInterval(timers[1]); clearInterval(timers[2]);
      globalThis.removeEventListener('resize', resize);
    };
  }, [canvasRef, reduced]);
}

export default function GoalCelebration({ label, year, revenue, target, overPct, test, onClose }) {
  const canvasRef = useRef(null);
  const closeRef = useRef(null);
  const [needsTap, setNeedsTap] = useState(false);
  const reduced = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useFireworks(canvasRef, reduced);

  const sound = useCallback(() => {
    playFestejo().then(ok => setNeedsTap(!ok)).catch(() => setNeedsTap(true));
  }, []);

  useEffect(() => {
    sound();
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [sound, onClose]);

  return (
    <div className={`ev-festejo${reduced ? ' calm' : ''}`} role="dialog" aria-modal="true" aria-label={`Objetivo ${label} cumplido`}>
      <div className="ev-fj-rays" aria-hidden="true" />
      <div className="ev-fj-flash" aria-hidden="true" />
      <canvas ref={canvasRef} className="ev-fj-canvas" aria-hidden="true" />
      <div className="ev-fj-body">
        <div className="ev-fj-trophy" aria-hidden="true">🏆</div>
        <div className="ev-fj-kicker">Alto{label} {year}{test ? ' · prueba' : ''}</div>
        <h1 className="ev-fj-title">¡OBJETIVO<br />CUMPLIDO!</h1>
        <div className="ev-fj-amount num">{compactMoney(revenue)}</div>
        <div className="ev-fj-sub">
          objetivo {compactMoney(target)}
          {overPct != null && overPct >= 0 && <b> · {overPct >= 0.5 ? `+${Math.round(overPct)}% por encima` : '¡justo!'}</b>}
        </div>
        <div className="ev-fj-actions">
          {needsTap
            ? <button type="button" className="ev-fj-btn hot" onClick={sound}>🔊 Activar el sonido</button>
            : <button type="button" className="ev-fj-btn" onClick={sound}>🔊 Otra vez</button>}
          <button type="button" className="ev-fj-btn ghost" ref={closeRef} onClick={onClose}>Seguir mirando el {label}</button>
        </div>
        <div className="ev-fj-thanks">¡Gracias a todo el equipo! 🙌</div>
      </div>
    </div>
  );
}
