// The AI always replies in plain text with "- " bullet lines (see
// backend/insights.mjs's system prompt) rather than markdown, so this is a
// tiny formatter for that one shape instead of pulling in a markdown parser.
export default function FormattedText({ text }) {
  const lines = text.split('\n').filter((line) => line.trim() !== '');

  return (
    <div className="formatted-text">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
          return (
            <div className="formatted-bullet" key={i}>
              <span className="formatted-bullet-marker" />
              <span>{trimmed.slice(2)}</span>
            </div>
          );
        }
        return <p className="formatted-paragraph" key={i}>{trimmed}</p>;
      })}
    </div>
  );
}
