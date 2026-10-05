import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockedError, acquireLock, processIsAlive } from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('acquireLock', () => {
  it('is exclusive while held and reusable after release', async () => {
    const dir = await tempDir();
    const lock = await acquireLock(dir);
    await expect(acquireLock(dir)).rejects.toThrow(LockedError);
    await lock.release();
    await lock.release(); // idempotent
    const again = await acquireLock(dir);
    await again.release();
  });

  it('takes over a lock left by a dead process or a corrupt lock file', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, '.lock'), JSON.stringify({ pid: 999_999_999 }));
    const lock = await acquireLock(dir, () => false);
    await lock.release();
    await writeFile(path.join(dir, '.lock'), 'garbage');
    await (await acquireLock(dir)).release();
  });

  it('propagates unexpected errors', async () => {
    await expect(acquireLock(path.join(await tempDir(), 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('processIsAlive', () => {
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(999_999_999)).toBe(false);
  });
});
