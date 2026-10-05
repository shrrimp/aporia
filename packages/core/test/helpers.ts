import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { Author } from '../src/index.ts';

const dirs: string[] = [];

export async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'app-core-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export const agent: Author = { kind: 'agent', agent: 'claude-code', model: 'claude-opus-5-5', session: 's1' };
export const learner: Author = { kind: 'learner' };
