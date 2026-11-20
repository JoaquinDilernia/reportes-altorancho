import { money, pct } from '../format.js';

const ROWS = [
  ['meta', 'Meta', '#1877F2'],
  ['google', 'Google', '#EA4335'],
  ['rest', 'Orgánico, email y otros', '#1BAF7A'],
];

function Split({ s }) {
  const known = s.nuevo.orders + s.recurrente.orders;
  const newShare = known ? (s.nuevo.orders / known) * 100 : 0;
  return (
    <span className="nv-pr-nr" role="img" aria-label={`${pct(s.newPct)} clientes nuevos`}>
      <span className="new" style={{ width: `${newShare}%` }} />
      <span className="ret" style={{ width: `${100 - newShare}%` }} />
    </span>
  );
}

// Clientes nuevos vs. recurrentes: ¿la pauta trae gente nueva o le vende a los de siempre?
export default function Customers({ data, loading, error }) {
  if (loading) {
    return (
      <section className="nv-card nv-sec" aria-busy="true">
        <div className="nv-h"><h2>Clientes nuevos vs. recurrentes</h2></div>
        <div className="nv-skel-box nv-card" style={{ height: 120 }} />
        <p className="nv-note">Revisando en Tienda Nube la historia de cada cliente… la primera vez de cada período tarda hasta un minuto.</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="nv-card nv-sec">
        <div className="nv-h"><h2>Clientes nuevos vs. recurrentes</h2></div>
        <p className="nv-empty">No se pudo calcular: {error}</p>
      </section>
    );
  }
  if (!data) return null;
  const { web, platform, rest, attributed } = data;
  return (
    <section className="nv-card nv-sec">
      <div className="nv-h"><h2>Clientes nuevos vs. recurrentes</h2><span>nuevo = primera compra en la tienda online (historia desde 2023)</span></div>
      <p className="nv-pr-say nv-pr-say-sm">
        El <b>{pct(web.newPct)}</b> de los pedidos web fueron de clientes que compraban por primera vez
        {' '}(<b>{money(web.nuevo.revenue)}</b>); el resto, <b>{money(web.recurrente.revenue)}</b>, de clientes que ya nos conocían.
      </p>
      <div className="nv-pr-nrhead nv-mute">
        <span />
        <span><span className="nv-dot" style={{ background: 'var(--nv-pr-new)' }} />nuevos · <span className="nv-dot" style={{ background: 'var(--nv-pr-ret)' }} />recurrentes</span>
        <span className="r">% nuevos</span>
        <span className="r">Clientes nuevos</span>
        <span className="r">Costo por cliente nuevo</span>
      </div>
      {attributed && ROWS.map(([id, label, color]) => {
        const s = id === 'rest' ? rest : platform[id];
        return (
          <div className="nv-pr-nrrow" key={id}>
            <span className="nv-chname"><span className="nv-dot" style={{ background: color }} />{label}</span>
            <Split s={s} />
            <b className="r">{pct(s.newPct)}</b>
            <span className="r">{s.nuevo.orders} <span className="nv-mute">· {money(s.nuevo.revenue)}</span></span>
            <span className="r">{id === 'rest' ? <span className="nv-mute">sin pauta</span> : <b>{money(s.costPerNew)}</b>}</span>
          </div>
        );
      })}
      {!attributed && (
        <div className="nv-pr-nrrow">
          <span className="nv-chname">Toda la web</span>
          <Split s={web} />
          <b className="r">{pct(web.newPct)}</b>
          <span className="r">{web.nuevo.orders}</span>
          <span />
        </div>
      )}
      <p className="nv-note">
        Costo por cliente nuevo = inversión de la plataforma ÷ clientes nuevos que llegaron con su clic. Es un techo: parte de esa inversión también trajo recompras.
        {web.sinDato.orders > 0 && ` ${web.sinDato.orders} pedidos sin cliente identificado no cuentan.`}
      </p>
    </section>
  );
}
