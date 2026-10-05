import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InvalidFileError, readJson, syncDir, writeFileAtomic, writeJsonAtomic } from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('atomic writes', () => {
  it('creates parent dirs, writes and overwrites without leaving temp files', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a', 'b', 'x.json');
    await writeJsonAtomic(file, { v: 1 });
    await writeJsonAtomic(file, { v: 2 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 2 });
    expect(await readdir(path.dirname(file))).toEqual(['x.json']);
  });

  it('cleans up the temp file when the rename fails', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'occupied');
    await mkdir(path.join(target, 'child'), { recursive: true }); // non-empty dir: rename over it fails
    await expect(writeFileAtomic(target, 'x')).rejects.toBeDefined();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('syncDir tolerates platforms that cannot fsync directories, but not missing dirs', async () => {
    await expect(syncDir(await tempDir())).resolves.toBeUndefined();
    await expect(syncDir(path.join(await tempDir(), 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readJson', () => {
  const schema = z.object({ v: z.number() });

  it('parses and validates', async () => {
    const file = path.join(await tempDir(), 'ok.json');
    await writeJsonAtomic(file, { v: 3 });
    await expect(readJson(file, schema)).resolves.toEqual({ v: 3 });
  });

  it('reports bad JSON and schema mismatches with the file name', async () => {
    const dir = await tempDir();
    await writeFileAtomic(path.join(dir, 'bad.json'), '{nope');
    await writeJsonAtomic(path.join(dir, 'wrong.json'), { v: 'x' });
    await expect(readJson(path.join(dir, 'bad.json'), schema)).rejects.toThrow(InvalidFileError);
    await expect(readJson(path.join(dir, 'wrong.json'), schema)).rejects.toThrow(/wrong\.json/);
  });
});
