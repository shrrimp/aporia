// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DrillItem } from '@app/catalog';
import { score, shuffled } from '../src/lesson/scoring.ts';
import { DEFAULT_CAMERA, add, boxEdges, frameAxes, project, sample, ticks } from '../src/lesson/geometry.ts';
import { ev, evNum, evQuat, evVec } from '../src/lesson/eval.ts';
import { RpcClient, RpcFailure, connectionFromLocation, type SocketLike } from '../src/rpc.ts';
import { quat } from '@app/catalog';

const base = { id: 'i', prompt: 'p', kcs: ['k'], difficulty: 3, why: 'w', transfer: false };

describe('scoring', () => {
  it('scores each kind deterministically', () => {
    expect(score({ ...base, kind: 'mcq', options: ['a', 'b'], answer: 1 } as DrillItem, { kind: 'mcq', choice: 1 })).toBe(1);
    expect(score({ ...base, kind: 'mcq', options: ['a', 'b'], answer: 1 } as DrillItem, { kind: 'mcq', choice: 0 })).toBe(0);
    // Two-tier: the answer counts fully only with the right reason (R8).
    const twoTier = { ...base, kind: 'mcq', options: ['a', 'b'], answer: 1, reason: { prompt: 'Why?', options: ['r0', 'r1'], answer: 0 } } as DrillItem;
    expect(score(twoTier, { kind: 'mcq', choice: 1, reason: 0 })).toBe(1);
    expect(score(twoTier, { kind: 'mcq', choice: 1, reason: 1 })).toBe(0.25);
    expect(score(twoTier, { kind: 'mcq', choice: 0, reason: 0 })).toBe(0);
    const num = { ...base, kind: 'numeric', answer: 2, tolerance: 0.01 } as DrillItem;
    expect(score(num, { kind: 'numeric', value: 2.005 })).toBe(1);
    expect(score(num, { kind: 'numeric', value: 2.1 })).toBe(0);
    const ord = { ...base, kind: 'order', lines: ['a', 'b', 'c'] } as DrillItem;
    expect(score(ord, { kind: 'order', lines: ['a', 'b', 'c'] })).toBe(1);
    expect(score(ord, { kind: 'order', lines: ['a', 'c', 'b'] })).toBe(0.5);
    expect(score(ord, { kind: 'order', lines: ['a', 'b'] })).toBe(0);
    expect(() => score(ord, { kind: 'mcq', choice: 0 })).toThrow(/does not match/);
  });

  it('shuffles deterministically and never returns the original order', () => {
    expect(shuffled(['a', 'b', 'c', 'd'], 'x')).toEqual(shuffled(['a', 'b', 'c', 'd'], 'x'));
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) expect(shuffled(['a', 'b'], seed)).toEqual(['b', 'a']);
    expect(shuffled(['solo'], 's')).toEqual(['solo']);
  });
});

describe('geometry', () => {
  it('projects 2D straight through and 3D orthographically', () => {
    expect(project([1, 2], DEFAULT_CAMERA)).toEqual({ x: 1, y: -2, depth: 0 });
    const p = project([0, 1, 0], { yaw: 0, pitch: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-1);
    expect(project([0, 0, 1], { yaw: 0, pitch: 0 }).depth).toBeCloseTo(1);
  });
  it('builds boxes and frames', () => {
    const edges = boxEdges([0, 0, 0], [2, 2, 2], quat(1, 0, 0, 0));
    expect(edges).toHaveLength(12);
    for (const [a, b] of edges) expect(Math.hypot(...a.map((x, i) => x - b[i]!))).toBeCloseTo(2);
    expect(frameAxes(quat(1, 0, 0, 0), 1, 3)).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    const two = frameAxes(quat(1, 0, 0, 0), 1, 2, Math.PI / 2);
    expect(two[0]![0]).toBeCloseTo(0);
    expect(two[0]![1]).toBeCloseTo(1);
    expect(add([1, 2], [3, 4])).toEqual([4, 6]);
  });
  it('makes nice ticks and samples with gaps', () => {
    expect(ticks(0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(ticks(-1, 1)).toContain(0);
    expect(ticks(3, 3)).toEqual([3]);
    const runs = sample((x) => (Math.abs(x) < 0.1 ? Number.NaN : 1 / x), -1, 1, 20);
    expect(runs.length).toBe(2);
    expect(sample(() => { throw new Error('x'); }, 0, 1, 4)).toEqual([]);
  });
  it('evaluates with caching and type checks', () => {
    expect(ev('1 + x', { x: 1 })).toBe(2);
    expect(ev('1 + x', { x: 2 })).toBe(3);
    expect(evNum('2', {})).toBe(2);
    expect(() => evNum('[1]', {})).toThrow(/not a number/);
    expect(evVec('[1, 2]', {}, 2)).toEqual([1, 2]);
    expect(() => evVec('[1, 2]', {}, 3)).toThrow(/3-vector/);
    expect(evQuat(undefined, {})).toEqual(quat(1, 0, 0, 0));
    expect(() => evQuat('1', {})).toThrow(/quaternion/);
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  reply(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

describe('RpcClient', () => {
  it('queues calls until open, resolves results, rejects errors, dispatches events', async () => {
    const sockets: FakeSocket[] = [];
    const c = new RpcClient('ws://x', () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    const statuses: string[] = [];
    const off = c.onStatus((s) => statuses.push(s));
    const p1 = c.call('profiles.list');
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ id: 1, method: 'profiles.list', params: {} });
    sockets[0]!.reply({ id: 1, result: [] });
    await expect(p1).resolves.toEqual([]);
    const p2 = c.call('profiles.open', { profileId: 'x' });
    sockets[0]!.reply({ id: 2, error: { code: 'not_found', message: 'nope' } });
    await expect(p2).rejects.toBeInstanceOf(RpcFailure);
    const seen: unknown[] = [];
    const unsub = c.on('changed', (d) => seen.push(d));
    sockets[0]!.reply({ event: 'changed', data: { what: 'history' } });
    sockets[0]!.reply({ id: 999, result: 1 });
    sockets[0]!.onmessage?.({ data: 'not json' });
    unsub();
    sockets[0]!.reply({ event: 'changed', data: { what: 'history' } });
    expect(seen).toEqual([{ what: 'history' }]);
    expect(statuses).toEqual(['open']);
    off();
    c.close();
  });

  it('fails pending calls on disconnect and reconnects with backoff', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const c = new RpcClient('ws://x', () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    sockets[0]!.open();
    const p = c.call('profiles.list');
    sockets[0]!.close();
    await expect(p).rejects.toThrow(/connection lost/);
    expect(c.status).toBe('closed');
    vi.advanceTimersByTime(300);
    expect(sockets).toHaveLength(2);
    c.close();
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(2);
    vi.useRealTimers();
  });

  it('builds connection URLs', () => {
    expect(connectionFromLocation({ hash: '', host: 'h', protocol: 'http:' } as Location, { url: 'http://127.0.0.1:9', token: 't t' })).toBe(
      'ws://127.0.0.1:9/rpc?token=t%20t',
    );
    expect(connectionFromLocation({ hash: '#token=abc', host: '127.0.0.1:5', protocol: 'http:' } as Location)).toBe('ws://127.0.0.1:5/rpc?token=abc');
    expect(connectionFromLocation({ hash: '#token=abc', host: 'h', protocol: 'https:' } as Location)).toBe('wss://h/rpc?token=abc');
    expect(connectionFromLocation({ hash: '', host: 'h', protocol: 'http:' } as Location)).toBeUndefined();
  });
});
