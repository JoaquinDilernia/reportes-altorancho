import { createServiceAccountToken } from './googleJwt.js';

// Cliente mínimo de la Google Ads API (REST v24) con cuenta de servicio, sin developer-token ni login-customer-id.
const BASE = 'https://googleads.googleapis.com/v24/';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const QUOTA_MSG = 'Se agotó la cuota diaria de la API de Google Ads (2.880 operaciones). Se reinicia a medianoche del Pacífico.';
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function googleCodeOf(error) {
  for (const d of error?.details || []) {
    for (const e of d?.errors || []) {
      const key = Object.keys(e?.errorCode || {})[0];
      if (key) return key;
    }
  }
  return undefined;
}

export function createGoogleAdsClient({ serviceAccountJson, customerId, fetchFn = fetch, sleep = defaultSleep, now = () => Date.now(), maxRetries = 3 }) {
  const cid = String(customerId).replace(/-/g, '');
  const token = createServiceAccountToken({ serviceAccountJson, scope: SCOPE, fetchFn, now, label: 'Google Ads' });

  async function reqOnce(path, body) {
    const res = await fetchFn(`${BASE}customers/${cid}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const e = json.error || {};
      const status = e.code || res.status;
      const err = new Error(`Google Ads ${status}: ${e.message || `HTTP ${res.status}`}`);
      err.status = status;
      err.statusText = e.status;
      err.googleCode = googleCodeOf(e);
      throw err;
    }
    return json;
  }

  async function req(path, body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await reqOnce(path, body);
      } catch (err) {
        const retryable = err.status === 429 || err.status === 503 || err.statusText === 'RESOURCE_EXHAUSTED';
        if (!retryable) throw err;
        if (attempt >= maxRetries) {
          if (err.googleCode === 'quotaError') {
            const q = new Error(QUOTA_MSG);
            q.status = err.status;
            q.googleCode = err.googleCode;
            throw q;
          }
          throw err;
        }
        await sleep(5000 * 2 ** attempt);
      }
    }
  }

  async function search(query) {
    const out = [];
    let pageToken;
    do {
      const json = await req('googleAds:search', { query, ...(pageToken ? { pageToken } : {}) });
      out.push(...(json.results || []));
      pageToken = json.nextPageToken;
    } while (pageToken);
    return out;
  }

  async function mutate(service, operations, { validateOnly = false } = {}) {
    const json = await req(`${service}:mutate`, { operations, ...(validateOnly ? { validateOnly: true } : {}) });
    return { ...json, results: json.results || [] };
  }

  async function createAsset(create) {
    const r = await mutate('assets', [{ create }]);
    return r.results[0].resourceName;
  }

  return {
    customerId: cid,
    resource: (type, id) => `customers/${cid}/${type}/${id}`,
    search,
    mutate,
    uploadImageAsset: (buffer, name) => createAsset({ name, type: 'IMAGE', imageAsset: { data: Buffer.from(buffer).toString('base64') } }),
    createYoutubeAsset: (youtubeId, name) => createAsset({ name, type: 'YOUTUBE_VIDEO', youtubeVideoAsset: { youtubeVideoId: youtubeId } }),
  };
}
