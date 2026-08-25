import { useState, useEffect } from 'react';
import { analyzeReport } from '../api/client.js';

export default function InsightsButton({ period, date, customStart, customEnd, channel }) {
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);

  // Clear a stale analysis when the user moves to a different period/tab —
  // otherwise the old text keeps showing over data it no longer describes.
  useEffect(() => {
    setText(null);
    setError(null);
  }, [period, date, customStart, customEnd, channel]);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const params = period === 'custom'
        ? { period, start: customStart, end: customEnd, channel }
        : { period, date, channel };
      setText(await analyzeReport(params));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="insights-block">
      <button className="insights-button" onClick={handleClick} disabled={loading}>
        {loading ? 'Analizando…' : '✨ Analizar con IA'}
      </button>
      {error && <p className="status-text status-error">Error: {error}</p>}
      {text && (
        <div className="insights-card">
          <h3 className="chart-title">Análisis</h3>
          <div className="insights-text">{text}</div>
        </div>
      )}
    </div>
  );
}
