import { useCallback, useState } from 'react';
import { fmtDateTime, fmtMoney, fmtNumber, fmtRoas } from '../../lib/format.js';

export const STATUS_LABEL = {
  ACTIVE: 'Activo', ENABLED: 'Activo', PAUSED: 'Pausado', CAMPAIGN_PAUSED: 'Campaña pausada', ADSET_PAUSED: 'Conjunto pausado',
  IN_PROCESS: 'En revisión', PENDING_REVIEW: 'En revisión', DISAPPROVED: 'Rechazado', WITH_ISSUES: 'Con problemas',
};
export const TOOL_LABEL = {
  pause_ad: 'Pausar anuncio', set_status: 'Activar / pausar', propose_budget_change: 'Presupuesto', propose_adset: 'Conjunto nuevo',
  create_ad: 'Publicar pieza', promote_ig_post: 'Promocionar post',
  add_negative_keywords: 'Palabras negativas', propose_search_ad: 'Anuncio de búsqueda', set_target_roas: 'Objetivo de ROAS', add_assets: 'Publicar pieza',
};
export const DECISION_LABEL = { pending: 'Pendiente', executed: 'Hecho', rejected: 'Rechazado', failed: 'Falló' };

export function StatusBadge({ status }) {
  const warn = ['DISAPPROVED', 'WITH_ISSUES'].includes(status);
  const active = status === 'ACTIVE' || status === 'ENABLED';
  return <span className={warn ? 'badge warn' : active ? 'badge ok' : 'badge'}>{STATUS_LABEL[status] ?? status}</span>;
}

// El informe del agente viene en texto con **negritas**: se respetan los saltos de línea
export function Report({ text }) {
  return (
    <div className="report">
      {text.split('\n').map((line, i) => (
        <p key={i}>{line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith('**') && part.endsWith('**')
          ? <strong key={j}>{part.slice(2, -2)}</strong> : part))}</p>
      ))}
    </div>
  );
}

// Corre una acción contra la API marcando cuál está en curso; el error queda para mostrar
export function useAction(onDone) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = useCallback(async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      onDone?.(res);
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  }, [onDone]);
  return { busy, error, run, setError };
}

// Botón que pide un segundo toque antes de hacer algo que toca Meta
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className = 'btn' }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <>
      <button type="button" className="btn danger" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" className="btn secondary" onClick={() => setAsking(false)}>Cancelar</button>
    </>
  );
}

// Conjunto destino para publicar: todos los de la cuenta, con su estado
export function AdsetSelect({ adsets, value, onChange }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Conjunto">
      {adsets.map((a) => <option key={a.id} value={a.id}>{a.name} — {STATUS_LABEL[a.effectiveStatus] ?? a.effectiveStatus}</option>)}
    </select>
  );
}

const dec = (v, d = 1) => (v == null ? '—' : String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ','));

// Métricas de la plataforma según el objetivo de la campaña: cada familia se mide con lo suyo (no todo es ROAS)
export function familyLine(family, m) {
  if (!m) return '';
  const spend = `${fmtMoney(m.spend)} gastados`;
  switch (family) {
    case 'sales':
      return `${spend} · ${fmtNumber(m.purchases)} compras · ${fmtMoney(m.purchaseValue)} · ROAS ${fmtRoas(m.roas)} · ${fmtMoney(m.cpa)} por compra`;
    case 'traffic':
      return `${spend} · ${fmtNumber(m.clicks)} clics · CPC ${fmtMoney(m.cpc)} · CTR ${dec(m.ctr, 2)}%`;
    case 'awareness':
      return m.reach
        ? `${spend} · ${fmtNumber(m.reach)} de alcance · CPM ${fmtMoney(m.cpm)}`
        : `${spend} · ${fmtNumber(m.impressions)} impresiones · CPM ${fmtMoney(m.cpm)}`;
    default:
      return `${spend} · ${fmtNumber(m.engagements)} interacciones · ${fmtMoney(m.costPerEngagement)} c/u`;
  }
}
export const FAMILY_LABEL = { sales: 'Ventas', traffic: 'Tráfico', awareness: 'Alcance', engagement: 'Interacción' };

