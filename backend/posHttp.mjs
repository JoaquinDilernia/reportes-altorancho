// Utilidades HTTP compartidas por las rutas /api/pos: los errores salen como { error }.
export const httpError = (message, status) => Object.assign(new Error(message), { status });

export function statusOf(err) {
  if (err.status) return err.status;
  if (err.stage === 'claim') return 409;
  if (err.stage === 'odoo' || err.stage === 'post') return 502;
  if (/ no encontrad[oa]$/.test(err.message ?? '')) return 404;
  if (String(err.message ?? '').startsWith('Odoo RPC error')) return 502;
  if (['TypeError', 'AbortError', 'TimeoutError'].includes(err.name)) return 502;
  return 400;
}

export const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    const status = statusOf(err);
    if (status >= 500) console.error('[pos]', req.method, req.path, err.message);
    res.status(status).json({ error: err.message });
  }
};

export const validId = (pattern, label) => (req, res, next) => {
  if (!pattern.test(req.params.id)) return res.status(400).json({ error: `${label} inválido` });
  return next();
};
