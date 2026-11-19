import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Token OAuth de cuenta de servicio (JWT firmado, sin dependencias), cacheado hasta 60 s antes de vencer.
// Devuelve un getter asíncrono: `const getToken = createServiceAccountToken({...}); await getToken()`.
// `label` solo prefija el mensaje de error; nunca se incluye la clave en errores.
export function createServiceAccountToken({ serviceAccountJson, scope, fetchFn = fetch, now = () => Date.now(), label = 'Google' }) {
  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  let cached = null;
  return async function getToken() {
    if (cached && cached.expires > now() + 60_000) return cached.value;
    const iat = Math.floor(now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (!res.ok) throw new Error(`${label} token ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    cached = { value: json.access_token, expires: now() + json.expires_in * 1000 };
    return cached.value;
  };
}
