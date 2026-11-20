import { useState } from 'react';
import { usePolling } from '../../hooks/usePolling.js';
import { useAction } from './shared.jsx';

const IMAGE_ACCEPT = 'image/jpeg,image/png';
const IMAGE_MAX = 5 * 1024 * 1024;
const SLOTS = [
  { slot: 'landscape', label: 'Horizontal 1,91:1 (1200×628)', short: 'horizontal' },
  { slot: 'square', label: 'Cuadrada 1:1 (1200×1200)', short: 'cuadrada' },
  { slot: 'portrait', label: 'Vertical 4:5 (960×1200)', short: 'vertical' },
];
const HEADLINE_MAX = 30;
const LONG_MAX = 90;
const DESCRIPTION_MAX = 90;

function checkImage(file) {
  if (!file) return null;
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) return `${file.name}: elegí una imagen JPG o PNG.`;
  if (file.size > IMAGE_MAX) return `${file.name}: pesa más de 5 MB.`;
  return null;
}
const filled = (list) => list.map((t) => t.trim()).filter(Boolean);

// Destinos donde se puede publicar una pieza: grupos de recursos (PMax) y grupos de anuncios de Demand Gen
function targetsOf(snapshot) {
  if (!snapshot) return [];
  const demandGen = new Set(snapshot.campaigns.filter((c) => c.channelType === 'DEMAND_GEN').map((c) => c.id));
  const campaignName = new Map(snapshot.campaigns.map((c) => [c.id, c.name]));
  return [
    ...snapshot.assetGroups.map((a) => ({ target: 'asset_group', id: a.id, name: a.name, campaign: campaignName.get(a.campaignId), kind: 'Performance Max' })),
    ...snapshot.adGroups.filter((g) => demandGen.has(g.campaignId))
      .map((g) => ({ target: 'ad_group', id: g.id, name: g.name, campaign: campaignName.get(g.campaignId), kind: 'Demand Gen' })),
  ];
}

