import { useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { usePolling } from '../hooks/usePolling.js';
import { fmtMoney, fmtNumber } from '../lib/format.js';
import { LastReport, StatusBadge, StatusToggle, SummaryCards, familyLine, useAction, useRefresh } from './agente/shared.jsx';
import Preguntas from './agente/Preguntas.jsx';
import Recomendaciones from './agente/Recomendaciones.jsx';
import Piezas from './agente/Piezas.jsx';
import PiezasGoogle from './agente/PiezasGoogle.jsx';
import ResumenGoogle from './agente/ResumenGoogle.jsx';

// Lo que cambia entre el agente de Meta y el de Google
const PLATFORMS = {
  meta: {
    base: '/ads', label: 'Meta', title: 'Agente Meta', subtitle: 'Meta Ads · datos de Meta por objetivo', schedule: '8:00', tabKey: 'ar_agente_tab',
    missing: 'Falta conectar Meta en el servidor (META_ACCESS_TOKEN).',
  },
  google: {
    base: '/gads', label: 'Google', title: 'Agente Google', subtitle: 'Google Ads · datos de Google por objetivo', schedule: '8:15', tabKey: 'ar_agente_google_tab',
    missing: 'Falta conectar Google Ads en el servidor (GOOGLE_ADS_SERVICE_ACCOUNT y GOOGLE_ADS_CUSTOMER_ID).',
  },
};

const loadTab = (key) => {
  try {
    return localStorage.getItem(key) || 'resumen';
  } catch {
    return 'resumen';
  }
};

export default function Agente({ api, platform = 'meta' }) {
  const p = PLATFORMS[platform];
  const { base } = p;
  const [tab, setTabState] = useState(() => loadTab(p.tabKey));
  const setTab = (t) => {
    setTabState(t);
    try { localStorage.setItem(p.tabKey, t); } catch { /* sin storage */ }
  };
  // Mientras el agente analiza, el resumen se vuelve a pedir cada 5 s
  const [fast, setFast] = useState(false);
  const overview = usePolling(() => api.get(`${base}/overview`).then((d) => {
    setFast(d.lastRun?.status === 'running');
    return d;
  }), [api, base], fast ? 5000 : 120_000);
  const data = overview.data;
  const running = data?.lastRun?.status === 'running';
  const { busy, error, run } = useAction(() => overview.reload());
  const connected = data && (platform === 'google' ? data.configured.google : data.configured.meta);
  const platformError = data && (platform === 'google' ? data.googleError : data.metaError);

  const tabs = [
    { id: 'resumen', label: `Resumen${data?.openQuestions ? ` (${data.openQuestions})` : ''}` },
    { id: 'recomendaciones', label: `Recomendaciones${data?.pendingCount ? ` (${data.pendingCount})` : ''}` },
    { id: 'piezas', label: 'Piezas' },
    { id: 'ajustes', label: 'Ajustes' },
  ];

  return (
    <>
      <PageHeader
        title={p.title}
        subtitle={p.subtitle}
        actions={data?.configured.agent && (
          <button type="button" className="btn" disabled={running || !!busy} onClick={() => run('run', () => api.post(`${base}/runs`))}>
            {running ? 'Analizando…' : 'Analizar ahora'}
          </button>
        )}
      />
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'chip active' : 'chip'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!data && !overview.error && <p className="muted">Cargando…</p>}
      {overview.error && <p className="error">{overview.error}</p>}
      {error && <p className="error">{error}</p>}
      {data && !connected && <p className="banner error">{p.missing}</p>}
      {connected && !data.configured.agent && <p className="banner error">Falta la clave de Claude (ANTHROPIC_API_KEY): el agente no puede analizar.</p>}
      {platformError && <p className="banner error">{p.label} no respondió: {platformError}</p>}
      {data && tab === 'resumen' && (platform === 'google'
        ? <ResumenGoogle api={api} data={data} reload={overview.reload} />
        : <Resumen api={api} data={data} reload={overview.reload} />)}
      {data && tab === 'recomendaciones' && <Recomendaciones api={api} base={base} platformLabel={p.label} onChange={overview.reload} />}
      {data && tab === 'piezas' && (platform === 'google'
        ? <PiezasGoogle api={api} snapshot={data.snapshot} storeUrl={data.storeUrl} />
        : <Piezas api={api} snapshot={data.snapshot} storeUrl={data.storeUrl} />)}
      {data && tab === 'ajustes' && <Ajustes api={api} platform={platform} data={data} onSaved={overview.reload} />}
    </>
  );
}

