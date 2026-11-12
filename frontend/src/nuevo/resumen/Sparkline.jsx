// Fluid-width trend line; the last point (the period being viewed) is marked.
export default function Sparkline({ values, height = 28, label }) {
  const pts = (values || []).map((v, i) => ({ v, i })).filter(p => typeof p.v === 'number' && Number.isFinite(p.v));
  if (pts.length < 2) return <div className="nv-spark nv-spark-empty" style={{ height }} />;
  const n = values.length - 1 || 1;
  const vals = pts.map(p => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => (i / n) * 100;
  const y = (v) => 3 + (1 - (v - min) / span) * (height - 6);
  const line = pts.map(p => `${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg className="nv-spark" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}>
      <polyline points={line} fill="none" stroke="#c9c8c7" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {last.i === n && (
        <circle cx={x(last.i)} cy={y(last.v)} r="2.6" fill="#353434" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