export default function PiezasGoogle({ api, snapshot, storeUrl }) {
  const creatives = usePolling(() => api.get('/gads/creatives').then((r) => r.creatives), [api], 120_000);
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(null);
  const { busy, error, run } = useAction(() => creatives.reload());
  const list = (creatives.data || []).filter((c) => c.status !== 'archived');
  const targets = targetsOf(snapshot);

  return (
    <>
      {!creating && <button type="button" className="btn" onClick={() => setCreating(true)}>Nueva pieza</button>}
      {creating && <NewPiece api={api} storeUrl={storeUrl} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); creatives.reload(); }} />}
      {error && <p className="error">{error}</p>}
      {creatives.data && list.length === 0 && !creating && (
        <p className="muted" style={{ marginTop: 12 }}>Todavía no hay piezas. Cargá títulos, descripciones e imágenes (y un video de YouTube si hay). Después la publicás en un grupo de recursos o se la dejás al agente.</p>
      )}
      <div className="pieces">
        {list.map((c) => {
          const images = SLOTS.filter((s) => c[s.slot]).map((s) => s.short);
          return (
            <article key={c.id} className="piece">
              <div className="piece-body">
                <div className="row-sub" style={{ marginTop: 0 }}>
                  <strong style={{ color: 'var(--text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</strong>
                  <span className={c.status === 'used' ? 'badge ok' : 'badge'}>{c.status === 'used' ? 'Publicada' : c.status === 'publishing' ? 'Publicando…' : 'Sin usar'}</span>
                </div>
                <p className="piece-copy">{(c.headlines || []).join(' · ')}</p>
                {c.long_headline && <p className="note">{c.long_headline}</p>}
                <p className="note">{(c.descriptions || []).join(' · ')}</p>
                <p className="note">Imágenes: {images.length ? images.join(', ') : 'ninguna'}{c.youtube_url ? ' · con video de YouTube' : ''}</p>
                <a className="note" href={c.link} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{c.link}</a>
                {c.status === 'unused' && (
                  publishing === c.id
                    ? <Publish api={api} creative={c} targets={targets} onClose={() => setPublishing(null)} onDone={() => { setPublishing(null); creatives.reload(); }} />
                    : (
                      <div className="actions">
                        <button type="button" className="btn" disabled={targets.length === 0 || images.length === 0 || !!busy} onClick={() => setPublishing(c.id)}>Publicar</button>
                        <button type="button" className="chip" disabled={!!busy} onClick={() => run(c.id, () => api.patch(`/gads/creatives/${c.id}`, { status: 'archived' }))}>Archivar</button>
                      </div>
                    )
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

// Lista de textos con contador de caracteres, de min a max campos
function TextList({ label, values, onChange, min, max, maxLen }) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend>{label}s * <span className="note">({min} a {max}, hasta {maxLen} caracteres)</span></legend>
      {values.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" aria-label={`${label} ${i + 1}`} value={v} onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))} />
          <span className={v.length > maxLen ? 'error' : 'note'} style={{ margin: 0, minWidth: 44, textAlign: 'right' }}>{v.length}/{maxLen}</span>
        </div>
      ))}
      {values.length < max && <button type="button" className="chip" onClick={() => onChange([...values, ''])}>Agregar {label.toLowerCase()}</button>}
    </fieldset>
  );
}

function NewPiece({ api, storeUrl, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', link: '', long_headline: '', youtube_url: '', notes: '' });
  const [headlines, setHeadlines] = useState(['', '', '']);
  const [descriptions, setDescriptions] = useState(['', '']);
  const [files, setFiles] = useState({});
  const [progress, setProgress] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const h = filled(headlines);
  const d = filled(descriptions);
  const chosen = SLOTS.filter((s) => files[s.slot]);
  const fileError = chosen.map((s) => checkImage(files[s.slot])).find(Boolean);
  const ok = form.name.trim() && h.length >= 3 && h.every((t) => t.length <= HEADLINE_MAX)
    && d.length >= 2 && d.every((t) => t.length <= DESCRIPTION_MAX) && form.long_headline.length <= LONG_MAX
    && chosen.length > 0 && !fileError && !saving;

  async function submit() {
    setSaving(true);
    setError(null);
    let creative = null;
    try {
      creative = (await api.post('/gads/creatives', { ...form, headlines: h, descriptions: d })).creative;
      for (const s of chosen) {
        await api.upload(`/gads/creatives/${creative.id}/media/${s.slot}`, files[s.slot], (p) => setProgress({ label: s.short, p }));
      }
      onSaved();
    } catch (e) {
      // Una pieza a medio subir no le sirve al agente: se archiva
      if (creative) await api.patch(`/gads/creatives/${creative.id}`, { status: 'archived' }).catch(() => {});
      setError(e.message);
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  return (
    <section className="panel form">
      <label className="field">Nombre *<input className="input" maxLength={60} value={form.name} onChange={set('name')} placeholder="Corto, para reconocerla (ej. Mantas invierno)" /></label>
      <TextList label="Título" values={headlines} onChange={setHeadlines} min={3} max={5} maxLen={HEADLINE_MAX} />
      <label className="field">Título largo
        <input className="input" value={form.long_headline} onChange={set('long_headline')} placeholder="Opcional; Performance Max lo usa si está" />
        <span className={form.long_headline.length > LONG_MAX ? 'error' : 'note'}>{form.long_headline.length}/{LONG_MAX}</span>
      </label>
      <TextList label="Descripción" values={descriptions} onChange={setDescriptions} min={2} max={5} maxLen={DESCRIPTION_MAX} />
      {SLOTS.map((s) => (
        <label key={s.slot} className="field">{s.label}
          <input type="file" accept={IMAGE_ACCEPT} onChange={(e) => setFiles((f) => ({ ...f, [s.slot]: e.target.files[0] ?? null }))} />
        </label>
      ))}
      <span className="note">Al menos una imagen, JPG o PNG hasta 5 MB. Van directo a la biblioteca de Google.</span>
      {fileError && <p className="error">{fileError}</p>}
      <label className="field">Video de YouTube
        <input className="input" type="url" value={form.youtube_url} onChange={set('youtube_url')} placeholder="Opcional: youtube.com/watch?v=… o youtu.be/…" />
      </label>
      <label className="field">Link de la tienda
        <input className="input" type="url" maxLength={1000} value={form.link} onChange={set('link')} placeholder={storeUrl} />
        <span className="note">Producto o categoría a la que lleva el anuncio. Vacío = la home.</span>
      </label>
      <label className="field">Notas para el agente<textarea className="input" rows={2} maxLength={2000} value={form.notes} onChange={set('notes')} placeholder="Opcional: a qué público apunta, qué ángulo prueba" /></label>
      {progress && <p className="note">Subiendo imagen {progress.label} a Google: {Math.round(progress.p * 100)}%</p>}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" disabled={!ok} onClick={submit}>{saving ? 'Guardando…' : 'Guardar pieza'}</button>
        <button type="button" className="btn secondary" disabled={saving} onClick={onClose}>Cancelar</button>
      </div>
    </section>
  );
}

function Publish({ api, creative, targets, onClose, onDone }) {
  const key = (t) => `${t.target}:${t.id}`;
  const [value, setValue] = useState(targets[0] ? key(targets[0]) : '');
  const { busy, error, run } = useAction(onDone);
  const t = targets.find((x) => key(x) === value);
  return (
    <div className="field" style={{ marginTop: 10 }}>
      <select className="input" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Destino">
        {targets.map((x) => <option key={key(x)} value={key(x)}>{x.name} — {x.kind}{x.campaign ? ` · ${x.campaign}` : ''}</option>)}
      </select>
      <span className="note">En Performance Max se suman los textos e imágenes al grupo de recursos; en Demand Gen se crea un anuncio nuevo en el grupo.</span>
      {error && <p className="error">{error}</p>}
      <div className="actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn" disabled={!t || !!busy}
          onClick={() => run('pub', () => api.post(`/gads/creatives/${creative.id}/publish`, { target: t.target, target_id: t.id, target_name: t.name }))}>
          {busy ? 'Publicando…' : 'Publicar en Google'}
        </button>
        <button type="button" className="btn secondary" disabled={!!busy} onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}
