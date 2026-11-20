import { useEffect, useState } from 'react';
import { getEventReport } from '../api/client.js';
import EventLive from '../components/event/EventLive.jsx';
import InsightsButton from '../components/InsightsButton.jsx';
import ChatWidget from '../components/ChatWidget.jsx';
import { parseUrlState, serializeUrlState } from './urlState.js';
import TopBar from './TopBar.jsx';
import { pickEvent } from './eventTab.js';
import PeriodBar from './PeriodBar.jsx';
import Resumen from './resumen/Resumen.jsx';
import Producto from './producto/Producto.jsx';
import Web from './web/Web.jsx';
import Locales from './locales/Locales.jsx';
import PautaReal from './pautaReal/PautaReal.jsx';
import AgenteModule from '../agente/AgenteModule.jsx';
import Ventas from './ventas/Ventas.jsx';
import Visitas from './visitas/Visitas.jsx';
import Mayorista from './mayorista/Mayorista.jsx';
import ProductSearch from './search/ProductSearch.jsx';
import ProductSheet from './search/ProductSheet.jsx';
import './nuevo.css';

export const TAB_LABELS = {
  resumen: 'Resumen', web: 'Web', locales: 'Locales', producto: 'Producto',
  pauta: 'Pauta', mayorista: 'Mayorista', cyber: 'Cyber',
};

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const EVENT_IDS = ['cyber', 'black'];

// Tab content.
function TabContent({ state, eventId, onLogout, onNavigate, onUpdate }) {
  if (state.m === 'pauta') return <PautaReal state={state} onLogout={onLogout} />;
  if (state.m === 'agente') return <AgenteModule onLogout={onLogout} />;
  if (state.m === 'ventas') return <Ventas state={state} onLogout={onLogout} />;
  if (state.m === 'visitas') return <Visitas state={state} onLogout={onLogout} />;
  switch (state.tab) {
    case 'resumen': return <Resumen state={state} onNavigate={onNavigate} onLogout={onLogout} />;
    case 'web': return <Web state={state} onUpdate={onUpdate} onLogout={onLogout} />;
    case 'locales': return <Locales state={state} onUpdate={onUpdate} onLogout={onLogout} />;
    case 'mayorista': return <Mayorista state={state} onUpdate={onUpdate} onLogout={onLogout} />;
    case 'producto': return <Producto state={state} onUpdate={onUpdate} onLogout={onLogout} />;
    // Keyed so it opens on the active event once that's known.
    case 'cyber': return <EventLive key={eventId ?? 'cyber'} initialEvent={eventId} onLogout={onLogout} />;
    default: return <Resumen state={state} onNavigate={onNavigate} onLogout={onLogout} />;
  }
}

export default function NuevoApp({ onLogout }) {
  const today = todayISO();
  const [state, setState] = useState(() => parseUrlState(window.location.search, today));
  const [activeEvent, setActiveEvent] = useState(null);

  // Period changes replace the history entry; tab changes push one, so
  // "back" walks the tabs.
  const update = (patch, { push = false } = {}) => {
    const next = { ...state, ...patch };
    const url = serializeUrlState(next);
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    setState(next);
  };

  useEffect(() => {
    window.history.replaceState(null, '', serializeUrlState(state));
    const onPop = () => setState(parseUrlState(window.location.search, todayISO()));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // Only on mount: normalizes the URL once and listens for back/forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The event tab shows from 3 weeks before an event (to plan it) through
  // the day after it ends, labelled and opened on that event.
  useEffect(() => {
    let cancelled = false;
    Promise.all(EVENT_IDS.map(id => getEventReport(id)
      .then(r => ({ id, label: r.label, start: r.current?.start, end: r.current?.end }))
      .catch((err) => { if (err.message === 'Unauthorized') onLogout(); return null; })))
      .then(windows => { if (!cancelled) setActiveEvent(pickEvent(windows, todayISO())); });
    return () => { cancelled = true; };
  }, [onLogout]);

  const isCyber = state.m === 'reportes' && state.tab === 'cyber';
  const isAgent = state.m === 'agente';
  // Las alertas del Resumen que apuntan a la pauta abren el módulo Pauta.
  const navigate = (tab) => (tab === 'pauta' ? update({ m: 'pauta' }, { push: true }) : update({ m: 'reportes', tab }, { push: true }));
  const aiProps = {
    period: state.period, date: state.date, customStart: state.start ?? today, customEnd: state.end ?? today, channel: null,
  };

  return (
    <div className="nv">
      <TopBar
        module={state.m}
        onModule={(m) => update({ m }, { push: true })}
        tab={state.tab}
        showCyber={!!activeEvent || isCyber}
        eventLabel={activeEvent?.label ?? 'Cyber'}
        onTab={(tab) => update({ tab }, { push: true })}
        onLogout={onLogout}
        search={<ProductSearch onSelect={(sku) => update({ sku }, { push: true })} />}
      />
      <main className="nv-wrap">
        {!isCyber && !isAgent && <PeriodBar state={state} today={today} onChange={(patch) => update(patch)} />}
        {!isCyber && !isAgent && <div className="nv-ai"><InsightsButton {...aiProps} /></div>}
        <TabContent state={state} eventId={activeEvent?.id} onLogout={onLogout} onNavigate={navigate} onUpdate={update} />
      </main>
      {!isCyber && !isAgent && <ChatWidget {...aiProps} />}
      {state.sku && <ProductSheet sku={state.sku} state={state} onClose={() => update({ sku: null }, { push: true })} />}
    </div>
  );
}
