import { compactMoney } from '../../lib/eventLive.js';
import { dayLabel, ratio, roasText, statusClass, statusLabel, sumAds } from './shared.js';

const GROUPS = { total: ['web', 'locales'], web: ['web'], locales: ['locales'] };

function statusOf(revenue, floor, target) {
  if (revenue >= target) return 'sobre';
  if (revenue >= floor) return 'entre';
  return 'bajo_piso';
}

function Chip({ status, text }) {
  return <span className={`ev-chip ${statusClass(status)}`}>{text ?? statusLabel(status)}</span>;
}

function sales(day, groups) {
  const sum = (k) => groups.reduce((s, g) => s + (day[g]?.[k] || 0), 0);
  return { floor: sum('floor'), target: sum('target'), revenue: day.played ? sum('revenue') : null };
}

// One row per event day: Meta and Google spend/ROAS (always web-level; 2025
// spend inflation-adjusted), then sales for the selected view.
// `elapsed` = floor/target of the time played so far (today pro-rated by the
// hourly curve), so "Total a hoy" compares like with like mid-day.
export default function DayByDayTable({ days, group, today, todayStatus, totalStatus, elapsed, realGrowth }) {
  const groups = GROUPS[group] || GROUPS.total;
  const played = days.filter(d => d.played);
  const adsPrevAdj = sumAds(played, d => d.ads?.prevAdj);
  const adsPrev = sumAds(played, d => d.ads?.prev);
  const adsActual = sumAds(played, d => d.ads?.actual);
  const tot = played.reduce((t, d) => {
    const s = sales(d, groups);
    return { floor: t.floor + s.floor, target: t.target + s.target, revenue: t.revenue + (s.revenue || 0) };
  }, { floor: 0, target: 0, revenue: 0 });
  const firstExtension = days.find(d => d.phase === 'extension')?.date;

  // GA4 takes 24-48 h to settle: Google ROAS of today and yesterday is partial.
  const yesterday = today ? new Date(Date.parse(`${today}T00:00:00Z`) - 864e5).toISOString().slice(0, 10) : null;

  const adCells = (prevAdj, prev, actual, plan, future, partial = false) => ['meta', 'google'].map((p, i) => [
    <td key={`${p}a`} className={i ? 'sepL' : undefined}>{compactMoney(prevAdj?.[p]?.spend)}</td>,
    future
      ? <td key={`${p}b`} className="pend">{plan?.[p] != null ? `plan ${compactMoney(plan[p])}` : '—'}</td>
      : <td key={`${p}b`}>{actual ? compactMoney(actual[p]?.spend) : '—'}</td>,
    <td key={`${p}c`}>{roasText(ratio(prev?.[p]?.value, prev?.[p]?.spend))}</td>,
    future
      ? <td key={`${p}d`} className="pend">—</td>
      : p === 'google' && partial && actual
        ? <td key={`${p}d`} style={{ opacity: 0.55 }} title="GA4 todavía está cargando la facturación">{roasText(ratio(actual[p]?.value, actual[p]?.spend))}*</td>
        : <td key={`${p}d`}>{actual ? roasText(ratio(actual[p]?.value, actual[p]?.spend)) : '—'}</td>,
  ]);

  return (
    <div className="ev-panel ev-tscroll">
      <table className="ev-table num">
        <thead>
          <tr>
            <th />
            <th colSpan={4} className="grp" style={{ borderColor: 'var(--meta)', color: 'var(--meta)' }}>Meta</th>
            <th colSpan={4} className="grp" style={{ borderColor: 'var(--google)', color: 'var(--google)' }}>Google</th>
            <th colSpan={4} className="grp" style={{ borderColor: 'var(--lime)', color: 'var(--lime)' }}>Facturación</th>
          </tr>
          <tr>
            <th>Día</th>
            <th>Inv. 25</th><th>Inv. 26</th><th>ROAS 25</th><th>ROAS 26</th>
            <th className="sepL">Inv. 25</th><th>Inv. 26</th><th>ROAS 25</th><th>ROAS 26</th>
            <th className="sepL">2025 ajust.</th><th>Objetivo</th><th>Real 2026</th><th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {played.length > 0 && (
            <tr className="tot">
              <td>Total a hoy</td>
              {adCells(adsPrevAdj, adsPrev, adsActual, null, false)}
              <td className="sepL">{compactMoney(elapsed?.floor ?? tot.floor)}</td>
              <td>{compactMoney(elapsed?.target ?? tot.target)}</td>
              <td>{compactMoney(tot.revenue)}</td>
              <td className="st">{totalStatus ? <Chip status={totalStatus} /> : <Chip status={null} />}</td>
            </tr>
          )}
          {days.map((d) => {
            const isToday = d.date === today;
            const future = !d.played;
            const s = sales(d, groups);
            const tags = [
              d.isLaunch && 'lanz.',
              d.phase === 'oficial' && 'oficial',
              d.date === firstExtension && 'extensión',
              isToday && 'HOY',
            ].filter(Boolean);
            const cls = [d.phase === 'oficial' && 'off', isToday && 'today', future && !isToday && 'fut'].filter(Boolean).join(' ');
            let state = null;
            if (isToday && d.played) {
              const ts = todayStatus;
              state = <Chip status={ts?.status ?? null} text={ts?.pct != null ? `en curso · ${Math.round(ts.pct)}%` : 'en curso'} />;
            } else if (d.played && s.target > 0) {
              state = <Chip status={statusOf(s.revenue, s.floor, s.target)} />;
            }
            return (
              <tr key={d.date} className={cls || undefined}>
                <td>{dayLabel(d.date)}{tags.length ? ` · ${tags.join(' · ')}` : ''}</td>
                {adCells(d.ads?.prevAdj, d.ads?.prev, d.ads?.actual, d.ads?.plan, future, d.date === today || d.date === yesterday)}
                <td className="sepL">{compactMoney(s.floor)}</td>
                <td>{compactMoney(s.target)}</td>
                <td className={future ? 'pend' : undefined}>
                  {future ? '—' : isToday ? <><b>{compactMoney(s.revenue)}</b> ⏳</> : compactMoney(s.revenue)}
                </td>
                <td className="st">{state}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="ev-note">
        "2025 ajust." es el piso: lo que facturamos el mismo día de 2025 ajustado por inflación. El objetivo le suma el
        crecimiento real (web +{Math.round((realGrowth?.web ?? 0) * 100)}%, locales +{Math.round((realGrowth?.locales ?? 0) * 100)}%).
        La inversión 2025 también está ajustada por inflación, con el mismo factor del día (el ROAS no cambia). Google se
        mide con GA4 (google / cpc) e incluye la búsqueda de marca. La pauta es siempre de la web.
        <br />
        * Google: GA4 tarda 24–48 h en cargar la facturación; el ROAS de hoy y ayer todavía es parcial.
      </div>
    </div>
  );
}
