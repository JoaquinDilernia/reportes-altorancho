import { num, pct } from '../format.js';
import { mmss } from './webFormat.js';

const CLARITY_URL = 'https://clarity.microsoft.com/projects/view/gqkzzchnqe/dashboard';
// Same thresholds as the Resumen alert (backend/alertConfig.mjs:
// clarityRagePct 5, clarityDeadPct 20).
const RAGE_RED = 5;
const DEAD_RED = 20;

const sig = (s, d = 1) => (s ? pct(s.pct, { decimals: d }) : '—');

function Figures({ totals }) {
  const s = totals.signals;
  const items = [
    ['Clics de bronca', sig(s.rage, 2), 'Sesiones con clics repetidos y rápidos en el mismo lugar'],
    ['Clics muertos', sig(s.dead), 'Sesiones con clics en algo que no hace nada'],
    ['Vuelven enseguida', sig(s.quickback), 'Sesiones que entran a una página y vuelven atrás al toque (quickback)'],
    ['Scroll promedio', totals.scrollDepth == null ? '—' : pct(totals.scrollDepth), 'Hasta dónde bajan en la página, en promedio'],
    ['Tiempo activo', mmss(totals.activeTimeSec), 'Tiempo activo promedio por sesión'],
  ];
  return (
    <div className="nv-cfig">
      {items.map(([label, value, title]) => (
        <div key={label} title={title}>
          <div className="nv-lbl">{label}</div>
          <div className="nv-big nv-mid">{value}</div>
        </div>
      ))}
    </div>
  );
}

export default function ClarityCard({ clarity }) {
  const has = clarity.days > 0;
  return (
    <section className="nv-card nv-sec">
      <div className="nv-titlebar">
        <div className="nv-h">
          <h2>Experiencia (Clarity)</h2>
          <span>{has ? `${clarity.days} de ${clarity.totalDays} días con datos${clarity.running ? ' (hasta ayer)' : ''} · ${num(clarity.totals.sessions)} sesiones` : 'cómo usan el sitio'}</span>
        </div>
        <a className="nv-link nv-ext" href={CLARITY_URL} target="_blank" rel="noopener noreferrer">Ver mapas de calor en Clarity ↗</a>
      </div>
      {!has && <p className="nv-empty">Sin datos de Clarity para este período (se guardan desde el 13/11/2026, una foto por día).</p>}
      {has && (
        <>
          <Figures totals={clarity.totals} />
          {clarity.pages.length > 0 && (
            <div className="nv-tscroll">
              <table className="nv-table nv-compact">
                <thead><tr><th>Página</th><th className="r">Sesiones</th><th className="r">Bronca</th><th className="r">Muertos</th><th className="r">Vuelven</th><th className="r">Scroll</th></tr></thead>
                <tbody>
                  {clarity.pages.map(p => (
                    <tr key={p.path}>
                      <td><span className="nv-ellip nv-block" title={p.path}>{p.path === '/' ? 'Inicio (/)' : p.path}</span></td>
                      <td className="r">{num(p.sessions)}</td>
                      <td className={`r${p.rage >= RAGE_RED ? ' nv-red' : ''}`}>{pct(p.rage, { decimals: 1 })}</td>
                      <td className={`r${p.dead >= DEAD_RED ? ' nv-red' : ''}`}>{pct(p.dead, { decimals: 1 })}</td>
                      <td className="r">{pct(p.quickback, { decimals: 0 })}</td>
                      <td className="r">{p.scrollDepth == null ? '—' : pct(p.scrollDepth)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <div className="nv-note">Clarity cuenta sesiones distinto que GA4: no se comparan entre sí. Las grabaciones y los mapas de calor están en Clarity.</div>
    </section>
  );
}
