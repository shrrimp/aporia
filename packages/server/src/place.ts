import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Mutex, resolveInside, writeJsonAtomic } from '@app/core';
import { placeSchema, type Place } from './protocol.ts';

/**
 * Where the learner was in the app (profile, project, page, lesson, panel, open file), so a
 * restart or a crash brings them back to it. App-wide, in the data folder: it is not learning
 * data and is never journaled. Written whole and atomically; an unreadable file is an empty place.
 */
export class PlaceStore {
  readonly #file: string;
  readonly #lock = new Mutex();
  #cache: Place | undefined;

  constructor(dataRoot: string) {
    this.#file = path.join(dataRoot, 'place.json');
  }

  async get(): Promise<Place> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = placeSchema.safeParse(JSON.parse(await readFile(this.#file, 'utf8')));
      this.#cache = parsed.success ? parsed.data : {};
    } catch {
      this.#cache = {};
    }
    return this.#cache;
  }

  /** Merge: a key set to null is cleared, a key left out is kept. */
  set(change: { readonly [K in keyof Place]?: Place[K] | null }): Promise<Place> {
    return this.#lock.run(async () => {
      const next: Record<string, unknown> = { ...(await this.get()) };
      for (const [k, v] of Object.entries(change)) {
        if (v === null) delete next[k];
        else if (v !== undefined) next[k] = v;
      }
      const place = placeSchema.parse(next);
      if (JSON.stringify(place) !== JSON.stringify(this.#cache)) await writeJsonAtomic(this.#file, place);
      this.#cache = place;
      return place;
    });
  }
}

const draft = z.strictObject({
  path: z.string(),
  content: z.string(),
  /** The version on disk the edits started from (absent for a file not created yet). */
  baseVersion: z.string().optional(),
  at: z.string(),
});
export type Draft = z.output<typeof draft>;

/**
 * Unsaved text in the embedded editor, kept in the profile until it is saved or discarded: a
 * crash or restart must not lose what the learner typed. One file per path, written atomically.
 * Never written to the learner's workspace: saving stays an explicit act.
 */
export class Drafts {
  readonly #profileDir: string;
  readonly #lock = new Mutex();

  constructor(profileDir: string) {
    this.#profileDir = profileDir;
  }

  #dir(projectId: string): string {
    return resolveInside(this.#profileDir, 'projects', projectId, 'editor-drafts');
  }

  #file(projectId: string, file: string): string {
    return path.join(this.#dir(projectId), `${createHash('sha256').update(file).digest('hex').slice(0, 32)}.json`);
  }

  async list(projectId: string): Promise<Draft[]> {
    await this.#lock.run(async () => undefined); // after pending writes
    let names: string[];
    try {
      names = await readdir(this.#dir(projectId));
    } catch {
      return [];
    }
    const out: Draft[] = [];
    for (const n of names.filter((n) => n.endsWith('.json')).sort()) {
      try {
        const parsed = draft.safeParse(JSON.parse(await readFile(path.join(this.#dir(projectId), n), 'utf8')));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // an unreadable draft is skipped, never fatal
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Keep `content` as the unsaved text of `file`; null forgets it (saved or discarded). */
  set(projectId: string, file: string, content: string | null, baseVersion: string | undefined, at: string): Promise<void> {
    const target = this.#file(projectId, file);
    return this.#lock.run(async () => {
      if (content === null) await rm(target, { force: true });
      else await writeJsonAtomic(target, { path: file, content, ...(baseVersion === undefined ? {} : { baseVersion }), at });
    });
  }
}
