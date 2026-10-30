import { useEffect, useState } from 'react';

// Drops from the top, stays 3.5 s, slides back up and calls onDone.
// Mount it with a fresh `key` per message.
export default function CelebrationToast({ message, onDone }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShow(true));
    const hide = setTimeout(() => setShow(false), 3500);
    const done = setTimeout(() => onDone?.(), 3500 + 650);
    return () => { cancelAnimationFrame(raf); clearTimeout(hide); clearTimeout(done); };
  }, [onDone]);
  return (
    <div className={`ev-toast${show ? ' show' : ''}`} role="status" aria-live="polite">🎉 {message}</div>
  );
}
