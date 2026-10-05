import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLog, newId, type LogEventInput } from '../src/index.ts';
import { learner, tempDir } from './helpers.ts';

const instruction = (at: string): LogEventInput => ({
  type: 'instruction',
  id: newId('ev', Date.parse(at)),
  at,
  author: learner,
  kcs: ['kc.a'],
});

describe('EventLog', () => {
  it('returns nothing for a missing directory', async () => {
    const log = new EventLog(path.join(await tempDir(), 'none'));
    await expect(log.readAll()).resolves.toEqual({ events: [], problems: [] });
  });

  it('appends to monthly files and reads back in append order', async () => {
    const dir = await tempDir();
    const log = new EventLog(dir);
    await log.append(instruction('2026-09-30T23:59:59.000Z'));
    await log.append(instruction('2026-10-01T00:00:00.000Z'));
    await log.append(instruction('2026-10-01T00:00:00.000Z'));
    const { events, problems } = await log.readAll();
    expect(problems).toEqual([]);
    expect(events.map((e) => e.at)).toEqual([
      '2026-09-30T23:59:59.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ]);
    expect(log.fileFor('2026-10-01T00:00:00.000Z')).toBe(path.join(dir, '2026-10.jsonl'));
  });

  it('rejects invalid events before writing anything', async () => {
    const log = new EventLog(await tempDir());
    await expect(log.append({ ...instruction('2026-10-01T00:00:00.000Z'), kcs: [] } as LogEventInput)).rejects.toThrow();
    await expect(log.append({ ...instruction('2026-10-01T00:00:00Z') })).rejects.toThrow();
    expect((await log.readAll()).events).toEqual([]);
  });

  it('reports torn and invalid lines, keeps the rest, and recovers on the next append', async () => {
    const dir = await tempDir();
    const log = new EventLog(dir);
    await log.append(instruction('2026-10-01T00:00:00.000Z'));
    const file = path.join(dir, '2026-10.jsonl');
    await appendFile(file, '{"type":"instruction","id":"ev_trunc'); // crash mid-append
    await log.append(instruction('2026-10-02T00:00:00.000Z'));
    await appendFile(file, '{"type":"bogus"}\n');
    await writeFile(path.join(dir, 'notes.txt'), 'ignored');

    const { events, problems } = await log.readAll();
    expect(events).toHaveLength(2);
    expect(problems.map((p) => p.line)).toEqual([2, 4]);
    expect(problems[0]!.message).toMatch(/invalid JSON/);
    expect(JSON.parse((await readFile(file, 'utf8')).split('\n')[2]!)).toMatchObject({ type: 'instruction' });
  });

  it('propagates unexpected read errors', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'file'), '');
    await expect(new EventLog(path.join(dir, 'file')).readAll()).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
