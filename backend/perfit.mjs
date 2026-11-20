// Perfit (email marketing): campañas enviadas y automatizaciones, con lo que Perfit
// dice que vendió. La API da los totales históricos de cada automatización, así que
// guardamos una foto por día y el período sale de restar dos fotos.
import { getDb } from './firestore.mjs';

const BASE = 'https://api.myperfit.com/v2';
const SNAP = 'altorancho_reportes_perfit_daily';
const STAT_KEYS = ['triggered', 'completed', 'converted', 'converted_amount'];

export const isPerfitConfigured = () => Boolean(process.env.PERFIT_API_KEY);
const account = () => process.env.PERFIT_ACCOUNT || String(process.env.PERFIT_API_KEY || '').split('-')[0];

async function get(path, fetchFn = fetch) {
  const res = await fetchFn(`${BASE}/${account()}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.PERFIT_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Perfit ${path.split('?')[0]} respondió ${res.status}`);
  return res.json();
}

// Campañas lanzadas entre start y end (YYYY-MM-DD, Argentina), de la más nueva a la más vieja.
export async function fetchCampaigns(start, end, { fetchFn } = {}) {
  const from = new Date(`${start}T00:00:00-03:00`);
  const to = new Date(new Date(`${end}T00:00:00-03:00`).getTime() + 864e5);
  const out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const j = await get(`campaigns?sortBy=launchDate&sortDir=desc&limit=100&offset=${offset}`, fetchFn);
    const rows = j.data || [];
    for (const c of rows) {
      const at = c.launchDate ? new Date(c.launchDate) : null;
      if (!at || c.state !== 'SENT') continue;
      if (at >= from && at < to) out.push(c);
    }
    const oldest = rows.length ? new Date(rows[rows.length - 1].launchDate || 0) : null;
    if (!rows.length || (oldest && oldest < from) || !j.paging?.next) break;
  }
  // El listado no trae las opciones (UTMs): se piden de a 5
  for (let i = 0; i < out.length; i += 5) {
    await Promise.all(out.slice(i, i + 5).map(async (c, k) => {
      try {
        const d = await get(`campaigns/${c.id}`, fetchFn);
        out[i + k] = { ...c, ...(d.data || {}) };
      } catch { /* sin detalle: queda sin saber si tiene UTMs */ }
    }));
  }
  return out.map(campaignRow);
}

export function campaignRow(c) {
  const m = c.metrics || {};
  return {
    id: c.id, name: c.name, launchedAt: c.launchDate, recipients: c.recipients ?? m.sent ?? 0,
    sent: m.sent ?? 0, opened: m.opened ?? 0, clicked: m.clicked ?? 0,
    conversions: m.conversions ?? 0, conversionsAmount: m.conversionsAmount ?? 0,
    // Si está apagado, los links salen sin UTMs y no podemos verificar nada de lo que se atribuye
    utms: c.options ? c.options.GOOGLE_ANALYTICS === '1' : null,
  };
}

export async function fetchAutomations({ fetchFn } = {}) {
  const j = await get('automations?limit=100', fetchFn);
  return (j.data || []).map((a) => ({
    id: a.id, name: a.name, enabled: Boolean(a.enabled), trigger: a.trigger,
    stats: Object.fromEntries(STAT_KEYS.map((k) => [k, Number(a.stats?.[k]) || 0])),
  }));
}

// Diferencia entre dos fotos: lo que hizo cada automatización entre una y otra.
export function automationDelta(before, after) {
  const prev = new Map((before || []).map((a) => [a.id, a.stats]));
  return (after || []).map((a) => {
    const p = prev.get(a.id);
    const d = Object.fromEntries(STAT_KEYS.map((k) => [k, p ? Math.max(0, a.stats[k] - (p[k] || 0)) : null]));
    return { id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger, ...d };
  });
}

export async function snapshotAutomations(day, { fetchFn } = {}) {
  const automations = await fetchAutomations({ fetchFn });
  await getDb().collection(SNAP).doc(day).set({ day, automations, takenAt: new Date().toISOString() });
  return automations.length;
}

async function snapshotOnOrBefore(day) {
  const s = await getDb().collection(SNAP).where('day', '<=', day).orderBy('day', 'desc').limit(1).get();
  return s.empty ? null : s.docs[0].data();
}
async function firstSnapshot() {
  const s = await getDb().collection(SNAP).orderBy('day', 'asc').limit(1).get();
  return s.empty ? null : s.docs[0].data();
}

const addDay = (d, n) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

// Resumen para Pauta: campañas del período + automatizaciones (si hay fotos que lo cubran).
export async function getPerfitSummary({ start, end }, today) {
  if (!isPerfitConfigured()) return null;
  const until = end < today ? end : today;
  const [campaigns, autoNow, before, after, first] = await Promise.all([
    fetchCampaigns(start, end),
    fetchAutomations(),
    snapshotOnOrBefore(addDay(start, -1)),
    end < today ? snapshotOnOrBefore(end) : Promise.resolve(null),
    firstSnapshot(),
  ]);
  const afterAutos = after ? after.automations : autoNow;
  const covered = Boolean(before && before.day >= addDay(start, -2));
  const automations = covered
    ? automationDelta(before.automations, afterAutos).filter((a) => a.triggered || a.converted)
    : null;
  const sum = (rows, k) => (rows || []).reduce((n, r) => n + (r[k] || 0), 0);
  return {
    range: { start, end: until },
    campaigns,
    campaignTotals: { count: campaigns.length, sent: sum(campaigns, 'sent'), opened: sum(campaigns, 'opened'), clicked: sum(campaigns, 'clicked'), conversions: sum(campaigns, 'conversions'), conversionsAmount: sum(campaigns, 'conversionsAmount'), withoutUtms: campaigns.filter((c) => c.utms === false).length },
    automations,
    automationTotals: automations ? { converted: sum(automations, 'converted'), convertedAmount: sum(automations, 'converted_amount') } : null,
    automationsSince: first?.day || null,
    // histórico, para mostrar mientras no haya fotos del período
    automationsLifetime: autoNow.filter((a) => a.enabled).sort((a, b) => b.stats.converted_amount - a.stats.converted_amount),
  };
}
