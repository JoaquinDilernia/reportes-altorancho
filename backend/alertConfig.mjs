// Thresholds for the Resumen's rule-based alerts. Tune here, not in alerts.mjs.
export const ALERTS = {
  maxAlerts: 6,
  // A store selling this much less than its own recent average.
  localDropPct: 0.15,
  // How many previous periods make up that average.
  localBaselinePeriods: { week: 8, month: 3, custom: 8 },
  // Web stock that lasts fewer days than this at the current pace.
  coverageDays: 7,
  // A product needs this many views per week before "few sales" means anything.
  trafficMinViewsPerWeek: 2000,
  // A traffic source with at least this share of sessions…
  sourceMinShare: 0.10,
  // …converting below this fraction of the site's average.
  sourceConvRatio: 1 / 3,
  // Clarity: a page needs this many sessions in the range, and rage/dead
  // clicks on at least this % of them.
  clarityMinSessions: 200,
  clarityRagePct: 5,
  clarityDeadPct: 20,
  // A product origin (fábrica/importado/nacional) moving this much vs. last year.
  movePct: 0.20,
};
