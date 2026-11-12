const KIND_LABEL = { local: 'Local', stock: 'Stock', web: 'Web', producto: 'Producto', pauta: 'Pauta', bien: 'Bien' };
const TAB_LABEL = { locales: 'Locales', producto: 'Producto', web: 'Web', pauta: 'Pauta' };
const WHEN = { week: 'esta semana', month: 'este mes', custom: 'en este rango' };

export default function AlertsCard({ alerts, period, onNavigate }) {
  return (
    <section className="nv-card">
      <div className="nv-h"><h2>Para mirar {WHEN[period]}</h2><span>se arma solo, con reglas fijas</span></div>
      {alerts.length === 0 && <p className="nv-empty">Nada fuera de lo normal {WHEN[period]}.</p>}
      {alerts.map(a => (
        <div className="nv-alert" key={a.id}>
          <span className={`nv-tag t-${a.tone}`}>{KIND_LABEL[a.kind] ?? a.kind}</span>
          <div className="nv-alert-body">
            <b>{a.title}</b>
            <p>{a.detail}</p>
          </div>
          {a.tab && (
            <button type="button" className="nv-go" onClick={() => onNavigate(a.tab)}>Ver {TAB_LABEL[a.tab] ?? a.tab} ›</button>
          )}
        </div>
      ))}
    </section>
  );
}
