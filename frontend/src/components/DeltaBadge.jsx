import { formatPercent } from '../lib/format.js';

export default function DeltaBadge({ pct }) {
  if (pct === null || pct === undefined) {
    return <span className="delta-badge delta-neutral">—</span>;
  }
  const className = pct >= 0 ? 'delta-positive' : 'delta-negative';
  return <span className={`delta-badge ${className}`}>{formatPercent(pct)}</span>;
}
