import { compactMoney } from '../../lib/eventLive.js';
import { ratio, roasText, sumAds } from './shared.js';

const PLATFORMS = [
  { id: 'meta', label: 'Meta', color: 'var(--meta)' },
  { id: 'google', label: 'Google', color: 'var(--google)' },
];

// Spend so far (played days) against the whole plan, with a tick where the
// plan should be by today, and ROAS against the same days of last year.
export default function AdsPacing({ days, prevYear }) {
  const played = days.filter(d => d.played);
  const actual = sumAds(played, d => d.ads?.actual);
  const prev = sumAds(played, d => d.ads?.prev);
  const planTotal = { meta: 0, google: 0 };
  const planToDate = { meta: 0, google: 0 };
  for (const d of days) {
    for (const p of ['meta', 'google']) {
      planTotal[p] += d.ads?.plan?.[p] || 0;
      if (d.played) planToDate[p] += d.ads?.plan?.[p] || 0;
    }
  }
  return (
    <div className="ev-ads">
      {PLATFORMS.map(({ id, label, color }) => {
        const spent = actual[id].spend;
        const plan = planTotal[id];
        const pct = (v) => `${plan ? Math.min(100, (v / plan) * 100) : 0}%`;
        return (
          <div className="ev-ad" key={id}>
            <div className="ev-l" style={{ color }}>{label}</div>
            <div className="v num">{compactMoney(spent)}</div>
            <div className="ev-barsm">
              <i style={{ width: pct(spent), background: color }} />
              {plan > 0 && <u style={{ left: pct(planToDate[id]) }} title="plan a hoy" />}
            </div>
            <div className="ev-sub">
              de {compactMoney(plan)} plan (a hoy {compactMoney(planToDate[id])}) · ROAS{' '}
              <b style={{ color: 'var(--ink)' }}>{roasText(ratio(actual[id].value, spent))}</b>{' '}
              ({prevYear}: {roasText(ratio(prev[id].value, prev[id].spend))})
            </div>
          </div>
        );
      })}
    </div>
  );
}
