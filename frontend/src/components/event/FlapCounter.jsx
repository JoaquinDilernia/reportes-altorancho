import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './shared.js';

const fmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const DURATION_MS = 1400;

// Airport-board counter. It only ever shows real fetched values: when `value`
// changes it rolls from the previous value to the new one (the first load
// rolls up from 0 once), and only the digit cells whose character changed flip.
export default function FlapCounter({ value }) {
  const target = Math.max(0, Math.round(value || 0));
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);

  useEffect(() => {
    const from = shownRef.current;
    if (from === target || prefersReducedMotion()) {
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
  return (
    <div className="ev-flap num" role="img" aria-label={`$ ${fmt.format(target)}`}>
      <div className="s">$</div>
      {chars.map((ch, i) => {
        // Keyed by position from the right + char: a changed digit remounts
        // and replays the flip; unchanged digits stay still.
        const pos = chars.length - i;
        return ch === '.'
          ? <div className="s" key={`s${pos}`}>.</div>
          : <div className="d flip" key={`d${pos}-${ch}`}>{ch}</div>;
      })}
    </div>
  );
}
