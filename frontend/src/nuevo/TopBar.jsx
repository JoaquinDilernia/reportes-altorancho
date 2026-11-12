const TABS = [
  ['resumen', 'Resumen'], ['web', 'Web'], ['locales', 'Locales'],
  ['producto', 'Producto'], ['pauta', 'Pauta'], ['mayorista', 'Mayorista'],
];

export default function TopBar({ tab, showCyber, onTab, onLogout, search = null }) {
  return (
    <header className="nv-top">
      <div className="nv-brand">ALTORANCHO</div>
      <nav className="nv-nav" aria-label="Secciones">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'on' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
        {showCyber && (
          <button type="button" className={`ev${tab === 'cyber' ? ' on' : ''}`} onClick={() => onTab('cyber')}>● Cyber</button>
        )}
      </nav>
      <div className="nv-search-slot">{search}</div>
      <div className="nv-top-links">
        <a href="./">Reporte actual</a>
        <button type="button" onClick={onLogout}>Salir</button>
      </div>
    </header>
  );
}
