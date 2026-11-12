import { money, num } from '../format.js';
import { roasText } from './AdsBlocks.jsx';

export default function GoogleCampaignsCard({ campaigns, error }) {
  const rows = (campaigns ?? []).filter(c => c.spend > 0 || c.value > 0);
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Campañas de Google</h2><span>inversión de Google Ads · valor de GA4 (google / cpc)</span></div>
      {error && <p className="nv-empty">{error}: sin el detalle por campaña. Los totales de Google de arriba siguen siendo correctos.</p>}
      {!error && rows.length === 0 && <p className="nv-empty">Sin campañas con inversión en el período.</p>}
      {!error && rows.length > 0 && (
        <div className="nv-tscroll">
          <table className="nv-table nv-compact">
            <thead><tr><th>Campaña</th><th className="r">Inversión</th><th className="r">Clics</th><th className="r">Compras</th><th className="r">Valor</th><th className="r">ROAS</th></tr></thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.name}>
                  <td>
                    <span className="nv-ellip nv-block" title={c.name}>{c.name}</span>
                    {c.brand && <span className="nv-chip">marca</span>}
                  </td>
                  <td className="r">{money(c.spend)}</td>
                  <td className="r">{num(c.clicks)}</td>
                  <td className="r">{num(c.purchases)}</td>
                  <td className="r">{money(c.value)}</td>
                  <td className={`r${c.roas != null && c.roas < 1 ? ' nv-red' : ''}`}>{roasText(c.roas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="nv-note">Marca = búsquedas de "Altorancho": convierte mucho porque la gente ya nos buscaba. Una campaña sin inversión con valor es tráfico que GA4 todavía le atribuye.</div>
    </section>
  );
}
