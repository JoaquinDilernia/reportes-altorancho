import { pctText } from './shared.js';

// "+12%" in green / "-8%" in red; "—" when there's nothing to compare.
export default function Delta({ pct, title }) {
  if (pct == null || !Number.isFinite(pct)) return <span className="ev-delta">—</span>;
  return <span className={`ev-delta ${pct >= 0 ? 'pos' : 'neg'}`} title={title}>{pctText(pct, { sign: true })}</span>;
}
