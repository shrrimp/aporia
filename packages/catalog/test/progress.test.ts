import { describe, expect, it } from 'vitest';
import { blockKey, itemKey, lesson, lessonCompletion, lessonUnits, taskKey } from '../src/index.ts';
import { fourNumbers as raw } from '../fixtures/four-numbers.ts';

const fourNumbers = lesson.parse(raw);

describe('lesson units', () => {
  it('lists every drill item, task, reveal, explain-back and predict-first explorable once', () => {
    const units = lessonUnits(fourNumbers);
    const expected: string[] = [];
    fourNumbers.sections.forEach((s) =>
      s.blocks.forEach((b, bi) => {
        if (b.type === 'drill') expected.push(...b.items.map((i) => itemKey(i.id)));
        if (b.type === 'task') expected.push(taskKey(b.id));
        if (['predict', 'think-first', 'explain-back'].includes(b.type)) expected.push(blockKey(`${s.id}/${bi}`));
        if (b.type === 'explorable' && b.predictFirst) expected.push(blockKey(`${s.id}/${bi}`));
      }),
    );
    expect(units).toEqual(expected);
    expect(new Set(units).size).toBe(units.length);
    expect(units.some((u) => u.startsWith('task:'))).toBe(true);
    expect(units.some((u) => u.startsWith('block:'))).toBe(true);
  });

  it('counts a unit done once it has a non-null value; unknown keys do not count', () => {
    const [a, b] = lessonUnits(fourNumbers);
    expect(lessonCompletion(fourNumbers, {})).toEqual({ done: 0, total: lessonUnits(fourNumbers).length });
    expect(lessonCompletion(fourNumbers, { [a!]: { result: 1 }, [b!]: null, 'item:gone': 1, position: 'x' }).done).toBe(1);
  });
});
