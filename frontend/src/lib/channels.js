export const CHANNELS = [
  { id: 'ecommerce', label: 'Ecommerce', color: '#1BAF7A' },
  { id: 'local_lomas', label: 'Lomas', color: '#008300' },
  { id: 'local_belgrano', label: 'Belgrano', color: '#4A3AA7' },
  { id: 'local_alcorta', label: 'Alcorta', color: '#EB6834' },
  { id: 'mayorista', label: 'Mayorista', color: '#2A78D6' },
  { id: 'feria', label: 'Feria', color: '#0E9594' },
];

const CONSOLIDADO_COLOR = '#353434';

export function getChannelColor(channelId) {
  if (!channelId) return CONSOLIDADO_COLOR;
  const channel = CHANNELS.find(c => c.id === channelId);
  return channel ? channel.color : CONSOLIDADO_COLOR;
}

export function getChannelLabel(channelId) {
  if (!channelId) return 'Consolidado';
  const channel = CHANNELS.find(c => c.id === channelId);
  return channel ? channel.label : channelId;
}
