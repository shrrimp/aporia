import { lesson as lessonSchema, normalizeLesson, type DrillItem, type Lesson } from '@app/catalog';
import type { ChangeService, OpenProfile } from '@app/core';
import { lessonsDir } from './paths.ts';

/** Ids of the project's lessons (applied, so a draft waiting for review is not one yet), in id order. */
export function lessonIds(changes: ChangeService, projectId: string): string[] {
  const prefix = `${lessonsDir(projectId)}/`;
  return [...new Set(changes.list({ status: 'applied' }).map((c) => c.target))]
    .filter((t) => t.startsWith(prefix) && t.endsWith('.json'))
    .map((t) => t.slice(prefix.length, -'.json'.length))
    .sort();
}

/** The project's lessons that can be read (one that no longer matches the catalog is skipped, never shown broken). */
export async function projectLessons(profile: Pick<OpenProfile, 'changes'>, projectId: string): Promise<Lesson[]> {
  const out: Lesson[] = [];
  for (const id of lessonIds(profile.changes, projectId)) {
    const parsed = lessonSchema.safeParse(normalizeLesson(await profile.changes.read(`${lessonsDir(projectId)}/${id}.json`)));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export interface ReviewItem {
  readonly lessonId: string;
  readonly lessonTitle: string;
  readonly item: DrillItem;
}

/**
 * Drill items the app can score on its own, keyed like their evidence (`lesson/item`): what a
 * review falls back on until the bank has questions on a skill. Short answers need the tutor, so
 * they are left out.
 */
export function reviewableItems(lessons: readonly Lesson[]): Map<string, ReviewItem> {
  const out = new Map<string, ReviewItem>();
  for (const l of lessons) {
    for (const s of l.sections) {
      for (const b of s.blocks) {
        if (b.type !== 'drill') continue;
        // A warm-up copy (reviewOf) is answered on the original's schedule, so only the original is listed.
        for (const item of b.items) if (item.kind !== 'short' && !item.reviewOf) out.set(`${l.id}/${item.id}`, { lessonId: l.id, lessonTitle: l.title, item });
      }
    }
  }
  return out;
}