// Compras y ROAS según la plataforma, sumando las campañas (las de ventas son las que traen compras)
export function platformTotals(campaigns) {
  let spend = 0;
  let purchases = 0;
  let value = 0;
  for (const c of campaigns) {
    spend += c.platform7d?.spend || 0;
    purchases += c.platform7d?.purchases || 0;
    value += c.platform7d?.purchaseValue || 0;
  }
  return { spend, purchases: Math.round(purchases * 100) / 100, roas: spend ? value / spend : null };
}

// Tarjetas de arriba del resumen: gasto de hoy, del mes contra el tope y compras / ROAS según la plataforma
export function SummaryCards({ snap, cap, label }) {
  const t = platformTotals(snap.campaigns);
  return (
    <div className="cards">
      <div className="card"><div className="card-label">Gasto hoy</div><div className="card-value">{fmtMoney(snap.spendToday)}</div></div>
      <div className="card">
        <div className="card-label">Gasto del mes</div><div className="card-value">{fmtMoney(snap.month.spend)}</div>
        {cap > 0
          ? (
            <>
              <div className="bar" style={{ marginTop: 6 }} role="progressbar" aria-label="Gasto contra el tope" aria-valuenow={snap.month.spend} aria-valuemax={cap}>
                <span style={{ width: `${Math.min(100, (snap.month.spend * 100) / cap)}%`, '--tag': snap.month.spend > cap ? 'var(--warn)' : 'var(--text)' }} />
              </div>
              <div className="card-sub">Tope {fmtMoney(cap)}</div>
            </>
          )
          : <div className="card-sub">Sin tope cargado (Ajustes)</div>}
      </div>
      <div className="card"><div className="card-label">Compras según {label} (7 días)</div><div className="card-value">{fmtNumber(t.purchases)}</div></div>
      <div className="card"><div className="card-label">ROAS según {label} (7 días)</div><div className="card-value">{fmtRoas(t.roas)}</div></div>
    </div>
  );
}

export function LastReport({ last, schedule }) {
  return (
    <section className="rec">
      <div className="rec-head" style={{ justifyContent: 'space-between' }}>
        <strong>Último informe del agente</strong>
        {last && <span className="note" style={{ margin: 0 }}>{last.status === 'running' ? 'Analizando…' : fmtDateTime(last.finished_at || last.started_at)}</span>}
      </div>
      {!last && <p className="muted">Todavía no corrió. Corre solo todos los días a las {schedule}, o tocá “Analizar ahora”.</p>}
      {last?.status === 'running' && <p className="muted">El agente está mirando la cuenta. Tarda unos minutos.</p>}
      {last?.status === 'failed' && <p className="error">Falló el análisis: {last.error}</p>}
      {last?.report && last.status !== 'running' && <Report text={last.report} />}
    </section>
  );
}

// Pausar / activar a mano un objeto de la plataforma, con doble toque
export function StatusToggle({ api, base, level, obj, onChange, activeStatus = 'ACTIVE' }) {
  const { busy, error, run } = useAction(onChange);
  const active = obj.status === activeStatus;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <ConfirmButton className="chip" label={active ? 'Pausar' : 'Activar'} confirmLabel={active ? 'Sí, pausar' : 'Sí, activar (gasta)'} disabled={!!busy}
        onConfirm={() => run('s', () => api.post(`${base}/objects/${obj.id}/status`, { level, status: active ? 'PAUSED' : activeStatus, name: obj.name ?? obj.text }))} />
      {error && <span className="error">{error}</span>}
    </span>
  );
}

// Botón "Actualizar" de la foto de la plataforma (salta el cache del servidor)
export function useRefresh(api, path, reload) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.get(`${path}?refresh=1`);
      reload();
    } finally {
      setRefreshing(false);
    }
  };
  return { refreshing, refresh };
}
