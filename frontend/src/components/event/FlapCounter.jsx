import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './shared.js';

const fmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const DURATION_MS = 1400;

// Airport-board counter. It only ever shows real fetched values: when `value`
// changes it rolls from the previous value to the new one (the first load
// rolls up from 0 once). Cells are keyed by position, so they never remount
// mid-roll; a cell flips (one CSS animation for the length of the roll) only
// when its settled digit differs from the previous settled value.
export default function FlapCounter({ value }) {
  const target = Math.max(0, Math.round(value || 0));
  const [shown, setShown] = useState(0);
  const [flips, setFlips] = useState({ gen: 0, positions: new Set() });
  const shownRef = useRef(0);

  useEffect(() => {
    const from = shownRef.current;
    // What's on screen now (the previous settled value unless a roll was
    // interrupted) against where we're going.
    const prevStr = fmt.format(from);
    const nextStr = fmt.format(target);
    if (from === target) return undefined;
    const reduce = prefersReducedMotion();
    if (!reduce) {
      // Positions counted from the right; compare the settled strings.
      const changed = new Set();
      for (let pos = 1; pos <= nextStr.length; pos += 1) {
        const ch = nextStr[nextStr.length - pos];
        if (ch !== '.' && ch !== prevStr[prevStr.length - pos]) changed.add(pos);
      }
      setFlips(f => ({ gen: f.gen + 1, positions: changed }));
    }
    if (reduce) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }
    let raf;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / DURATION_MS);
      const eased = 1 - (1 - p) ** 3;
      const v = p >= 1 ? target : Math.round(from + (target - from) * eased);
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const chars = [...fmt.format(shown)];
  const digits = chars.filter(c => c !== '.').length;
  const seps = chars.length - digits;
  // Width budget in "digit units" (digit + gap, separators narrower) so the
  // CSS can size the cells to fit the panel, e.g. $1.156.457.237 at 390 px.
  const units = digits * 1.1 + (seps + 1) * 0.45;
  return (
    <div className="ev-flapbox">
      <div className="ev-flap num" role="img" aria-label={`$ ${fmt.format(target)}`} style={{ '--units': units }}>
        <div className="s">$</div>
        {chars.map((ch, i) => {
          const pos = chars.length - i;
          if (ch === '.') return <div className="s" key={`p${pos}`}>.</div>;
          const flip = flips.positions.has(pos);
          // The generation in the key replays the flip once per real change.
          return <div className={`d${flip ? ' rolling' : ''}`} key={flip ? `p${pos}-g${flips.gen}` : `p${pos}`}>{ch}</div>;
        })}
      </div>
    </div>
  );
}
