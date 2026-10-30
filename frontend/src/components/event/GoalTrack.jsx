import { useEffect, useState } from 'react';
import { compactMoney } from '../../lib/eventLive.js';

// Progress track with a runner and flags at the event floor and target.
// The scale goes to target × 1.1 so the target flag isn't glued to the edge.
export default function GoalTrack({ value, floor, target }) {
  const max = target > 0 ? target * 1.1 : Math.max(value || 0, floor || 0, 1);
  const pos = (v) => `${Math.min(100, Math.max(0, ((v || 0) / max) * 100))}%`;
  // Start at 0 and move on the next frame so the runner visibly runs.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const at = ready ? pos(value) : '0%';
  return (
    <div className="ev-track" aria-hidden="true">
      <div className="line" />
      <div className="done" style={{ width: at }} />
      {floor > 0 && (
        <div className="flag piso" style={{ left: pos(floor) }}><b>Piso {compactMoney(floor)} (2025 + inflación)</b></div>
      )}
      {target > 0 && (
        <div className="flag obj" style={{ left: pos(target) }}><b>Objetivo {compactMoney(target)}</b></div>
      )}
      <div className="runner" style={{ left: at }}><span>🏃</span></div>
    </div>
  );
}
