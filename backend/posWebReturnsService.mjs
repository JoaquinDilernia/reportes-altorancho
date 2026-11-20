// Cambios y devoluciones web: transiciones de estado (Firestore) + pasos en
// Odoo. Cada acción reclama la solicitud (busy), hace lo suyo y la libera; si
// algo falla queda el error en odoo.error y el estado no cambia.
import { assertTransition, computeMoney } from './posWebReturns.mjs';
import { runApprovalSteps, runReceiveSteps, defaultWebReturnDeps } from './posWebReturnsOdoo.mjs';

export { defaultWebReturnDeps };

async function withClaim(id, action, user, deps, work) {
  const { request } = await deps.store.claimTransition(id, action, user);
  try {
    const { status, patch } = await work(request);
    return await deps.store.finishTransition(id, { status, patch, user, action });
  } catch (err) {
    await deps.store.failTransition(id, err);
    throw err;
  }
}

export function approve(id, user, deps = defaultWebReturnDeps()) {
  return withClaim(id, 'approve', user, deps, async (request) => {
    const money = {
      ...(request.money ?? {}),
      ...computeMoney({ kind: request.kind, returnLines: request.returnLines, newLines: request.newLines, shippingCharge: request.logistics?.shippingCharge }),
    };
    const settings = await deps.getSettings();
    const steps = await runApprovalSteps({ ...request, money }, settings, deps);
    return { status: assertTransition(request, 'approve'), patch: { money, odoo: { ...(request.odoo ?? {}), steps, error: null } } };
  });
}

export function receive(id, user, deps = defaultWebReturnDeps()) {
  return withClaim(id, 'receive', user, deps, async (request) => {
    const steps = await runReceiveSteps(request, deps);
    return { status: assertTransition(request, 'receive'), patch: { odoo: { ...(request.odoo ?? {}), steps, error: null } } };
  });
}

// Solo cambian el estado (con las mismas reglas de busy y transición).
const simple = (action, patchOf) => (id, user, deps) =>
  withClaim(id, action, user, deps, async (request) => ({ status: assertTransition(request, action), patch: patchOf(request) }));

export function reject(id, user, reason, deps = defaultWebReturnDeps()) {
  const text = String(reason ?? '').trim();
  if (!text) return Promise.reject(new Error('Escribí el motivo del rechazo'));
  return simple('reject', () => ({ rejectReason: text }))(id, user, deps);
}

export function derive(id, user, localId, deps = defaultWebReturnDeps()) {
  const local = String(localId ?? '').trim();
  if (!local) return Promise.reject(new Error('Elegí el local'));
  return simple('derive', (r) => ({ logistics: { ...(r.logistics ?? {}), mode: 'derivado_local', derivedLocalId: local } }))(id, user, deps);
}

export function refundDone(id, user, note, deps = defaultWebReturnDeps()) {
  return simple('refundDone', (r) => ({
    money: { ...(r.money ?? {}), refundDoneAt: new Date().toISOString(), refundDoneBy: user, refundNote: note ?? null },
  }))(id, user, deps);
}

export function close(id, user, deps = defaultWebReturnDeps()) {
  return simple('close', () => ({}))(id, user, deps);
}
