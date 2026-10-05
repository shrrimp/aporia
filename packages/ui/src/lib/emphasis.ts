/**
 * The signature headline treatment: the closing phrase of a title is set in the italic serif.
 * "Four Numbers, Three Speeds" → ["Four Numbers, ", "Three Speeds"];
 * "Why unit quaternions represent rotations" → ["Why unit quaternions represent ", "rotations"].
 */
export function splitEmphasis(title: string): [string, string] {
  const t = title.trim();
  const cut = Math.max(t.lastIndexOf(', '), t.lastIndexOf(': '), t.lastIndexOf(' — '), t.lastIndexOf(' - '));
  if (cut > 0) {
    const sep = t.slice(cut).match(/^(, |: | — | - )/)![0];
    const tail = t.slice(cut + sep.length);
    if (tail.split(/\s+/).length <= 4) return [t.slice(0, cut + sep.length), tail];
  }
  const space = t.lastIndexOf(' ');
  return space > 0 ? [t.slice(0, space + 1), t.slice(space + 1)] : ['', t];
}
