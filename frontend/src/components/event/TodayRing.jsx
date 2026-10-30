import { useEffect, useState } from 'react';

const R = 62;
const C = 2 * Math.PI * R;

// Ring for "% of today's target so far". The arc caps at a full turn; the
// number shows the real percentage (it can go past 100%).
export default function TodayRing({ pct }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const fill = pct == null ? 0 : Math.min(100, Math.max(0, pct)) / 100;
  const offset = ready ? C * (1 - fill) : C;
  return (
    <div className="ev-ring">
      <svg viewBox="0 0 150 150" width="150" height="150" aria-hidden="true">
        <defs>
          <linearGradient id="ev-ring-grad" x1="0" x2="1">
            <stop offset="0" stopColor="#2ee6a0" />
            <stop offset="1" stopColor="#7cc4ff" />
          </linearGradient>
        </defs>
        <circle cx="75" cy="75" r={R} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="12" />
        <circle
          className="arc" cx="75" cy="75" r={R} fill="none" stroke="url(#ev-ring-grad)" strokeWidth="12"
          strokeLinecap="round" transform="rotate(-90 75 75)" strokeDasharray={C} strokeDashoffset={offset}
        />
      </svg>
      <div className="c">
        <b className="num">{pct == null ? '—' : `${Math.round(pct)}%`}</b>
        <span>objetivo hoy<br />a esta hora</span>
      </div>
    </div>
  );
}
