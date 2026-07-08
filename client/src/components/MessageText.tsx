import { linkifyText } from '../lib/link-detect';

interface Props {
  text: string;
}

export function MessageText({ text }: Props) {
  const parts = linkifyText(text);
  return (
    <p className="message-text">
      {parts.map((part, index) =>
        part.type === 'link' ? (
          <a
            key={`${part.value}-${index}`}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer"
            className="message-link"
          >
            {part.value}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </p>
  );
}
