// Official INDEC Índice de Precios al Consumidor (Nivel General, base
// diciembre 2016), served through Argentina's official open-data time-series
// API (datos.gob.ar) — verified live against the real endpoint. One index
// value per month; INDEC publishes with a ~6-week lag, so the most recent
// 1-2 months may not exist yet.
const INDEC_IPC_SERIES_ID = '148.3_INIVELNAL_DICI_M_26';
const API_URL = `https://apis.datos.gob.ar/series/api/series/?ids=${INDEC_IPC_SERIES_ID}&format=json&limit=5000`;

export async function fetchInflationIndex() {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`INDEC inflation API error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data.map(([date, index]) => ({ month: date.slice(0, 7), index }));
}
