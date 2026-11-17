// Which event tab to show: an event is shown from `leadDays` before it starts
// (to plan it) through the day after it ends. The earliest match wins, so a
// running event keeps the tab until its day-after, then the next one takes it.
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function pickEvent(windows, today, { leadDays = 21 } = {}) {
  const match = (windows || [])
    .filter(w => w?.start && w?.end && addDays(w.start, -leadDays) <= today && today <= addDays(w.end, 1))
    .sort((a, b) => a.start.localeCompare(b.start));
  return match[0] ?? null;
}