function Resumen({ api, data, reload }) {
  const snap = data.snapshot;
  const { refreshing, refresh } = useRefresh(api, '/ads/overview', reload);
  return (
    <>
      {snap && <SummaryCards snap={snap} cap={data.settings.monthly_cap_ars} label="Meta" />}
      <LastReport last={data.lastRun} schedule="8:00" />
      <Preguntas api={api} base="/ads" onChange={reload} />

      {snap && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="section-title">Campañas</h2>
            <button type="button" className="chip" disabled={refreshing} onClick={refresh}>{refreshing ? 'Actualizando…' : 'Actualizar'}</button>
          </div>
          {snap.campaigns.length === 0 && <p className="muted">No hay campañas en la cuenta.</p>}
          {snap.campaigns.map((c) => <Campaign key={c.id} api={api} c={c} snap={snap} onChange={reload} />)}
        </>
      )}
    </>
  );
}

// Métricas de Meta según el objetivo y, en gris, las ventas de la tienda como referencia
function Metrics({ o, extra = '' }) {
  return (
    <>
      <div className="row-sub">{familyLine(o.family, o.platform7d)}{extra}</div>
      {o.store7d && <div className="note" style={{ marginTop: 2 }}>Tienda: {fmtNumber(o.store7d.sales)} ventas · {fmtMoney(o.store7d.revenue)}</div>}
    </>
  );
}

