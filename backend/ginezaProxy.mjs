// /api/gz/* → backend de gineza /api/*. Con el token de Reportes adelante y la
// contraseña de gineza atrás (nunca llega al navegador). Va montado ANTES de
// express.json(): el cuerpo se reenvía crudo (JSON, FormData o un video).
import express from 'express';
import { requireAuth } from './auth.mjs';
import { ginezaBaseUrl, isGinezaConfigured, ginezaAuthHeader } from './gineza.mjs';

const FORWARD_HEADERS = ['content-type', 'x-file-name', 'accept'];
const MAX_BODY = '600mb';

const router = express.Router();

router.use(requireAuth);
router.use(express.raw({ type: () => true, limit: MAX_BODY }));

router.all('*', async (req, res) => {
  if (!isGinezaConfigured()) return res.status(503).json({ error: 'El agente no está conectado (falta GINEZA_PASSWORD)' });
  const headers = { Authorization: ginezaAuthHeader() };
  for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
  try {
    const upstream = await fetch(`${ginezaBaseUrl()}/api${req.url}`, {
      method: req.method,
      headers,
      ...(hasBody ? { body: req.body } : {}),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    // 401 de gineza = contraseña mal configurada, no la sesión del usuario: no lo deslogueamos.
    const status = upstream.status === 401 ? 502 : upstream.status;
    res.status(status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error('[gz proxy]', req.method, req.url.split('?')[0], err.message);
    res.status(502).json({ error: 'El agente no respondió, probá en un rato' });
  }
});

export default router;
