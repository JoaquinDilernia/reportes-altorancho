// Lime news ticker. Items are built from real data (buildTicker).
export default function Ticker({ items }) {
  if (!items?.length) return null;
  const chars = items.join('').length;
  const seconds = Math.max(24, Math.round(chars * 0.22));
  return (
    <div className="ev-ticker" role="marquee" aria-label="Novedades del evento">
      <div style={{ animationDuration: `${seconds}s` }}>
        {items.map((t, i) => <span key={i}>{t}</span>)}
      </div>
    </div>
  );
}
