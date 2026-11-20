import { createServiceAccountToken } from './googleJwt.js';

// Cliente mínimo de la Google Analytics Data API con cuenta de servicio (JWT firmado, sin dependencias).
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

export function createGa4Client({ serviceAccountJson, propertyId, fetchFn = fetch, pageSize = 100000, now = () => Date.now() }) {
  const token = createServiceAccountToken({ serviceAccountJson, scope: SCOPE, fetchFn, now, label: 'GA4' });

  async function runReport(body) {
    const res = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GA4 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  return {
    runReport,
    // Pagina con offset/limit hasta traer todas las filas
    async runReportAll(body) {
      const rows = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await runReport({ ...body, offset, limit: pageSize });
        rows.push(...(page.rows || []));
        if (!page.rows || page.rows.length < pageSize || rows.length >= (page.rowCount || 0)) return rows;
      }
    },
  };
}
