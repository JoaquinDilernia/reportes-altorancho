import { fmtMoney, fmtNumber } from '../../lib/format.js';
import Preguntas from './Preguntas.jsx';
import { FAMILY_LABEL, LastReport, StatusBadge, StatusToggle, SummaryCards, familyLine, useRefresh } from './shared.jsx';

const CHANNEL_LABEL = { SEARCH: 'Search', PERFORMANCE_MAX: 'Performance Max', DEMAND_GEN: 'Demand Gen', DISPLAY: 'Display', VIDEO: 'Video', SHOPPING: 'Shopping' };
const MATCH_LABEL = { EXACT: 'exacta', PHRASE: 'frase', BROAD: 'amplia' };
const roas = (v) => String(v).replace('.', ',');

function PurchaseActionNote({ pa }) {
  if (!pa) return <p className="banner error">No hay ninguna acción de conversión de compra activa en Google: las compras salen en 0. Elegila en Ajustes.</p>;
  return (
    <>
      <p className="note">Acción de compra: {pa.name}{pa.auto ? ' (automática)' : ''}</p>
      {pa.overrideMissing && <p className="banner error">La acción de compra elegida en Ajustes ya no está activa: se usa la automática.</p>}
    </>
  );
}

// Foto de la cuenta de Google: métricas de Google según el objetivo de cada campaña
export default function ResumenGoogle({ api, data, reload }) {
  const snap = data.snapshot;
  const { refreshing, refresh } = useRefresh(api, '/gads/overview', reload);
  return (
    <>
      {snap && <SummaryCards snap={snap} cap={data.settings.monthly_cap_ars} label="Google" />}
      {snap && <PurchaseActionNote pa={data.purchaseAction} />}
      <LastReport last={data.lastRun} schedule="8:15" />
      <Preguntas api={api} base="/gads" onChange={reload} />

      {snap && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="section-title">Campañas</h2>
            <button type="button" className="chip" disabled={refreshing} onClick={refresh}>{refreshing ? 'Actualizando…' : 'Actualizar'}</button>
          </div>
          {snap.campaigns.length === 0 && <p className="muted">No hay campañas en la cuenta.</p>}
          {snap.campaigns.map((c) => <Campaign key={c.id} api={api} c={c} snap={snap} onChange={reload} />)}
          <SearchTerms terms={snap.searchTerms} />
        </>
      )}
    </>
  );
}

function Campaign({ api, c, snap, onChange }) {
  const adGroups = snap.adGroups.filter((g) => g.campaignId === c.id);
  const assetGroups = snap.assetGroups.filter((a) => a.campaignId === c.id);
  const sub = [
    CHANNEL_LABEL[c.channelType] ?? c.channelType,
    FAMILY_LABEL[c.family],
    c.dailyBudgetArs ? `${fmtMoney(c.dailyBudgetArs)} por día` : null,
    c.targetRoas ? `objetivo ROAS ${roas(c.targetRoas)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="tree">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="row-main">
          <div className="row-title">{c.name}</div>
          <div className="row-sub">{sub}</div>
          <div className="row-sub">{familyLine(c.family, c.platform7d)}</div>
        </div>
        <div className="row-side"><StatusBadge status={c.status} /> <StatusToggle api={api} base="/gads" level="campaign" obj={c} activeStatus="ENABLED" onChange={onChange} /></div>
      </div>
      {adGroups.map((g) => {
        const keywords = snap.keywords.filter((k) => k.adGroupId === g.id);
        return (
          <div key={g.id} className="tree-adset">
            <div className="row" style={{ alignItems: 'center' }}>
              <div className="row-main">
                <div className="row-title">{g.name}</div>
                <div className="row-sub">{familyLine(g.family, g.platform7d)}</div>
              </div>
              <div className="row-side"><StatusBadge status={g.status} /> <StatusToggle api={api} base="/gads" level="ad_group" obj={g} activeStatus="ENABLED" onChange={onChange} /></div>
            </div>
            {keywords.map((k) => (
              <div key={k.id} className="row tree-ad" style={{ alignItems: 'center' }}>
                <div className="row-main">
                  <div className="row-title">{k.text}</div>
                  <div className="row-sub">Concordancia {MATCH_LABEL[k.matchType] ?? k.matchType} · {familyLine(c.family, k.platform7d)}</div>
                </div>
                <div className="row-side"><StatusBadge status={k.status} /> <StatusToggle api={api} base="/gads" level="keyword" obj={k} activeStatus="ENABLED" onChange={onChange} /></div>
              </div>
            ))}
          </div>
        );
      })}
      {assetGroups.length > 0 && (
        <div className="tree-adset">
          {assetGroups.map((a) => (
            <div key={a.id} className="row" style={{ alignItems: 'center' }}>
              <div className="row-main">
                <div className="row-title">{a.name}</div>
                <div className="row-sub">Grupo de recursos</div>
              </div>
              <div className="row-side"><StatusBadge status={a.status} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Búsquedas reales que gastaron sin compras: de acá salen las palabras negativas
function SearchTerms({ terms }) {
  if (!terms?.length) return null;
  return (
    <details className="rec">
      <summary>Búsquedas que gastan sin comprar (14 días) · {terms.length}</summary>
      <ul className="list">
        {terms.map((t) => (
          <li key={`${t.adGroupId}|${t.term}`} className="row">
            <div className="row-main">
              <div className="row-title" style={{ whiteSpace: 'normal' }}>{t.term}</div>
              <div className="row-sub">{fmtMoney(t.spend)} · {fmtNumber(t.clicks)} clics</div>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
