import { chShort, chColor } from './vFormat.js';

export default function ChannelChip({ channel, long }) {
  if (!channel) return <span className="nv-mute">—</span>;
  return (
    <span className="nv-v-ch"><span className="nv-dot" style={{ background: chColor(channel) }} />{long || chShort(channel)}</span>
  );
}
