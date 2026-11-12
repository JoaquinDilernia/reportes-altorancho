import { useEffect, useRef, useState } from 'react';
import { searchProducts } from '../../api/client.js';

// Top-bar search: SKU or name (every word, accents ignored, server-side).
export default function ProductSearch({ onSelect }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      searchProducts(term)
        .then(r => { if (!cancelled) { setResults(r); setActive(r.length ? 0 : -1); } })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (r) => {
    onSelect(r.sku);
    setOpen(false);
    setQ('');
    setResults([]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => (a + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + results.length) % results.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(results[active]); }
  };

  const showList = open && q.trim().length >= 2;
  return (
    <div className="nv-search" ref={boxRef}>
      <input
        type="search"
        value={q}
        placeholder="Buscar producto o SKU…"
        aria-label="Buscar producto o SKU"
        role="combobox"
        aria-expanded={showList}
        aria-controls="nv-search-list"
        aria-activedescendant={showList && active >= 0 ? `nv-sr-${active}` : undefined}
        autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul className="nv-search-list" id="nv-search-list" role="listbox">
          {loading && !results.length && <li className="nv-search-msg">Buscando…</li>}
          {!loading && !results.length && <li className="nv-search-msg">Sin resultados</li>}
          {results.map((r, i) => (
            <li
              key={r.sku}
              id={`nv-sr-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(r); }}
            >
              <span className="nv-sr-name">{r.name}</span>
              <span className="nv-sr-meta">{r.sku}{r.category ? ` · ${r.category}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
