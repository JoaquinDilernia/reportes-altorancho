import { groupView } from './eventLive.js';

// The big full-screen celebration: the event's TOTAL (web + locales) target,
// whatever view is selected.
export function goalStatus(data) {
  const v = groupView(data, 'total');
  const passed = v.target > 0 && v.revenue >= v.target;
  return { passed, revenue: v.revenue, target: v.target, overPct: v.target > 0 ? (v.revenue / v.target - 1) * 100 : null };
}

// Once per browser per event: everyone sees it the first time they open the
// tab after the target is passed. Blocked storage means it shows again.
const key = (eventId, year) => `altorancho_festejo_${eventId}_${year}`;

export function wasCelebrated(storage, eventId, year) {
  try { return storage?.getItem(key(eventId, year)) === '1'; } catch { return false; }
}

export function markCelebrated(storage, eventId, year) {
  try { storage?.setItem(key(eventId, year), '1'); } catch { /* storage blocked */ }
}

// ?festejo=1 shows it on demand (to try it, or to show it again in a meeting).
export function forcedByUrl(search) {
  return new URLSearchParams(search).get('festejo') === '1';
}
