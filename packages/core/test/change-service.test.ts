import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ChangeConflictError,
  ChangeError,
  ChangeService,
  ChangeValidationError,
  DependantsError,
  Journal,
  ManualClock,
  materialize,
  type JsonValue,
} from '../src/index.ts';
import { agent, learner, tempDir } from './helpers.ts';

const T = 'projects/p1/lessons/l1.json';

async function setup() {
  const root = await tempDir();
  const journal = await Journal.open(path.join(root, 'events'), new ManualClock('2026-10-05T10:00:00.000Z'));
  return { root, svc: new ChangeService(journal, root) };
}

async function fileOf(root: string, target = T): Promise<JsonValue> {
  try {
    return JSON.parse(await readFile(path.join(root, target), 'utf8')) as JsonValue;
  } catch {
    return null;
  }
}

const create = (value: JsonValue) => ({
  author: agent,
  target: T,
  patch: [{ op: 'add' as const, path: '', value }],
  reason: 'create lesson',
});

describe('ChangeService', () => {
  it('auto mode applies immediately; the file and history agree', async () => {
    const { root, svc } = await setup();
    const c = await svc.propose(create({ title: 'A', sections: [] }), 'auto');
    expect(c.status).toBe('applied');
    expect(await fileOf(root)).toEqual({ title: 'A', sections: [] });
    expect(svc.list({ status: 'applied' })).toHaveLength(1);
    expect(svc.list({ target: 'other.json' })).toHaveLength(0);
    expect(svc.list({ model: 'claude-opus-5-5' })).toHaveLength(1);
  });

  it('review mode queues; accept applies, reject closes', async () => {
    const { root, svc } = await setup();
    const c = await svc.propose(create({ title: 'A' }), 'review');
    expect(c.status).toBe('proposed');
    expect(await fileOf(root)).toBeNull();
    await svc.accept(c.changeId, learner);
    expect(await fileOf(root)).toEqual({ title: 'A' });

    const r = await svc.propose({ ...create(null), patch: [{ op: 'replace', path: '/title', value: 'B' }] }, 'review');
    const rejected = await svc.reject(r.changeId, learner, 'no thanks');
    expect(rejected.status).toBe('rejected');
    expect(await fileOf(root)).toEqual({ title: 'A' });
    await expect(svc.accept(r.changeId, learner)).rejects.toThrow(/is rejected/);
    await expect(svc.reject('chg_nope', learner)).rejects.toThrow(ChangeError);
  });

  it('refuses patches that do not apply, at proposal and at acceptance', async () => {
    const { svc } = await setup();
    await expect(
      svc.propose({ ...create(null), patch: [{ op: 'remove', path: '/x' }] }, 'auto'),
    ).rejects.toThrow(ChangeConflictError);
    await svc.propose(create({ title: 'A' }), 'auto');
    const p = await svc.propose({ ...create(null), patch: [{ op: 'remove', path: '/title' }] }, 'review');
    await svc.propose({ ...create(null), patch: [{ op: 'remove', path: '/title' }] }, 'auto');
    await expect(svc.accept(p.changeId, learner)).rejects.toThrow(ChangeConflictError);
  });

  it('runs validators and refuses non-object documents', async () => {
    const { svc } = await setup();
    svc.addValidator((target, doc) => (target.endsWith('.json') && !('title' in (doc as object)) ? ['title is required'] : []));
    await expect(svc.propose(create({ nope: 1 }), 'auto')).rejects.toThrow(ChangeValidationError);
    await expect(svc.propose(create(42), 'auto')).rejects.toThrow(/object or array/);
    try {
      await svc.propose(create({}), 'auto');
    } catch (err) {
      expect((err as ChangeValidationError).problems).toEqual(['title is required']);
    }
  });

  it('reverts, redoes, and a reverted creation deletes the file', async () => {
    const { root, svc } = await setup();
    const c1 = await svc.propose(create({ title: 'A' }), 'auto');
    const c2 = await svc.propose({ ...create(null), patch: [{ op: 'add', path: '/tag', value: 'x' }] }, 'auto');
    await svc.revert(c2.changeId, learner);
    expect(await fileOf(root)).toEqual({ title: 'A' });
    await svc.redo(c2.changeId, learner);
    expect(await fileOf(root)).toEqual({ title: 'A', tag: 'x' });
    await expect(svc.redo(c2.changeId, learner)).rejects.toThrow(/is applied/);
    await svc.revert(c2.changeId, learner);
    await svc.revert(c1.changeId, learner);
    expect(await fileOf(root)).toBeNull();
  });

  it('detects dependants and reverts them together, newest first', async () => {
    const { root, svc } = await setup();
    const base = await svc.propose(create({ title: 'A', items: [] }), 'auto');
    const add = await svc.propose({ ...create(null), patch: [{ op: 'add', path: '/items/-', value: 'one' }] }, 'auto');
    const edit = await svc.propose({ ...create(null), patch: [{ op: 'replace', path: '/items/0', value: 'ONE' }] }, 'auto');
    const unrelated = await svc.propose({ ...create(null), patch: [{ op: 'replace', path: '/title', value: 'B' }] }, 'auto');

    expect(svc.dependantsOf(add.changeId)).toEqual([edit.changeId]);
    expect(svc.dependantsOf('chg_unknown')).toEqual([]);
    await expect(svc.revert(add.changeId, learner)).rejects.toThrow(DependantsError);
    const order = await svc.revert(add.changeId, learner, { withDependants: true, reason: 'wrong' });
    expect(order).toEqual([edit.changeId, add.changeId]);
    expect(await fileOf(root)).toEqual({ title: 'B', items: [] });
    expect(svc.get(unrelated.changeId)!.status).toBe('applied');
    expect(svc.dependantsOf(base.changeId).sort()).toEqual([unrelated.changeId].sort());
  });

  it('bulk-reverts everything one model did', async () => {
    const { root, svc } = await setup();
    await svc.propose({ ...create({ title: 'A', n: 0 }), author: learner }, 'auto');
    const tiny = { ...agent, model: 'tiny-model' };
    await svc.propose({ ...create(null), author: tiny, patch: [{ op: 'replace', path: '/n', value: 1 }] }, 'auto');
    await svc.propose({ ...create(null), author: tiny, patch: [{ op: 'replace', path: '/n', value: 2 }] }, 'auto');
    const reverted = await svc.revertWhere({ model: 'tiny-model' }, learner, 'bad model');
    expect(reverted).toHaveLength(2);
    expect(await fileOf(root)).toEqual({ title: 'A', n: 0 });
  });

  it('reconcile rebuilds files a crash left stale, missing or corrupt', async () => {
    const { root, svc } = await setup();
    await svc.propose(create({ title: 'A' }), 'auto');
    await svc.propose({ ...create(null), target: 'other.json' }, 'auto');
    expect(await svc.reconcile()).toEqual([]);
    await writeFile(path.join(root, T), '{"title":"tampered"}');
    await writeFile(path.join(root, 'other.json'), '{corrupt');
    expect((await svc.reconcile()).sort()).toEqual(['other.json', T].sort());
    expect(await fileOf(root)).toEqual({ title: 'A' });
  });

  it('read rethrows non-ENOENT errors', async () => {
    const { root, svc } = await setup();
    await mkdir(path.join(root, 'dir.json'));
    await expect(svc.read('dir.json')).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('materialize(journal) always equals the file (property)', async () => {
    type Step = { kind: 'set'; key: string; value: number } | { kind: 'del'; key: string } | { kind: 'revert'; i: number } | { kind: 'redo'; i: number };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ kind: fc.constant('set' as const), key: fc.constantFrom('a', 'b'), value: fc.integer({ min: 0, max: 9 }) }),
      fc.record({ kind: fc.constant('del' as const), key: fc.constantFrom('a', 'b') }),
      fc.record({ kind: fc.constant('revert' as const), i: fc.nat(10) }),
      fc.record({ kind: fc.constant('redo' as const), i: fc.nat(10) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 12 }), async (steps) => {
        const { root, svc } = await setup();
        const ids = [(await svc.propose(create({}), 'auto')).changeId];
        for (const s of steps) {
          try {
            if (s.kind === 'set') ids.push((await svc.propose({ ...create(null), patch: [{ op: 'add', path: `/${s.key}`, value: s.value }] }, 'auto')).changeId);
            else if (s.kind === 'del') ids.push((await svc.propose({ ...create(null), patch: [{ op: 'remove', path: `/${s.key}` }] }, 'auto')).changeId);
            else if (s.kind === 'revert') await svc.revert(ids[s.i % ids.length]!, learner, { withDependants: true });
            else await svc.redo(ids[s.i % ids.length]!, learner);
          } catch (err) {
            expect(err).toBeInstanceOf(ChangeError);
          }
          expect(materialize(svc.journal.events, T)).toEqual(await fileOf(root));
        }
      }),
      { numRuns: 40 },
    );
  });
});
