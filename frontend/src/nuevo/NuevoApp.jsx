import { useEffect, useState } from 'react';
import { getEventReport } from '../api/client.js';
import EventLive from '../components/event/EventLive.jsx';
import InsightsButton from '../components/InsightsButton.jsx';
import ChatWidget from '../components/ChatWidget.jsx';
import { parseUrlState, serializeUrlState } from './urlState.js';
import TopBar from './TopBar.jsx';
import PeriodBar from './PeriodBar.jsx';
import ComingSoon from './ComingSoon.jsx';
import './nuevo.css';

export const TAB_LABELS = {
  resumen: 'Resumen', web: 'Web', locales: 'Locales', producto: 'Producto',
  pauta: 'Pauta', mayorista: 'Mayorista', cyber: 'Cyber',
};

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Tab content. Tabs not built yet say so and link to the current report.
function TabContent({ state, onLogout }) {
  switch (state.tab) {
    case 'cyber': return <EventLive onLogout={onLogout} />;
    default: return <ComingSoon tabLabel={TAB_LABELS[state.tab]} />;
  }
}

export default function NuevoApp({ onLogout }) {
  const today = todayISO();
  const [state, setState] = useState(() => parseUrlState(window.location.search, today));
  const [eventActive, setEventActive] = useState(false);

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

  // The Cyber tab shows only while the event runs (and the day after).
  useEffect(() => {
    let cancelled = false;
    getEventReport('cyber')
      .then(r => { if (!cancelled && r.current?.end) setEventActive(todayISO() <= addDays(r.current.end, 1)); })
      .catch(err => { if (err.message === 'Unauthorized') onLogout(); });
    return () => { cancelled = true; };
  }, [onLogout]);

  const isCyber = state.tab === 'cyber';
  const aiProps = {
    period: state.period, date: state.date, customStart: state.start ?? today, customEnd: state.end ?? today, channel: null,
  };

  return (
    <div className="nv">
      <TopBar
        tab={state.tab}
        showCyber={eventActive || isCyber}
        onTab={(tab) => update({ tab }, { push: true })}
        onLogout={onLogout}
      />
      <main className="nv-wrap">
        {!isCyber && <PeriodBar state={state} today={today} onChange={(patch) => update(patch)} />}
        {!isCyber && <div className="nv-ai"><InsightsButton {...aiProps} /></div>}
        <TabContent state={state} onLogout={onLogout} />
      </main>
      {!isCyber && <ChatWidget {...aiProps} />}
    </div>
  );
}
