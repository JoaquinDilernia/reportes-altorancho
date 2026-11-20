import { useState } from 'react';

// Arma el link con UTMs que un vendedor manda por WhatsApp: así esa venta queda
// registrada como "Vendedor · <nombre>" en vez de "Directo".
export function sellerUrl(base, seller) {
  const name = String(seller || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!name) return null;
  let u;
  try {
    u = new URL(String(base || '').trim() || 'https://altorancho.com/');
  } catch {
    return null;
  }
  u.searchParams.set('utm_source', 'vendedor');
  u.searchParams.set('utm_medium', 'whatsapp');
  u.searchParams.set('utm_campaign', name);
  return u.toString();
}

export default function SellerLink() {
  const [base, setBase] = useState('');
  const [seller, setSeller] = useState('');
  const [copied, setCopied] = useState(false);
  const url = sellerUrl(base, seller);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* sin portapapeles: se copia a mano */ }
  };
  return (
    <div className="nv-vz-seller">
      <label>Link del producto (o vacío para la tienda)<input type="url" placeholder="https://altorancho.com/productos/..." value={base} onChange={(e) => setBase(e.target.value)} /></label>
      <label>Vendedor<input type="text" placeholder="Lucía" value={seller} onChange={(e) => setSeller(e.target.value)} /></label>
      {url ? (
        <div className="nv-vz-seller-out">
          <code>{url}</code>
          <button type="button" className="nv-btn" onClick={copy}>{copied ? 'copiado' : 'copiar'}</button>
        </div>
      ) : <p className="nv-mute">{seller ? 'El link no es válido.' : 'Escribí el nombre del vendedor.'}</p>}
    </div>
  );
}
