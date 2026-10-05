import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LockedError,
  ManualClock,
  MigrationError,
  ProfileNotFoundError,
  ProfileStore,
  dataRoot,
  migrate,
} from '../src/index.ts';
import { brand } from '@app/brand';
import { agent, tempDir } from './helpers.ts';

describe('dataRoot', () => {
  const home = '/home/u';
  it('honours the override', () => {
    expect(dataRoot({ platform: 'linux', env: { [`${brand.envPrefix}_DATA_DIR`]: '/x/y' }, home })).toBe(path.resolve('/x/y'));
  });
  it('follows OS conventions', () => {
    expect(dataRoot({ platform: 'linux', env: {}, home })).toBe(`/home/u/.local/share/${brand.dataDirName}`);
    expect(dataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg' }, home })).toBe(`/xdg/${brand.dataDirName}`);
    expect(dataRoot({ platform: 'linux', env: { XDG_DATA_HOME: 'relative' }, home })).toBe(`/home/u/.local/share/${brand.dataDirName}`);
    expect(dataRoot({ platform: 'darwin', env: {}, home })).toBe(`/home/u/Library/Application Support/${brand.displayName}`);
    expect(dataRoot({ platform: 'win32', env: { APPDATA: 'C:\\A' }, home: 'C:\\U' })).toBe(`C:\\A\\${brand.displayName}`);
    expect(dataRoot({ platform: 'win32', env: {}, home: 'C:\\U' })).toBe(`C:\\U\\AppData\\Roaming\\${brand.displayName}`);
  });
});

describe('migrate', () => {
  const steps = { 1: (d: Record<string, unknown>) => ({ ...d, added: true }) };
  it('runs steps in order and stamps versions', () => {
    expect(migrate({ schemaVersion: 1 }, 2, steps)).toEqual({ schemaVersion: 2, added: true });
    expect(migrate({ schemaVersion: 2 }, 2, steps)).toEqual({ schemaVersion: 2 });
  });
  it.each([
    [{}, /invalid schemaVersion/],
    [{ schemaVersion: 0 }, /invalid schemaVersion/],
    [{ schemaVersion: 3 }, /newer version/],
  ])('refuses %j', (doc, msg) => {
    expect(() => migrate(doc, 2, steps)).toThrow(msg);
  });
  it('fails when a step is missing', () => {
    expect(() => migrate({ schemaVersion: 1 }, 3, steps)).toThrow(MigrationError);
  });
});

describe('ProfileStore', () => {
  it('creates, lists, reads and updates profiles in separate directories', async () => {
    const root = await tempDir();
    const store = new ProfileStore(root, new ManualClock('2026-10-05T10:00:00.000Z'));
    expect(await store.list()).toEqual([]);
    const a = await store.create('Jules');
    const b = await store.create('Sam');
    expect(a.settings).toEqual({ changeMode: 'review', sessionMode: 'lesson', encrypted: false });
    expect((await store.list()).map((p) => p.displayName).sort()).toEqual(['Jules', 'Sam']);
    expect(a.id).not.toBe(b.id);
    const updated = await store.updateSettings(a.id, { changeMode: 'auto' });
    expect(updated.settings.changeMode).toBe('auto');
    expect((await store.read(a.id)).settings.changeMode).toBe('auto');
    await expect(store.create('   ')).rejects.toThrow();
  });

  it('refuses invalid ids and missing profiles', async () => {
    const store = new ProfileStore(await tempDir());
    await expect(store.read('../etc')).rejects.toThrow(ProfileNotFoundError);
    await expect(store.read('prof_01234567-89ab-7cde-8f01-23456789abcd')).rejects.toThrow(ProfileNotFoundError);
  });

  it('refuses profiles written by a newer app', async () => {
    const root = await tempDir();
    const store = new ProfileStore(root);
    const p = await store.create('X');
    await writeFile(path.join(root, 'profiles', p.id, 'profile.json'), JSON.stringify({ ...p, schemaVersion: 99 }));
    await expect(store.read(p.id)).rejects.toThrow(MigrationError);
  });

  it('opens with an exclusive lock and wires journal, observations and changes', async () => {
    const root = await tempDir();
    const store = new ProfileStore(root, new ManualClock('2026-10-05T10:00:00.000Z'));
    const p = await store.create('Jules');
    const open = await store.open(p.id);
    await expect(store.open(p.id)).rejects.toThrow(LockedError);
    await open.changes.propose(
      { author: agent, target: 'projects/hmp/project.json', patch: [{ op: 'add', path: '', value: { goal: 'physics' } }], reason: 'new project' },
      open.profile.settings.changeMode === 'review' ? 'auto' : 'review',
    );
    await open.observations.recordInstruction({ author: agent, kcs: ['spatial.motion'] });
    await open.close();

    const again = await store.open(p.id);
    expect(again.journal.events).toHaveLength(3);
    expect(await again.changes.read('projects/hmp/project.json')).toEqual({ goal: 'physics' });
    await again.close();
  });

  it('releases the lock if opening fails', async () => {
    const root = await tempDir();
    const store = new ProfileStore(root);
    const p = await store.create('X');
    await writeFile(path.join(root, 'profiles', p.id, 'events', '2026-10.jsonl'), '');
    const eventsDir = path.join(root, 'profiles', p.id, 'events');
    // Make the events dir unreadable as a dir by replacing it with a file.
    const { rm } = await import('node:fs/promises');
    await rm(eventsDir, { recursive: true });
    await writeFile(eventsDir, 'not a dir');
    await expect(store.open(p.id)).rejects.toMatchObject({ code: 'ENOTDIR' });
    const ok = await (await import('../src/index.ts')).acquireLock(path.join(root, 'profiles', p.id));
    await ok.release();
  });

  it('list propagates unexpected errors', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'profiles'), 'file');
    await expect(new ProfileStore(root).list()).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
