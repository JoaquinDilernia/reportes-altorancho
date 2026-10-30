import { useEffect, useState } from 'react';
import { formatCurrency, formatNumber } from '../../lib/format.js';
import { compactMoney } from '../../lib/eventLive.js';

// Units of last year's aligned days (gray) vs this year (orange), stock now
// and a warning when units sold + stock can't match last year's full event.
// Before the event starts there's nothing aligned yet, so the gray bar is
// last year's whole event. No targets here on purpose.
export default function CategoryRace({ categories, started, label, prevYear, year }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const rows = (categories || []).filter(c => c.prevUnits > 0 || c.units > 0);
  if (!rows.length) return <div className="ev-empty">Sin datos de categorías.</div>;
  const base = (c) => (started ? c.prevUnitsToDate : c.prevUnits);
  const max = Math.max(1, ...rows.map(c => Math.max(base(c), c.units)));
  const w = (v) => `${(v / max) * 100}%`;
  return (
    <>
      {rows.map((c) => {
        const isOtros = c.id === 'otros';
        return (
          <div className="ev-cat" key={c.id} tabIndex={0}>
            <b>{c.label}</b>
            <div className="bars">
              <div className="p" style={{ width: w(base(c)) }} />
              <div className="c" style={{ width: ready ? w(c.units) : 0 }} />
            </div>
            <span className="r1 num">
              <b>{formatNumber(c.units)}</b> / {formatNumber(base(c))} u
              {!isOtros && <> · stock {formatNumber(c.stock)}</>}
              {!isOtros && c.cantMatch && <span className="ev-warn">no alcanza p/ igualar</span>}
            </span>
            <div className="ev-tip" role="tooltip">
              <div>
                Facturación {started ? 'a hoy' : `${label} ${prevYear} completo`}: {prevYear} ajust.{' '}
                <b>{compactMoney(started ? c.prevRevenueToDateAdj : c.prevRevenueAdj)}</b> · {year}{' '}
                <b>{compactMoney(c.revenue)}</b>
              </div>
              <div>{label} {prevYear} completo: {formatNumber(c.prevUnits)} u · {compactMoney(c.prevRevenueAdj)} ajust.</div>
              {c.topProducts?.length > 0 && (
                <ol>
                  {c.topProducts.slice(0, 5).map(p => (
                    <li key={p.sku}><span>{p.name}</span> · {formatNumber(p.units)} u · {formatCurrency(p.revenue)}</li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
