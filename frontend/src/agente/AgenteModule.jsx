// Módulo Agente: las pantallas del agente de gineza-agent, servidas por el
// backend de Reportes (/api/gz → gineza). Mismo login que el resto del panel.
import { useMemo, useState } from 'react';
import { API_URL, getToken, clearToken } from '../api/client.js';
import { createApi } from './createApi.js';
import Agente from './pages/Agente.jsx';
import './agente.css';

const KEY = 'ar_panel_agente_platform';
const load = () => {
  try { return localStorage.getItem(KEY) === 'google' ? 'google' : 'meta'; } catch { return 'meta'; }
};

export default function AgenteModule({ onLogout }) {
  const [platform, setPlatformState] = useState(load);
  const setPlatform = (p) => {
    setPlatformState(p);
    try { localStorage.setItem(KEY, p); } catch { /* sin storage */ }
  };
  const api = useMemo(() => createApi({
    baseUrl: `${API_URL}/api/gz`,
    getToken: () => getToken(),
    onAuthError: () => { clearToken(); onLogout?.(); },
  }), [onLogout]);

  return (
    <div className="nv-agent">
      <div className="nv-agent-head">
        <div className="nv-seg" role="tablist" aria-label="Plataforma del agente">
          {[['meta', 'Agente Meta'], ['google', 'Agente Google']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={platform === id} className={platform === id ? 'on' : ''} onClick={() => setPlatform(id)}>{label}</button>
          ))}
        </div>
        <span className="nv-mute">Recomienda qué pausar, escalar o crear. Nada se ejecuta sin tu aprobación (salvo la pausa automática, si la prendés).</span>
      </div>
      <div className="gz">
        <Agente key={platform} api={api} platform={platform} />
      </div>
    </div>
  );
}
