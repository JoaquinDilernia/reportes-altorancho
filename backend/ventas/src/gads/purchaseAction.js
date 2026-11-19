// Acción de conversión que cuenta como "compra" para el agente de Google.
const Q_ACTIONS = `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.category, conversion_action.primary_for_goal, conversion_action.status
FROM conversion_action
WHERE conversion_action.status = 'ENABLED'`;

export async function listConversionActions(gads) {
  const rows = await gads.search(Q_ACTIONS);
  return rows
    .map((r) => r.conversionAction || {})
    .filter((a) => a.status === 'ENABLED')
    .map((a) => ({ resourceName: a.resourceName, name: a.name, category: a.category, primary: a.primaryForGoal === true }));
}

// El ajuste puede ser el resource name completo o solo el id numérico
function settingResourceName(gads, value) {
  const v = String(value).trim();
  return /^\d+$/.test(v) ? gads.resource('conversionActions', v) : v;
}

// Ajuste explícito → esa. Si no: primera PURCHASE primaria; si no, la primera PURCHASE; si no, null.
// Si el ajuste apunta a una acción que no está activa, se vuelve a la elección automática con overrideMissing: true
// (no se cuentan 0 compras en silencio).
export async function resolvePurchaseAction(gads, settings = {}) {
  const actions = await listConversionActions(gads);
  let overrideMissing = false;
  if (settings?.purchase_action) {
    const resourceName = settingResourceName(gads, settings.purchase_action);
    const found = actions.find((a) => a.resourceName === resourceName);
    if (found) return { resourceName, name: found.name, auto: false };
    overrideMissing = true;
  }
  const purchases = actions.filter((a) => a.category === 'PURCHASE');
  const chosen = purchases.find((a) => a.primary) || purchases[0];
  if (!chosen) return null;
  return { resourceName: chosen.resourceName, name: chosen.name, auto: true, ...(overrideMissing ? { overrideMissing: true } : {}) };
}
