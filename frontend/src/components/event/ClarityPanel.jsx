import { useEffect, useState } from 'react';
import { getClarity } from '../../api/client.js';
import { formatNumber } from '../../lib/format.js';

// Microsoft Clarity, last 24 h: frustration signals (rage / dead clicks,
// quick backs), scroll depth and the pages where they happen. The backend
// caches for 2 h (the API allows ~10 calls a day), so polling is rare.
const REFRESH_MS = 30 * 60 * 1000;

const pct = (v, d = 1) => (v == null ? '—' : `${Number(v).toFixed(d).replace('.', ',')}%`);
const mmss = (sec) => (sec == null ? '—' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);

const SIGNALS = [
  { key: 'rage', label: 'Rage clicks', help: 'clics repetidos con bronca en el mismo lugar' },
  { key: 'dead', label: 'Clics muertos', help: 'clics en algo que no hace nada' },
  { key: 'quickback', label: 'Vuelven rápido', help: 'entran a una página y vuelven atrás enseguida' },
  { key: 'excessiveScroll', label: 'Scroll excesivo', help: 'scrollean de más buscando algo' },
  { key: 'errorClick', label: 'Clics con error', help: 'clics que disparan un error de JavaScript' },
];

export default function ClarityPanel({ onLogout }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => getClarity()
      .then(d => { if (!cancelled) { setC(d); setError(null); } })
      .catch(err => {
        if (cancelled) return;
        if (err.message === 'Unauthorized') { onLogout?.(); return; }
        setError(err.message);
      });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [onLogout]);

  const head = (
    <h2 className="ev-sec">
      Experiencia en el sitio
      <small>Microsoft Clarity · últimas 24 h · los mapas de calor y las grabaciones se ven en clarity.microsoft.com</small>
    </h2>
  );
  if (error && !c) return <>{head}<div className="ev-panel"><div className="ev-empty">No se pudo cargar Clarity: {error}</div></div></>;
  if (!c) return <>{head}<div className="ev-panel"><div className="ev-empty">Cargando Clarity…</div></div></>;
  if (!c.available) return <>{head}<div className="ev-panel"><div className="ev-empty">{c.reason}</div></div></>;
  if (!c.totals.sessions) {
    return (
      <>{head}
        <div className="ev-panel"><div className="ev-empty">
          Clarity todavía no registra sesiones: se reconectó hoy (se había desconectado con el cambio de plantilla) y tarda unas horas en procesar.
          Se vuelve a consultar solo.
        </div></div>
      </>
    );
  }
  const t = c.totals;
  return (
    <>
      {head}
      <div className="ev-bkpis">
        <div className="ev-panel ev-bkpi">
          <div className="ev-l">Sesiones grabadas</div>
          <div className="v num">{formatNumber(t.sessions)}</div>
          <div className="ev-sub">{formatNumber(t.users)} usuarios · {t.pagesPerSession != null ? t.pagesPerSession.toFixed(1).replace('.', ',') : '—'} pág./sesión</div>
        </div>
        <div className="ev-panel ev-bkpi">
          <div className="ev-l">Scroll promedio</div>
          <div className="v num">{pct(t.scrollDepth, 0)}</div>
          <div className="ev-sub">de la página</div>
        </div>
        <div className="ev-panel ev-bkpi">
          <div className="ev-l">Tiempo activo</div>
          <div className="v num">{mmss(t.activeTimeSec)}</div>
          <div className="ev-sub">de {mmss(t.totalTimeSec)} en la página</div>
        </div>
        {SIGNALS.slice(0, 3).map(s => (
          <div className="ev-panel ev-bkpi" key={s.key} title={s.help}>
            <div className="ev-l">{s.label}</div>
            <div className="v num">{pct(t.signals[s.key]?.pct)}</div>
            <div className="ev-sub">de las sesiones · {s.help}</div>
          </div>
        ))}
      </div>
      {c.pages.length > 0 && (
        <div className="ev-panel ev-tscroll" style={{ marginTop: 18 }}>
          <div className="ev-l" style={{ marginBottom: 8 }}>Por página (las más visitadas)</div>
          <table className="ev-table num ev-btbl">
            <thead><tr><th>Página</th><th>Sesiones</th><th>Scroll</th><th>Rage clicks</th><th>Clics muertos</th><th>Vuelven rápido</th></tr></thead>
            <tbody>
              {c.pages.map(p => (
                <tr key={p.path} className={p.rage >= 5 || p.dead >= 20 ? 'ev-flag' : ''}>
                  <td className="name" title={p.path}>{p.path}</td>
                  <td>{formatNumber(p.sessions)}</td>
                  <td>{pct(p.scrollDepth, 0)}</td>
                  <td>{pct(p.rage)}</td>
                  <td>{pct(p.dead)}</td>
                  <td>{pct(p.quickback)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ev-note">
            % de las sesiones de cada página que tuvieron esa señal. En rojo: rage clicks ≥ 5% o clics muertos ≥ 20%. Para ver dónde
            exactamente, abrí el mapa de calor de esa página en Clarity.
          </div>
        </div>
      )}
      {c.stale && <div className="ev-note">Datos de la última consulta buena (se llegó al tope diario de la API de Clarity).</div>}
    </>
  );
}
