const TABS = [
  ['resumen', 'Resumen'], ['web', 'Web'], ['locales', 'Locales'],
  ['producto', 'Producto'], ['mayorista', 'Mayorista'],
];
export const MODULE_LABELS = [['reportes', 'Reportes'], ['pauta', 'Pauta'], ['agente', 'Agente']];

export default function TopBar({ module = 'reportes', onModule, tab, showCyber, eventLabel = 'Cyber', onTab, onLogout, search = null }) {
  return (
    <header className="nv-top">
      <div className="nv-brand"><img src="/logo-wordmark.png" alt="altorancho." className="nv-logo" /></div>
      <nav className="nv-mods" aria-label="Módulos">
        {MODULE_LABELS.map(([id, label]) => (
          <button key={id} type="button" className={module === id ? 'on' : ''} aria-current={module === id ? 'page' : undefined} onClick={() => onModule?.(id)}>
            {label}
          </button>
        ))}
      </nav>
      {module === 'reportes' && (
        <nav className="nv-nav" aria-label="Secciones">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? 'on' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
              {label}
            </button>
          ))}
          {showCyber && (
            <button type="button" className={`ev${tab === 'cyber' ? ' on' : ''}`} onClick={() => onTab('cyber')}>● {eventLabel}</button>
          )}
        </nav>
      )}
      <div className="nv-search-slot">{module === 'reportes' ? search : null}</div>
      <div className="nv-top-links">
        <button type="button" onClick={onLogout}>Salir</button>
      </div>
    </header>
  );
}