function Campaign({ api, c, snap, onChange }) {
  const adsets = snap.adsets.filter((a) => a.campaignId === c.id);
  return (
    <div className="tree">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="row-main">
          <div className="row-title">{c.name}</div>
          <div className="row-sub">{c.dailyBudgetArs ? `${fmtMoney(c.dailyBudgetArs)} por día` : 'Presupuesto por conjunto'}</div>
          <Metrics o={c} />
        </div>
        <div className="row-side"><StatusBadge status={c.effectiveStatus} /> <StatusToggle api={api} base="/ads" level="campaign" obj={c} onChange={onChange} /></div>
      </div>
      {adsets.map((a) => {
        const ads = snap.ads.filter((ad) => ad.adsetId === a.id);
        return (
          <div key={a.id} className="tree-adset">
            <div className="row" style={{ alignItems: 'center' }}>
              <div className="row-main">
                <div className="row-title">{a.name}</div>
                {(a.dailyBudgetArs || a.learningStage === 'LEARNING') && (
                  <div className="row-sub">{a.dailyBudgetArs ? `${fmtMoney(a.dailyBudgetArs)}/día` : ''}{a.dailyBudgetArs && a.learningStage === 'LEARNING' ? ' · ' : ''}{a.learningStage === 'LEARNING' ? 'en aprendizaje' : ''}</div>
                )}
                <Metrics o={a} />
              </div>
              <div className="row-side"><StatusBadge status={a.effectiveStatus} /> <StatusToggle api={api} base="/ads" level="adset" obj={a} onChange={onChange} /></div>
            </div>
            {ads.length === 0 && <p className="error" style={{ padding: '6px 0' }}>Sin anuncios: cargá una pieza en “Piezas” y publicala acá.</p>}
            {ads.map((ad) => (
              <div key={ad.id} className="row tree-ad" style={{ alignItems: 'center' }}>
                {ad.thumbnail && <img src={ad.thumbnail} alt="" className="thumb-sm" />}
                <div className="row-main">
                  <div className="row-title">{ad.name}</div>
                  <Metrics o={ad} extra={ad.delivery7d?.frequency ? ` · frec. ${String(ad.delivery7d.frequency).replace('.', ',')}` : ''} />
                </div>
                <div className="row-side"><StatusBadge status={ad.effectiveStatus} /> <StatusToggle api={api} base="/ads" level="ad" obj={ad} onChange={onChange} /></div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const SETTINGS_FIELDS = ['agent_enabled', 'autonomous', 'auto_pause_min_spend_ars', 'auto_pause_days', 'monthly_cap_ars', 'business_notes'];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const int = (v, min = 0) => Math.max(min, Math.round(Number(v) || 0));

function Ajustes({ api, platform, data, onSaved }) {
  const p = PLATFORMS[platform];
  const fields = platform === 'google' ? [...SETTINGS_FIELDS, 'purchase_action'] : SETTINGS_FIELDS;
  const initial = pick(data.settings, fields);
  const [form, setForm] = useState(initial);
  const [msg, setMsg] = useState(null);
  const { busy, error, run } = useAction(() => {
    setMsg('Guardado');
    onSaved();
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  // Mientras se escribe el campo puede quedar vacío: se valida al guardar
  const daysOk = Number.isInteger(form.auto_pause_days) && form.auto_pause_days >= 1 && form.auto_pause_days <= 30;
  const save = () => run('save', () => api.put(`${p.base}/settings`, form));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <section className="form">
      <label className="check">
        <input type="checkbox" checked={form.agent_enabled} onChange={(e) => set('agent_enabled')(e.target.checked)} />
        <span><strong>Agente prendido</strong><span className="note">Analiza la cuenta todos los días a las {p.schedule} y deja recomendaciones para aprobar.</span></span>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.autonomous} onChange={(e) => set('autonomous')(e.target.checked)} />
        <span><strong>Pausa automática</strong><span className="note">Pausa solo lo que gastó al menos el mínimo sin ninguna compra en el período. Solo campañas de ventas.</span></span>
      </label>
      {form.autonomous && !form.auto_pause_min_spend_ars && <p className="banner error">No va a pausar nada hasta que cargues un mínimo.</p>}
      <label className="field">Gasto mínimo sin compras (pesos)
        <input className="input" type="number" min={0} step={1000} value={form.auto_pause_min_spend_ars}
          onChange={(e) => set('auto_pause_min_spend_ars')(int(e.target.value))} />
      </label>
      <label className="field">Período a mirar (días)
        <input className="input" type="number" min={1} max={30} value={form.auto_pause_days}
          onChange={(e) => set('auto_pause_days')(e.target.value === '' ? '' : int(e.target.value))} />
        {!daysOk && <span className="error">Entre 1 y 30 días.</span>}
      </label>
      <label className="field">Tope mensual de inversión en {p.label} (pesos)
        <input className="input" type="number" min={0} step={10000} value={form.monthly_cap_ars}
          onChange={(e) => set('monthly_cap_ars')(int(e.target.value))} />
        <span className="note">0 = sin tope: el agente te lo va a preguntar antes de proponer subas.</span>
      </label>
      {platform === 'google' && data.configured.google && (
        <PurchaseAction api={api} value={form.purchase_action} onChange={set('purchase_action')} />
      )}
      <label className="field">Contexto para el agente
        <textarea className="input" rows={5} maxLength={5000} value={form.business_notes} onChange={(e) => set('business_notes')(e.target.value)}
          placeholder="Promos, productos o categorías a empujar, stock, qué no hacer…" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" disabled={!dirty || !daysOk || !!busy} onClick={save}>Guardar</button>
        {msg && !dirty && <span className="note" role="status">{msg}</span>}
      </div>
    </section>
  );
}

// Acción de conversión de Google que cuenta como compra (vacío = la elige sola)
function PurchaseAction({ api, value, onChange }) {
  const actions = usePolling(() => api.get('/gads/conversion-actions').then((r) => r.actions), [api], 600_000);
  const list = actions.data || [];
  const purchases = list.filter((a) => a.category === 'PURCHASE');
  const auto = purchases.find((a) => a.primary) || purchases[0];
  return (
    <label className="field">Acción de compra
      <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{auto ? `Automática: ${auto.name}` : 'Automática (no hay ninguna de compra)'}</option>
        {list.map((a) => <option key={a.resourceName} value={a.resourceName}>{a.name}{a.category !== 'PURCHASE' ? ` (${a.category})` : ''}</option>)}
      </select>
      {actions.error && <span className="error">{actions.error}</span>}
      <span className="note">Las compras de Google se cuentan solo con esta acción (las demás conversiones inflan los números).</span>
    </label>
  );
}
