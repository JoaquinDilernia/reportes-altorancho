import { CHANNELS } from '../lib/channels.js';

export default function ChannelTabs({ channel, onChannelChange }) {
  return (
    <div className="channel-tabs">
      <button
        className={`channel-tab ${channel === null ? 'active' : ''}`}
        style={channel === null ? { '--tab-color': '#353434' } : undefined}
        onClick={() => onChannelChange(null)}
      >
        Consolidado
      </button>
      {CHANNELS.map((c) => (
        <button
          key={c.id}
          className={`channel-tab ${channel === c.id ? 'active' : ''}`}
          style={channel === c.id ? { '--tab-color': c.color } : undefined}
          onClick={() => onChannelChange(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
