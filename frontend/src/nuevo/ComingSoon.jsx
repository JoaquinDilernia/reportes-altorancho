export default function ComingSoon({ tabLabel }) {
  return (
    <section className="nv-card nv-soon">
      <div className="nv-lbl">{tabLabel}</div>
      <h2>Próximamente</h2>
      <p>Esta sección del reporte nuevo todavía se está armando. Mientras tanto, los datos están en el reporte actual.</p>
      <a className="nv-btn" href="./">Ver en el reporte actual</a>
    </section>
  );
}
