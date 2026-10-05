import { describe, expect, it } from 'vitest';
import { Journal, ManualClock, matchesFilter, Mutex, systemClock } from '../src/index.ts';
import { agent, learner, tempDir } from './helpers.ts';

describe('Journal', () => {
  it('stamps ids and a non-decreasing time even if the clock goes backwards', async () => {
    const clock = new ManualClock('2026-10-05T10:00:00.000Z');
    const j = await Journal.open(await tempDir(), clock);
    const a = await j.exclusive(() => j.append({ type: 'instruction', author: learner, kcs: ['k'] }));
    clock.advance(-60_000);
    const b = await j.exclusive(() => j.append({ type: 'instruction', author: learner, kcs: ['k'] }));
    expect(b.at).toBe(a.at);
    expect(j.now().toISOString()).toBe(a.at);
    expect(j.events).toHaveLength(2);
  });

  it('reloads from disk', async () => {
    const dir = await tempDir();
    const j = await Journal.open(dir, new ManualClock('2026-10-05T10:00:00.000Z'));
    await j.exclusive(() => j.append({ type: 'instruction', author: learner, kcs: ['k'] }));
    const reopened = await Journal.open(dir);
    expect(reopened.events).toEqual(j.events);
    expect(reopened.problems).toEqual([]);
  });
});

describe('matchesFilter', () => {
  const e = { author: agent, at: '2026-10-05T10:00:00.000Z' } as Parameters<typeof matchesFilter>[0];
  it.each([
    [{}, true],
    [{ authorKind: 'agent' }, true],
    [{ authorKind: 'learner' }, false],
    [{ agent: 'claude-code', model: 'claude-opus-5-5', session: 's1' }, true],
    [{ agent: 'other' }, false],
    [{ model: 'other' }, false],
    [{ session: 'other' }, false],
    [{ since: '2026-10-05T10:00:00.000Z', until: '2026-10-05T10:00:00.000Z' }, true],
    [{ since: '2026-10-06T00:00:00.000Z' }, false],
    [{ until: '2026-10-04T00:00:00.000Z' }, false],
  ] as const)('%j → %s', (filter, expected) => {
    expect(matchesFilter(e, filter)).toBe(expected);
  });
});

describe('Mutex / clock', () => {
  it('serialises and survives rejections', async () => {
    const m = new Mutex();
    const order: number[] = [];
    const slow = m.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
    });
    const failing = m.run(async () => {
      order.push(2);
      throw new Error('x');
    });
    const fast = m.run(async () => order.push(3));
    await slow;
    await expect(failing).rejects.toThrow('x');
    await fast;
    expect(order).toEqual([1, 2, 3]);
  });

  it('system clock is real time', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
