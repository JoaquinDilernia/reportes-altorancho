import { formatPercent } from '../lib/format.js';

export default function DeltaBadge({ pct, invert = false }) {
  if (pct === null || pct === undefined) {
    return <span className="delta-badge delta-neutral">—</span>;
  }
  const isGood = invert ? pct <= 0 : pct >= 0;
  const className = isGood ? 'delta-positive' : 'delta-negative';
  return <span className={`delta-badge ${className}`}>{formatPercent(pct)}</span>;
}
