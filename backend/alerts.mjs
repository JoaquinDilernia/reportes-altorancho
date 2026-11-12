// The Resumen's "what needs attention" list: fixed rules over data the report
// already has, each with its number. Every input may be null (source not
// available) and its rules then stay quiet.
import { ALERTS } from './alertConfig.mjs';

const pctText = (x) => `${x < 0 ? '−' : '+'}${Math.round(Math.abs(x) * 100)}%`;
const fracPct = (f, digits = 2) => `${(f * 100).toLocaleString('es-AR', { maximumFractionDigits: digits })}%`;
const int = (n) => Math.round(n).toLocaleString('es-AR');
function money(n) {
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })} M`;
  if (Math.abs(n) >= 1e3) return `$${int(n / 1e3)} mil`;
  return `$${int(n)}`;
}
const change = (cur, base) => (base ? cur / base - 1 : null);

const BASELINE_LABEL = {
  week: (n) => `las últimas ${n} semanas`,
  month: (n) => `los últimos ${n} meses`,
  custom: (n) => `los ${n} períodos anteriores`,
};

function localAlerts(locales, period) {
  const n = ALERTS.localBaselinePeriods[period] ?? ALERTS.localBaselinePeriods.custom;
  const out = [];
  for (const l of locales || []) {
    const drop = change(l.revenue, l.baselineRevenue);
    if (drop == null || drop > -ALERTS.localDropPct) continue;
    const ordersChg = change(l.orders, l.baselineOrders);
    const ticketChg = change(l.avgTicket, l.baselineAvgTicket);
    const why = ordersChg != null && (ticketChg == null || ordersChg <= ticketChg)
      ? `Bajaron los tickets: ${int(l.orders)} contra ${int(l.baselineOrders)} habituales (${pctText(ordersChg)})`
      : `Bajó el ticket promedio: ${money(l.avgTicket)} contra ${money(l.baselineAvgTicket)} (${pctText(ticketChg ?? 0)})`;
    const other = why.startsWith('Bajaron') && ticketChg != null
      ? ` Ticket promedio ${money(l.avgTicket)} (${pctText(ticketChg)}).`
      : ordersChg != null ? ` Tickets ${int(l.orders)} (${pctText(ordersChg)}).` : '';
    out.push({
      drop, id: `local-${l.id}`, kind: 'local', tone: 'r', tab: 'locales',
      title: `${l.label} vendió ${Math.round(-drop * 100)}% menos que su promedio`,
      detail: `${money(l.revenue)} contra ${money(l.baselineRevenue)} de promedio en ${BASELINE_LABEL[period]?.(n) ?? BASELINE_LABEL.custom(n)}. ${why}.${other}`,
    });
  }
  // Biggest drop first.
  return out.sort((a, b) => a.drop - b.drop).map(({ drop, ...a }) => a);
}

function stockAlert(allRows) {
  const coverage = (allRows || []).filter(r => r.weeklyUnits >= ALERTS.coverageMinWeeklyUnits);
  if (!coverage.length) return [];
  const count = (g) => coverage.filter(r => r.group === g).length;
  const top = [...coverage].filter(r => r.group !== 'none').sort((a, b) => b.dailyRevenue - a.dailyRevenue)[0];
  const parts = [
    count('rolon') && `${count('rolon')} en Rolón (se pueden pasar a la web ya)`,
    count('local') && `${count('local')} solo en locales`,
    count('none') && `${count('none')} sin stock en ningún lado`,
  ].filter(Boolean);
  const n = coverage.length;
  return [{
    id: 'stock-coverage', kind: 'stock', tone: 'y', tab: 'producto',
    title: `${n} ${n === 1 ? 'producto que se venía vendiendo se queda' : 'productos que se venían vendiendo se quedan'} sin stock web en menos de ${ALERTS.coverageDays} días`,
    detail: `${parts.join(', ')}.${top ? ` El que más vende: ${top.name} (${money(top.dailyRevenue)} por día).` : ''}`,
  }];
}

function trafficAlert(behavior, days) {
  const min = (ALERTS.trafficMinViewsPerWeek * days) / 7;
  const it = behavior?.items?.lowConversion?.find(i => i.views >= min);
  if (!it) return [];
  return [{
    id: 'web-traffic', kind: 'web', tone: 'b', tab: 'web',
    title: `${it.name}: ${int(it.views)} vistas y ${int(it.purchases)} ${it.purchases === 1 ? 'venta' : 'ventas'}`,
    detail: `Compra el ${fracPct(it.buyRate ?? 0)} de los que lo ven. Revisar precio, fotos, stock o el anuncio que lleva ahí.`,
  }];
}

function sourceAlert(behavior) {
  const total = behavior?.totals?.cur;
  if (!total?.sessions || !total.conversion) return [];
  const bad = (behavior.channels || [])
    .filter(c => c.cur && c.cur.sessions / total.sessions >= ALERTS.sourceMinShare
      && (c.cur.conversion ?? 0) < total.conversion * ALERTS.sourceConvRatio)
    .sort((a, b) => b.cur.sessions - a.cur.sessions)[0];
  if (!bad) return [];
  return [{
    id: `web-source-${bad.key}`, kind: 'web', tone: 'b', tab: 'web',
    title: `${bad.key} trae el ${Math.round((bad.cur.sessions / total.sessions) * 100)}% de las visitas y convierte ${fracPct(bad.cur.conversion ?? 0)}`,
    detail: `El promedio de la web es ${fracPct(total.conversion)}. Es tráfico que casi no compra.`,
  }];
}

// Clarity daily snapshots of the range, pages merged across days.
function clarityAlert(snapshots) {
  if (!snapshots?.length) return [];
  const pages = new Map();
  for (const s of snapshots) {
    for (const p of s.pages || []) {
      const acc = pages.get(p.path) ?? { path: p.path, sessions: 0, rageS: 0, deadS: 0 };
      acc.sessions += p.sessions;
      acc.rageS += (p.rage || 0) * p.sessions / 100;
      acc.deadS += (p.dead || 0) * p.sessions / 100;
      pages.set(p.path, acc);
    }
  }
  const hit = [...pages.values()]
    .map(p => ({ ...p, rage: (p.rageS / p.sessions) * 100, dead: (p.deadS / p.sessions) * 100 }))
    .filter(p => p.sessions >= ALERTS.clarityMinSessions && (p.rage >= ALERTS.clarityRagePct || p.dead >= ALERTS.clarityDeadPct))
    .sort((a, b) => b.sessions - a.sessions)[0];
  if (!hit) return [];
  const what = hit.rage >= ALERTS.clarityRagePct
    ? `${Math.round(hit.rage)}% de las sesiones con clics repetidos de bronca`
    : `${Math.round(hit.dead)}% de las sesiones con clics que no hacen nada`;
  return [{
    id: `web-clarity-${hit.path}`, kind: 'web', tone: 'b', tab: 'web',
    title: `Clics de frustración en ${hit.path}`,
    detail: `${what} (${int(hit.sessions)} sesiones). Mirar las grabaciones en Clarity.`,
  }];
}

function originAlerts(origins) {
  const out = [];
  for (const o of origins || []) {
    if (o.id === 'otro') continue;
    const chg = change(o.cur?.revenue ?? 0, o.prev?.revenue ?? 0);
    if (chg == null || Math.abs(chg) < ALERTS.movePct) continue;
    const up = chg > 0;
    out.push({
      id: `origin-${o.id}`, kind: up ? 'bien' : 'producto', tone: up ? 'g' : 'b', tab: 'producto',
      title: `${o.label} ${pctText(chg)} contra el año pasado`,
      detail: `${money(o.cur.revenue)} contra ${money(o.prev.revenue)} (ajustado por inflación).`,
    });
  }
  return out;
}

export function buildAlerts({ period = 'week', days = 7, locales, coverage, behavior, clarity, origins }) {
  const originList = originAlerts(origins);
  const all = [
    ...localAlerts(locales, period),
    ...stockAlert(coverage),
    ...trafficAlert(behavior, days),
    ...sourceAlert(behavior),
    ...clarityAlert(clarity),
    ...originList.filter(a => a.kind === 'producto'),
    ...originList.filter(a => a.kind === 'bien'),
  ];
  if (all.length <= ALERTS.maxAlerts) return all;
  const cut = all.slice(0, ALERTS.maxAlerts);
  const good = all.find(a => a.kind === 'bien');
  if (good && !cut.includes(good)) cut[cut.length - 1] = good;
  return cut;
}
