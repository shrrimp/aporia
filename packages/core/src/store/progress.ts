import { deepEqual, type JsonValue } from '../changes/json-patch.ts';
import type { Author, LogEvent, ProgressEvent } from './schemas.ts';
import type { Journal } from './journal.ts';

export type LessonProgress = Readonly<Record<string, JsonValue>>;

/** Latest value per key for one lesson (pure fold, in log order). */
export function lessonProgress(events: readonly LogEvent[], projectId: string, lessonId: string): LessonProgress {
  const out: Record<string, JsonValue> = {};
  for (const e of events) {
    if (e.type === 'progress' && e.projectId === projectId && e.lessonId === lessonId) out[e.key] = e.value;
  }
  return out;
}

/** Progress of every lesson in a project, keyed by lesson id. */
export function projectProgress(events: readonly LogEvent[], projectId: string): Readonly<Record<string, LessonProgress>> {
  const out: Record<string, Record<string, JsonValue>> = {};
  for (const e of events) {
    if (e.type === 'progress' && e.projectId === projectId) (out[e.lessonId] ??= {})[e.key] = e.value;
  }
  return out;
}

/** Records progress; a value identical to the current one is not written again. */
export class Progress {
  readonly journal: Journal;
  constructor(journal: Journal) {
    this.journal = journal;
  }

  set(author: Author, projectId: string, lessonId: string, key: string, value: JsonValue): Promise<ProgressEvent | undefined> {
    return this.journal.exclusive(async () => {
      const current = lessonProgress(this.journal.events, projectId, lessonId)[key];
      if (current !== undefined && deepEqual(current, value)) return undefined;
      return (await this.journal.append({ type: 'progress', author, projectId, lessonId, key, value })) as ProgressEvent;
    });
  }
}
