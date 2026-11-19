// Fechas comerciales de Argentina que mueven la pauta. Se actualizan a mano cuando CACE anuncia las nuevas
// (CyberMonday y Hot Sale). Sin fecha confirmada: solo el mes (month 'YYYY-MM').
export const COMMERCIAL_EVENTS = [
  { name: 'CyberMonday (CACE)', from: '2026-11-02', to: '2026-11-04', notes: 'Evento oficial de CACE: participan solo las empresas inscriptas.' },
  { name: 'Black Friday', from: '2026-11-27', to: '2026-11-29', notes: 'Viernes 27 más el fin de semana; muchas marcas lo estiran hasta el Cyber Monday global (lunes 30).' },
  { name: 'Cyber Monday global', from: '2026-11-30', to: '2026-11-30', notes: 'El lunes después del Black Friday; no es el CyberMonday de CACE.' },
  { name: 'Hot Sale (CACE)', month: '2027-05', notes: 'Fecha a confirmar: CACE la anuncia unos meses antes (suele ser a mediados de mayo).' },
];

const LEAD_DAYS = 45; // cuánto antes empieza a aparecer
const AFTER_DAYS = 14; // después del evento sigue apareciendo: la semana del evento no se compara con una común
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// Lo que le llega al agente: eventos próximos, en curso o recién terminados, con la fase y los días que faltan
export function commercialCalendarFor(today, events = COMMERCIAL_EVENTS) {
  const out = [];
  for (const e of events) {
    if (!e.from) {
      // Sin fecha: aparece cuando falta poco para el mes, para que el agente pregunte si ya está confirmada
      const first = `${e.month}-01`;
      const until = daysBetween(today, first);
      if (until <= LEAD_DAYS + 30 && daysBetween(first, today) < 31) out.push({ name: e.name, month: e.month, phase: 'sin fecha confirmada', notes: e.notes });
      continue;
    }
    const until = daysBetween(today, e.from);
    const since = daysBetween(e.to, today);
    let phase = null;
    if (until > 0 && until <= LEAD_DAYS) phase = 'antes';
    else if (until <= 0 && since <= 0) phase = 'en curso';
    else if (since > 0 && since <= AFTER_DAYS) phase = 'después';
    if (phase) out.push({ name: e.name, from: e.from, to: e.to, phase, daysUntil: Math.max(0, until), notes: e.notes });
  }
  return out;
}
