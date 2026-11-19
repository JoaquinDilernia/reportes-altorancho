// Pinterest Ads: gasto y lo que Pinterest dice que vendió, por día, de la
// cuenta publicitaria (API v5, solo lectura). Se guarda en Firestore igual
// que Meta y Google para que Pauta lo lea sin llamar a Pinterest.
//
// Token: PINTEREST_ACCESS_TOKEN (generado en developers.pinterest.com). Si
// además hay PINTEREST_REFRESH_TOKEN + PINTEREST_APP_ID + PINTEREST_APP_SECRET,
// se renueva solo y el token nuevo queda en Firestore.
import { getDb } from './firestore.mjs';

const API = 'https://api.pinterest.com/v5';
export const PINTEREST_DAILY_COL = 'altorancho_reportes_pinterest_ads_daily';
const STATE_DOC = ['config', 'pinterest_ads'];
const MAX_DAYS = 89; // la API acepta hasta 90 días por pedido
const COLUMNS = ['SPEND_IN_MICRO_DOLLAR', 'TOTAL_CHECKOUT', 'TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR', 'TOTAL_CLICKTHROUGH', 'TOTAL_IMPRESSION'];

export const isPinterestConfigured = () => Boolean(process.env.PINTEREST_AD_ACCOUNT_ID && (process.env.PINTEREST_ACCESS_TOKEN || process.env.PINTEREST_REFRESH_TOKEN));

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const micro = (v) => (Number(v) || 0) / 1e6;

// [start, end] partido en tramos que la API acepta
export function chunks(start, end, size = MAX_DAYS) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, size + 1)) {
    const e = addDays(s, size);
    out.push([s, e < end ? e : end]);
  }
  return out;
}

// Fila de la API → doc diario (montos en la moneda de la cuenta)
export function toDailyDoc(row) {
  return {
    date: String(row.DATE).slice(0, 10),
    spend: Math.round(micro(row.SPEND_IN_MICRO_DOLLAR) * 100) / 100,
    purchases: Number(row.TOTAL_CHECKOUT) || 0,
    purchaseValue: Math.round(micro(row.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR) * 100) / 100,
    clicks: Number(row.TOTAL_CLICKTHROUGH) || 0,
    impressions: Number(row.TOTAL_IMPRESSION) || 0,
  };
}

async function stateRef() {
  return getDb().collection(STATE_DOC[0]).doc(STATE_DOC[1]);
}

async function refreshToken(state) {
  const { PINTEREST_APP_ID: id, PINTEREST_APP_SECRET: secret } = process.env;
  const refresh = state.refreshToken || process.env.PINTEREST_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Pinterest no renovó el token: ${j.message || res.status}`);
  const next = {
    accessToken: j.access_token,
    expiresAt: Date.now() + (Number(j.expires_in) || 30 * 86400) * 1000,
    ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
  };
  await (await stateRef()).set(next, { merge: true });
  return next.accessToken;
}

async function accessToken() {
  const snap = await (await stateRef()).get();
  const state = snap.exists ? snap.data() : {};
  if (state.accessToken && state.expiresAt > Date.now() + 2 * 86400e3) return state.accessToken;
  const renewed = await refreshToken(state).catch((err) => { console.error('[pinterest]', err.message); return null; });
  return renewed || state.accessToken || process.env.PINTEREST_ACCESS_TOKEN;
}

async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pinterest ${res.status}: ${j.message || 'error'}`);
  return j;
}

export async function fetchDaily(start, end) {
  const token = await accessToken();
  const account = process.env.PINTEREST_AD_ACCOUNT_ID;
  const out = [];
  for (const [s, e] of chunks(start, end)) {
    const qs = new URLSearchParams({ start_date: s, end_date: e, granularity: 'DAY', columns: COLUMNS.join(',') });
    const rows = await apiGet(`/ad_accounts/${account}/analytics?${qs}`, token);
    for (const r of Array.isArray(rows) ? rows : []) out.push(toDailyDoc(r));
  }
  return out;
}

let running = null;

// Últimos `days` días (Pinterest ajusta conversiones hacia atrás). Días sin
// fila en la API se guardan en 0 para que un día sin gasto no quede viejo.
export function syncPinterestAds({ days = 35, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (running) return running;
  running = (async () => {
    const ref = await stateRef();
    const start = addDays(today, -days);
    try {
      const docs = await fetchDaily(start, today);
      const byDate = new Map(docs.map((d) => [d.date, d]));
      const db = getDb();
      const batch = db.batch();
      for (let d = start; d <= today; d = addDays(d, 1)) {
        const doc = byDate.get(d) || { date: d, spend: 0, purchases: 0, purchaseValue: 0, clicks: 0, impressions: 0 };
        batch.set(db.collection(PINTEREST_DAILY_COL).doc(d), { ...doc, updatedAt: new Date().toISOString() });
      }
      await batch.commit();
      const status = { lastRunAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), lastError: null, days: docs.length };
      await ref.set(status, { merge: true });
      return { ok: true, ...status };
    } catch (err) {
      await ref.set({ lastRunAt: new Date().toISOString(), lastError: err.message }, { merge: true });
      return { ok: false, error: err.message };
    }
  })().finally(() => { running = null; });
  return running;
}

export async function getPinterestStatus() {
  const snap = await (await stateRef()).get();
  const s = snap.exists ? snap.data() : {};
  return { configured: isPinterestConfigured(), connected: Boolean(s.lastOkAt), lastRunAt: s.lastRunAt || null, lastOkAt: s.lastOkAt || null, lastError: s.lastError || null };
}

export async function queryPinterestDaily(start, end) {
  const snap = await getDb().collection(PINTEREST_DAILY_COL).where('date', '>=', start).where('date', '<=', end).get();
  return snap.docs.map((d) => d.data());
}
