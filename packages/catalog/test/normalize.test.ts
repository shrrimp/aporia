import { describe, expect, it } from 'vitest';
import { normalizeLesson, validateLesson } from '../src/index.ts';
import { fourNumbers } from '../fixtures/four-numbers.ts';

/** The golden lesson with every discriminator swapped the way models get it wrong. */
function swapped(): unknown {
  const l = structuredClone(fourNumbers) as unknown as { sections: { blocks: Record<string, unknown>[] }[] };
  for (const s of l.sections) {
    s.blocks = s.blocks.map((b) => {
      const { type, ...rest } = b;
      const out: Record<string, unknown> = type === 'code' ? b : { kind: type, ...rest };
      if (Array.isArray(out['items'])) out['items'] = (out['items'] as Record<string, unknown>[]).map(({ kind, ...r }) => ({ type: kind, ...r }));
      if (Array.isArray(out['controls'])) out['controls'] = (out['controls'] as Record<string, unknown>[]).map(({ kind, ...r }) => ({ type: kind, ...r }));
      const view = out['view'] as Record<string, unknown> | undefined;
      if (view) {
        const { type: vt, ...vr } = view;
        out['view'] = { kind: vt, ...vr, elements: (view['elements'] as Record<string, unknown>[]).map(({ kind, ...r }) => ({ type: kind, ...r })) };
      }
      return out;
    });
  }
  return l;
}

describe('normalizeLesson', () => {
  it('accepts type/kind mix-ups everywhere and yields the canonical lesson (regression: two wasted drafts)', () => {
    const r = validateLesson(swapped());
    expect(r.errors).toEqual([]);
    expect(normalizeLesson(swapped())).toEqual(fourNumbers);
  });

  it('leaves code blocks, unknown values and non-lessons alone', () => {
    expect(normalizeLesson(null)).toBeNull();
    expect(normalizeLesson({ sections: 'x' })).toEqual({ sections: 'x' });
    expect(normalizeLesson({ sections: [1, { blocks: [2, { kind: 'stub', type: 'code' }, { kind: 'mystery' }] }] })).toEqual({
      sections: [1, { blocks: [2, { kind: 'stub', type: 'code' }, { kind: 'mystery' }] }],
    });
  });

  it('explains which field names a thing when validation still fails', () => {
    const bad = structuredClone(fourNumbers) as unknown as { sections: { blocks: Record<string, unknown>[] }[] };
    bad.sections[0]!.blocks[0] = { type: 'quiz' };
    bad.sections[1]!.blocks[2] = { ...(bad.sections[1]!.blocks[2] as object), controls: [{ kind: 'knob' }] };
    const messages = validateLesson(bad).errors.map((e) => e.message).join('\n');
    expect(messages).toMatch(/Blocks say what they are with "type"/);
    expect(messages).toMatch(/explorable controls and drill items use "kind"/);
  });
});
