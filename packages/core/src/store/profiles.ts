import { mkdir, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { newId, isId } from '../ids.ts';
import { readJson, writeJsonAtomic } from '../fs/atomic.ts';
import { acquireLock, type Lock } from '../fs/lock.ts';
import { resolveInside } from '../fs/safe-path.ts';
import { migrate, type Migration } from './migrations.ts';
import { Journal } from './journal.ts';
import { Observations } from './observations.ts';
import { Progress } from './progress.ts';
import { Checkpoints } from './checkpoints.ts';
import { Hints } from './hints.ts';
import { ChangeService } from '../changes/change-service.ts';
import { systemClock, type Clock } from '../clock.ts';
import { isoDate } from './schemas.ts';

export const PROFILE_SCHEMA_VERSION = 1;

export const profileFile = z.strictObject({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  id: z.string().refine((v) => isId(v, 'prof')),
  displayName: z.string().trim().min(1).max(60),
  createdAt: isoDate,
  settings: z.strictObject({
    /** D4: queue agent changes for review, or apply them immediately. Always undoable. */
    changeMode: z.enum(['review', 'auto']).default('review'),
    /** D18: lifetime of an agent session. */
    sessionMode: z.enum(['interaction', 'lesson', 'permanent']).default('lesson'),
    /** D10: the user's choice; off by default. */
    encrypted: z.boolean().default(false),
  }),
});
export type ProfileFile = z.output<typeof profileFile>;

const PROFILE_MIGRATIONS: Readonly<Record<number, Migration>> = {};

export class ProfileNotFoundError extends Error {
  override readonly name = 'ProfileNotFoundError';
}

/** An opened profile: holds the writer lock until closed. */
export interface OpenProfile {
  readonly profile: ProfileFile;
  readonly dir: string;
  readonly journal: Journal;
  readonly observations: Observations;
  readonly progress: Progress;
  readonly checkpoints: Checkpoints;
  readonly hints: Hints;
  readonly changes: ChangeService;
  close(): Promise<void>;
}

/** All profiles under one data root. Each profile is a separate directory (D10). */
export class ProfileStore {
  readonly root: string;
  readonly clock: Clock;

  constructor(root: string, clock: Clock = systemClock) {
    this.root = root;
    this.clock = clock;
  }

  #dir(id: string): string {
    if (!isId(id, 'prof')) throw new ProfileNotFoundError(`invalid profile id: ${id}`);
    return resolveInside(this.root, 'profiles', id);
  }

  async create(displayName: string): Promise<ProfileFile> {
    const profile = profileFile.parse({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      id: newId('prof', this.clock.now().getTime()),
      displayName,
      createdAt: this.clock.now().toISOString(),
      settings: {},
    });
    const dir = this.#dir(profile.id);
    await mkdir(resolveInside(dir, 'events'), { recursive: true });
    await mkdir(resolveInside(dir, 'projects'), { recursive: true });
    await writeJsonAtomic(resolveInside(dir, 'profile.json'), profile);
    return profile;
  }

  async list(): Promise<ProfileFile[]> {
    let names: string[];
    try {
      names = await readdir(resolveInside(this.root, 'profiles'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: ProfileFile[] = [];
    for (const name of names.filter((n) => isId(n, 'prof')).sort()) {
      out.push(await this.read(name));
    }
    return out;
  }

  async read(id: string): Promise<ProfileFile> {
    const file = resolveInside(this.#dir(id), 'profile.json');
    try {
      const raw = await readJson(file, z.record(z.string(), z.unknown()));
      return profileFile.parse(migrate(raw, PROFILE_SCHEMA_VERSION, PROFILE_MIGRATIONS));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ProfileNotFoundError(`no profile ${id}`);
      throw err;
    }
  }

  async updateSettings(id: string, settings: Partial<ProfileFile['settings']>): Promise<ProfileFile> {
    const current = await this.read(id);
    const next = profileFile.parse({ ...current, settings: { ...current.settings, ...settings } });
    await writeJsonAtomic(resolveInside(this.#dir(id), 'profile.json'), next);
    return next;
  }

  /** Open for writing: takes the lock, loads the journal, repairs documents from it. */
  async open(id: string): Promise<OpenProfile> {
    const profile = await this.read(id);
    const dir = this.#dir(id);
    const lock: Lock = await acquireLock(dir);
    try {
      const journal = await Journal.open(resolveInside(dir, 'events'), this.clock);
      const changes = new ChangeService(journal, dir);
      await changes.reconcile();
      return {
        profile,
        dir,
        journal,
        observations: new Observations(journal),
        progress: new Progress(journal),
        checkpoints: new Checkpoints(journal),
        hints: new Hints(journal),
        changes,
        close: () => lock.release(),
      };
    } catch (err) {
      await lock.release();
      throw err;
    }
  }
}
