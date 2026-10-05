import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';

/**
 * Crash-safe write: data goes to a temp file in the same directory, is fsynced, then renamed
 * over the target. Readers see either the old or the new content, never a partial file.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await syncDir(dir);
}

/** fsync a directory so a rename survives power loss. Not supported on Windows: ignored there. */
export async function syncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL' && code !== 'EBADF') throw err;
  } finally {
    await handle?.close();
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export class InvalidFileError extends Error {
  override readonly name = 'InvalidFileError';
  readonly file: string;
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.file = file;
  }
}

/** Read and validate a JSON file. Throws InvalidFileError on bad JSON or schema mismatch. */
export async function readJson<S extends z.ZodType>(file: string, schema: S): Promise<z.output<S>> {
  const text = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new InvalidFileError(file, `invalid JSON (${(err as Error).message})`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new InvalidFileError(file, result.error.message);
  return result.data;
}
