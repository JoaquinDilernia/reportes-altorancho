import { num, pct } from '../format.js';
import { rate } from './webFormat.js';

// Two or three groups side by side (device, new vs returning): share of
// sessions and how each converts.
export default function SplitCard({ title, rows, labels }) {
  const all = rows.filter(r => r.cur?.sessions && labels[r.key]);
  const total = all.reduce((s, r) => s + r.cur.sessions, 0);
  // Groups under 1% of sessions (one Smart TV visit) only add noise.
  const shown = all.filter(r => r.cur.sessions / total >= 0.01);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>{title}</h2></div>
      <div className="nv-split">
        {shown.map(r => (
          <div key={r.key} className="nv-split-item">
            <div className="nv-lbl">{labels[r.key]}</div>
            <div className="nv-big nv-mid">{total ? pct((r.cur.sessions / total) * 100) : '—'}</div>
            <div className="nv-mute">{num(r.cur.sessions)} sesiones · conv. {rate(r.cur.conversion)}</div>
          </div>
        ))}
      </div>
      {total > 0 && (
        <div className="nv-splitbar">
          {shown.map((r, i) => <i key={r.key} style={{ flexGrow: r.cur.sessions, opacity: 1 - i * 0.3 }} />)}
        </div>
      )}
    </section>
  );
}
