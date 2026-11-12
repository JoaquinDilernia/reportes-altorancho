import { num } from '../format.js';
import { rate } from './webFormat.js';

const PREV = { week: 'semana anterior', month: 'mes anterior', custom: 'período anterior' };

export default function FunnelCard({ funnel, period }) {
  const top = funnel.cur[0]?.users || 0;
  const prevTop = funnel.prev[0]?.users || 0;
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Embudo</h2><span>personas en cada paso · marca = {PREV[period]}</span></div>
      {funnel.cur.map((s, i) => {
        const share = top ? s.users / top : 0;
        const p = funnel.prev[i];
        const prevShare = prevTop && p ? p.users / prevTop : null;
        const step = i > 0 && funnel.cur[i - 1].users ? s.users / funnel.cur[i - 1].users : null;
        return (
          <div className="nv-frow" key={s.id}>
            <span className="nv-ellip">{s.label}</span>
            <div className="nv-track nv-ftrack">
              <i style={{ width: `${Math.max(share * 100, 0.6)}%`, background: 'var(--nv-ink)' }} />
              {prevShare != null && <em style={{ left: `${Math.min(prevShare * 100, 100)}%` }} title={`${PREV[period]}: ${rate(prevShare, 1)}`} />}
            </div>
            <span className="r">{num(s.users)}</span>
            <span className="r nv-mute">{i === 0 ? '' : `${rate(step, 1)} del paso anterior`}</span>
          </div>
        );
      })}
      <div className="nv-note">Los pasos del checkout no se muestran: GA4 cambió cómo los mide.</div>
    </section>
  );
}
