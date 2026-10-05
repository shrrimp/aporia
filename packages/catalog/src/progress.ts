import type { Lesson } from './schema.ts';

/**
 * The things in a lesson the learner does, each with the progress key it is saved under. A unit
 * counts as done once its key holds a non-null value. Shared by the app (to save and restore)
 * and the server (to report how far each lesson got), so both count the same way.
 */
export function lessonUnits(lesson: Lesson): string[] {
  const keys: string[] = [];
  lesson.sections.forEach((s) =>
    s.blocks.forEach((b, bi) => {
      if (b.type === 'drill') keys.push(...b.items.map((i) => itemKey(i.id)));
      else if (b.type === 'task') keys.push(taskKey(b.id));
      else if (b.type === 'predict' || b.type === 'think-first' || b.type === 'explain-back' || (b.type === 'explorable' && b.predictFirst !== undefined))
        keys.push(blockKey(`${s.id}/${bi}`));
    }),
  );
  return keys;
}

export const itemKey = (id: string) => `item:${id}`;
export const taskKey = (id: string) => `task:${id}`;
export const blockKey = (anchor: string) => `block:${anchor}`;
/** Where the learner was reading: a section id. Not a unit. */
export const POSITION_KEY = 'position';

export function lessonCompletion(lesson: Lesson, progress: Readonly<Record<string, unknown>>): { done: number; total: number } {
  const units = lessonUnits(lesson);
  return { done: units.filter((k) => progress[k] !== undefined && progress[k] !== null).length, total: units.length };
}
