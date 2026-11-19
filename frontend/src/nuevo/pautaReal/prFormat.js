// Textos del tablero de Pauta: pensados para alguien que no vive en Ads Manager.
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 4,2x
export function times(v) {
  return isNum(v) ? `${v.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x` : '—';
}

// "Por cada $1 → $4,20"
export function perPeso(v) {
  return isNum(v) ? `$${v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
}

export const VERDICT = {
  gana: { label: 'Deja plata', tone: 'up', hint: 'La ganancia de sus ventas paga la pauta y sobra (POAS 1,3 o más).' },
  justo: { label: 'Empata', tone: 'warn', hint: 'La ganancia apenas cubre lo invertido (POAS entre 1 y 1,3).' },
  pierde: { label: 'Pierde plata', tone: 'dn', hint: 'La ganancia de sus ventas no alcanza a pagar lo invertido (POAS menor a 1).' },
  'sin-ventas': { label: 'Sin ventas', tone: 'dn', hint: 'Gastó y no llegó ninguna venta a la tienda con su clic.' },
  'sin-dato': { label: 'Sin dato', tone: 'nt', hint: 'No hay ventas con el ID de esta campaña, pero hay ventas de la plataforma sin campaña identificada que pueden ser suyas.' },
};

export const SOURCE_LABEL = {
  meta: 'Meta (Facebook / Instagram)',
  google: 'Google',
  pinterest: 'Pinterest',
  organic: 'Orgánico / directo',
  social_organic: 'Redes sin pauta',
  email: 'Email',
  other: 'Otros links',
  unknown: 'Sin datos de origen',
  resto: 'Orgánico y otros',
};
export const SOURCE_COLOR = {
  meta: '#1877F2', google: '#EA4335', pinterest: '#B5176E', organic: '#1BAF7A', social_organic: '#8E5BD8',
  email: '#E0A100', other: '#9a9897', unknown: '#d4d3d2', resto: '#1BAF7A',
};
