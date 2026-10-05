import { splitEmphasis } from './emphasis.ts';

/** A headline whose closing phrase is set in the italic serif (the signature treatment). */
export function Headline({ text, level = 1 }: { text: string; level?: 1 | 2 }) {
  const [lead, tail] = splitEmphasis(text);
  const Tag = level === 1 ? 'h1' : 'h2';
  return (
    <Tag className="headline">
      {lead}
      <em className="hl">{tail}</em>
    </Tag>
  );
}
