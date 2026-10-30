import { formatCurrency } from '../../lib/format.js';
import { getChannelLabel } from '../../lib/channels.js';
import { minutesAgo } from '../../lib/eventLive.js';

function where(item) {
  if (item.channel === 'ecommerce') return item.province ? `Web · ${item.province}` : 'Web';
  return getChannelLabel(item.channel);
}

function ago(item, now) {
  const m = minutesAgo(item.date, now);
  if (m == null) return '';
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
}

// Latest real orders. New ones mount (keyed by time + amount) and slide in.
export default function SalesFeed({ items, now }) {
  if (!items?.length) return <div className="ev-empty">Todavía no hay ventas en esta vista.</div>;
  // Key = time + amount + channel + how many identical ones came before it:
  // unique even for twin orders, and stable when a new sale is prepended
  // (a plain list index would remount and re-animate every row each poll).
  const seen = new Map();
  return (
    <div className="ev-feed">
      {items.map((it) => {
        const base = `${it.date}-${it.total}-${it.channel}`;
        const nth = seen.get(base) || 0;
        seen.set(base, nth + 1);
        const name = it.itemCount > 1 && it.label ? `${it.label} y ${it.itemCount - 1} más` : (it.label || `${it.itemCount} productos`);
        return (
          <div className="ev-sale" key={`${base}-${nth}`}>
            <div title={name}>{name}<small>{where(it)} · {ago(it, now)}</small></div>
            <div className="amt num">{formatCurrency(it.total)}</div>
          </div>
        );
      })}
    </div>
  );
}
