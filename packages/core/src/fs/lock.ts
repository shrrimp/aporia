import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export class LockedError extends Error {
  override readonly name = 'LockedError';
}

export interface Lock {
  readonly file: string;
  release(): Promise<void>;
}

export type IsAlive = (pid: number) => boolean;

export const processIsAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Exclusive single-writer lock on a directory (one core process per profile).
 * A lock left behind by a dead process is taken over.
 */
export async function acquireLock(dir: string, isAlive: IsAlive = processIsAlive): Promise<Lock> {
  const file = path.join(dir, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      let released = false;
      return {
        file,
        async release() {
          if (released) return;
          released = true;
          await rm(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readHolder(file);
      if (holder !== undefined && isAlive(holder)) {
        throw new LockedError(`${dir} is in use by process ${holder}`);
      }
      await rm(file, { force: true });
    }
  }
  // Only reachable if another process re-creates the lock between our removal and retry.
  /* v8 ignore next */
  throw new LockedError(`could not acquire lock on ${dir}`);
}

async function readHolder(file: string): Promise<number | undefined> {
  try {
    const { pid } = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown };
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
