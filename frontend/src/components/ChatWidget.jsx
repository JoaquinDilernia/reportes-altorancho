import { useState, useRef, useEffect } from 'react';
import { chatInsights } from '../api/client.js';

// Rendered once at the top level (Dashboard), not per-tab — its state
// (messages, open/closed) must survive switching between Consolidado/
// Ecommerce/Meta Ads/etc. Always analyzes whatever period/channel is
// currently selected, resolved fresh on every send.
export default function ChatWidget({ period, date, customStart, customEnd, channel }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, loading]);

  async function handleSend() {
    const question = input.trim();
    if (!question || loading) return;

    const nextMessages = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const params = period === 'custom'
        ? { period, start: customStart, end: customEnd, channel }
        : { period, date, channel };
      const reply = await chatInsights({ ...params, messages: nextMessages });
      setMessages([...nextMessages, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button className="chat-fab" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Cerrar chat' : 'Abrir chat'}>
        {open ? '✕' : '💬'}
      </button>
      {open && (
        <div className="chat-panel">
          <div className="chat-header">Preguntale a la IA</div>
          <div className="chat-messages">
            {messages.length === 0 && (
              <p className="chat-empty">Preguntá lo que quieras del reporte — ventas, Meta Ads, cualquier período o canal.</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-message chat-message-${m.role}`}>{m.content}</div>
            ))}
            {loading && <div className="chat-message chat-message-assistant">Pensando…</div>}
            <div ref={bottomRef} />
          </div>
          {error && <p className="status-text status-error">Error: {error}</p>}
          <div className="chat-input-row">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
              placeholder="Escribí tu pregunta…"
              disabled={loading}
            />
            <button onClick={handleSend} disabled={loading || !input.trim()}>Enviar</button>
          </div>
        </div>
      )}
    </>
  );
}
