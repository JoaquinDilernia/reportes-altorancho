import 'dotenv/config';

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;
const ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;

// Splits [since, until] into consecutive windows of at most maxDays each, so
// a single Insights API call never spans an unbounded date range (Meta's
// practical limit for time_increment=1 queries is well under a year).
export function chunkDateRange(since, until, maxDays = 90) {
  const chunks = [];
  const end = new Date(`${until}T00:00:00Z`);
  let start = new Date(`${since}T00:00:00Z`);

  while (start <= end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({
      since: start.toISOString().slice(0, 10),
      until: chunkEnd.toISOString().slice(0, 10),
    });

    start = new Date(chunkEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }

  return chunks;
}

// Meta's `actions`/`action_values` fields are arrays of { action_type, value }
// instead of flat fields; this pulls one metric out by its action_type,
// defaulting to 0 when the array is missing (no activity that day/ad) or the
// action_type didn't occur.
export function extractActionValue(actions, actionType) {
  if (!actions) return 0;
  const match = actions.find(a => a.action_type === actionType);
  return match ? Number(match.value) : 0;
}
