export default function ComingSoon({ tabLabel }) {
  return (
    <section className="nv-card nv-soon">
      <div className="nv-lbl">{tabLabel}</div>
      <h2>Próximamente</h2>
      <p>Esta sección del reporte nuevo todavía se está armando. Mientras tanto, los datos están en el reporte anterior.</p>
      <a className="nv-btn" href="?v=actual">Ver en el reporte anterior</a>
    </section>
  );
}
