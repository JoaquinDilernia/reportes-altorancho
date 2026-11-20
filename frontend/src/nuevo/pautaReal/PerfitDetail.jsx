import { useEffect, useState } from 'react';
import { getPerfit } from '../../api/client.js';
import { periodParams } from '../urlState.js';
import { money, num, pct } from '../format.js';

const share = (a, b) => (b ? (a / b) * 100 : null);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }) : '—');

// Perfit por dentro: cada campaña del período y cada automatización, con lo que Perfit
// dice que vendió. Sirve para ver qué mails mueven algo y cuáles son ruido.
export default function PerfitDetail({ state, onLogout }) {
  const { period, date, start, end } = state;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    getPerfit(periodParams({ period, date, start, end }))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) { setError(err.message); if (err.message === 'Unauthorized') onLogout?.(); } });
    return () => { cancelled = true; };
  }, [period, date, start, end, onLogout]);

  if (error) return <p className="nv-empty">Perfit no respondió: {error}</p>;
  if (!data) return <div className="nv-skel-box nv-card" style={{ height: 120 }} aria-busy="true" />;
  if (!data.configured) return null;
  const t = data.campaignTotals;
  const autos = data.automations || data.automationsLifetime.map((a) => ({ ...a, ...a.stats }));
  const lifetime = !data.automations;

  return (
    <section className="nv-card nv-sec">
      <div className="nv-titlebar">
        <div className="nv-h"><h2>Mails de Perfit por dentro</h2><span>{t.count} campañas · {num(t.sent)} envíos</span></div>
        <button type="button" className="nv-link" onClick={() => setOpen((v) => !v)}>{open ? 'ocultar detalle' : 'ver campañas y automatizaciones'}</button>
      </div>
      <div className="nv-vz-tiles">
        <div><span className="nv-mute">Abrieron</span><b>{pct(share(t.opened, t.sent))}</b><span className="nv-mute">inflado por Apple Mail</span></div>
        <div><span className="nv-mute">Hicieron clic</span><b>{pct(share(t.clicked, t.sent), { decimals: 1 })}</b><span className="nv-mute">{num(t.clicked)} personas</span></div>
        <div><span className="nv-mute">Perfit dice que vendieron las campañas</span><b>{money(t.conversionsAmount)}</b><span className="nv-mute">{t.conversions} ventas</span></div>
        <div><span className="nv-mute">{lifetime ? 'Automatizaciones (histórico)' : 'Perfit dice que vendieron las automatizaciones'}</span>
          <b>{money(lifetime ? autos.reduce((n, a) => n + (a.converted_amount || 0), 0) : data.automationTotals.convertedAmount)}</b>
          <span className="nv-mute">{lifetime ? `el período se calcula desde ${day(data.automationsSince)}` : `${data.automationTotals.converted} ventas`}</span></div>
      </div>
      <p className="nv-note">
        Perfit cuenta como suya cualquier compra de alguien que <b>abrió</b> un mail en los días anteriores, aunque haya entrado por Google o por un anuncio.
        Por eso suele dar mucho más que "lo que llegó a la tienda" con un clic de mail.
        Campañas y automatizaciones salen etiquetadas para Google Analytics (las automatizaciones desde el 19/11), así que las visitas que llegan por un mail se ven en Email con su nombre.
      </p>
      {open && (
        <>
          <h3 className="nv-sub-h">Campañas del período</h3>
          <div className="nv-tscroll">
            <table className="nv-table">
              <thead><tr><th>Campaña</th><th>Envío</th><th className="num">Enviados</th><th className="num">Clics</th><th className="num">% clic</th><th className="num">Perfit dice</th></tr></thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td><td>{day(c.launchedAt)}</td><td className="num">{num(c.sent)}</td><td className="num">{num(c.clicked)}</td>
                    <td className="num">{pct(share(c.clicked, c.sent), { decimals: 1 })}</td>
                    <td className="num">{c.conversions ? `${c.conversions} · ${money(c.conversionsAmount)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="nv-sub-h">Automatizaciones {lifetime ? '(totales históricos: el período aparece a partir de mañana)' : 'del período'}</h3>
          <div className="nv-tscroll">
            <table className="nv-table">
              <thead><tr><th>Automatización</th><th className="num">Se dispararon</th><th className="num">Perfit dice que vendió</th><th className="num">Ventas</th></tr></thead>
              <tbody>
                {autos.filter((a) => a.triggered).sort((a, b) => (b.converted_amount || 0) - (a.converted_amount || 0)).map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}{!a.enabled && <span className="nv-mute"> · apagada</span>}</td>
                    <td className="num">{num(a.triggered)}</td><td className="num">{money(a.converted_amount)}</td><td className="num">{num(a.converted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="nv-note">Ojo con las automatizaciones de "pago pendiente", "pedido listo para retirar" o "empaquetar": son mails a gente que ya compró, y Perfit igual les adjudica ventas.</p>
        </>
      )}
    </section>
  );
}
