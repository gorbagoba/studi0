import { CITATION_RE } from '@studi0/shared';

/** Renders message text, turning inline 【citation】 markers into chips. */
export function CitationText({ text }: { text: string }) {
  const parts = text.split(CITATION_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="citation">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
