import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { ManualClock } from '@app/core';
import { AppService } from '../src/index.ts';
import { MAX_FILE_BYTES, listDir, readText, writeText } from '../src/workspace.ts';
import { fakeTeacherAgent } from './fake-teacher-agent.ts';

let root: string;
let ws: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ws-root-'));
  ws = path.join(root, 'engine');
  outside = path.join(root, 'outside');
  await mkdir(path.join(ws, 'src'), { recursive: true });
  await mkdir(path.join(ws, '.git'));
  await mkdir(path.join(ws, 'node_modules'));
  await mkdir(outside);
  await writeFile(path.join(ws, 'src', 'Joint.cpp'), 'void integratePosition() {}\n');
  await writeFile(path.join(ws, 'README.md'), '# Engine\n');
  await writeFile(path.join(ws, 'run.sh'), '#!/bin/sh\nctest\n');
  await chmod(path.join(ws, 'run.sh'), 0o755);
  await writeFile(path.join(ws, 'blob.bin'), Buffer.from([1, 0, 2]));
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(outside, path.join(ws, 'escape'));
  await symlink(path.join(ws, 'README.md'), path.join(ws, 'readme-link'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workspace files', () => {
  it('lists folders first, hides tool folders, and lists symlinks as files', async () => {
    expect(await listDir(ws, '')).toEqual([
      { name: 'src', kind: 'dir' },
      { name: 'blob.bin', kind: 'file' },
      { name: 'escape', kind: 'file' },
      { name: 'readme-link', kind: 'file' },
      { name: 'README.md', kind: 'file' },
      { name: 'run.sh', kind: 'file' },
    ]);
    expect(await listDir(ws, 'src')).toEqual([{ name: 'Joint.cpp', kind: 'file' }]);
    // Case-insensitive order (portable: no two names differ only by case, for macOS and Windows).
    await writeFile(path.join(ws, 'src', 'b.h'), '');
    await writeFile(path.join(ws, 'src', 'A.h'), '');
    expect((await listDir(ws, 'src')).map((e) => e.name)).toEqual(['A.h', 'b.h', 'Joint.cpp']);
    await expect(listDir(ws, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(listDir(ws, 'README.md')).rejects.toMatchObject({ code: 'not_found' });
    await expect(listDir(ws, '../outside')).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(listDir(ws, 'escape')).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(listDir('relative', '')).rejects.toMatchObject({ code: 'conflict' });
    // Other failures surface as they are.
    await expect(listDir(ws, 'README.md/x')).rejects.toMatchObject({ code: 'ENOTDIR' });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(path.join(ws, 'src'), 0o000);
      try {
        await expect(listDir(ws, 'src')).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(path.join(ws, 'src'), 0o755);
      }
    }
  });

  it('reads text files inside the workspace only', async () => {
    const r = await readText(ws, 'src/Joint.cpp');
    expect(r.content).toBe('void integratePosition() {}\n');
    expect(r.version).toMatch(/^[0-9a-f]{16}$/);
    expect((await readText(ws, 'readme-link')).content).toBe('# Engine\n');
    await expect(readText(ws, 'escape/secret.txt')).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(readText(ws, '../outside/secret.txt')).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(readText(ws, 'blob.bin')).rejects.toMatchObject({ message: expect.stringMatching(/not a text file/) });
    await expect(readText(ws, 'src')).rejects.toMatchObject({ code: 'not_found' });
    await expect(readText(ws, 'nope.cpp')).rejects.toMatchObject({ code: 'not_found' });
    await writeFile(path.join(ws, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
    await expect(readText(ws, 'big.txt')).rejects.toMatchObject({ message: expect.stringMatching(/too large/) });
  });

  it('saves only over the version that was opened, keeping permissions', async () => {
    const { version } = await readText(ws, 'run.sh');
    const saved = await writeText(ws, 'run.sh', '#!/bin/sh\nctest -R Joint\n', version);
    expect(await readFile(path.join(ws, 'run.sh'), 'utf8')).toBe('#!/bin/sh\nctest -R Joint\n');
    expect((await stat(path.join(ws, 'run.sh'))).mode & 0o777).toBe(0o755);

    // Changed elsewhere meanwhile: refused, with the version now on disk to overwrite it on purpose.
    await writeFile(path.join(ws, 'run.sh'), 'changed in vim\n');
    const conflict = await writeText(ws, 'run.sh', 'mine', saved.version).catch((e: unknown) => e);
    expect(conflict).toMatchObject({ code: 'conflict', data: { version: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    await writeText(ws, 'run.sh', 'mine', (conflict as { data: { version: string } }).data.version);
    expect(await readFile(path.join(ws, 'run.sh'), 'utf8')).toBe('mine');

    await writeText(ws, 'src/new/Body.cpp', '// new\n', undefined);
    expect(await readFile(path.join(ws, 'src', 'new', 'Body.cpp'), 'utf8')).toBe('// new\n');
    await expect(writeText(ws, 'gone.cpp', 'x', 'abc')).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/deleted/) });
    await expect(writeText(ws, 'escape/secret.txt', 'pwned', undefined)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    await expect(writeText(ws, 'src', 'x', undefined)).rejects.toMatchObject({ message: expect.stringMatching(/not a file/) });
    await expect(writeText(ws, 'huge.txt', 'x'.repeat(MAX_FILE_BYTES + 1), undefined)).rejects.toMatchObject({ message: expect.stringMatching(/too large/) });
  });

  it('is reachable through the app, for projects with a workspace', async () => {
    const app = new AppService({
      dataRoot: path.join(root, 'data'),
      clock: new ManualClock('2026-10-06T10:00:00.000Z'),
      agent: genericAgent('fake', 'Fake', { command: 'unused', args: [] }),
      hostFactory: (s) => AgentHost.inProcess(fakeTeacherAgent(), s),
    });
    try {
      const p = await app.call('profiles.create', { displayName: 'Ada' });
      await app.call('profiles.open', { profileId: p.id });
      const project = await app.call('projects.create', { title: 'Engine', goal: 'g', workspace: ws });
      const none = await app.call('projects.create', { title: 'Theory', goal: 'g' });
      expect((await app.call('workspace.list', { projectId: project.id })).map((e) => e.name)).toContain('src');
      const { version } = await app.call('workspace.read', { projectId: project.id, path: 'README.md' });
      expect(await app.call('workspace.write', { projectId: project.id, path: 'README.md', content: '# Mine\n', baseVersion: version })).toHaveProperty('version');
      await expect(app.call('workspace.list', { projectId: none.id })).rejects.toMatchObject({ code: 'conflict' });
      await expect(app.call('workspace.read', { projectId: project.id, path: 'src\\Joint.cpp' })).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      await app.close();
    }
  });
});
