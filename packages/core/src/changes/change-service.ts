import { readFile, rm } from 'node:fs/promises';
import { newId } from '../ids.ts';
import { writeJsonAtomic } from '../fs/atomic.ts';
import { resolveInsideReal } from '../fs/safe-path.ts';
import { matchesFilter, type HistoryFilter, type Journal } from '../store/journal.ts';
import type { Author, LogEvent } from '../store/schemas.ts';
import { applyPatch, pathsOverlap, touchedPaths, type JsonValue, type PatchOp } from './json-patch.ts';

export type ChangeStatus = 'proposed' | 'applied' | 'rejected' | 'reverted';
export type ChangeMode = 'review' | 'auto';

export interface ChangeState {
  readonly changeId: string;
  readonly target: string;
  readonly patch: readonly PatchOp[];
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly author: Author;
  readonly proposedAt: string;
  readonly status: ChangeStatus;
  /** Inverse of the most recent application (present while applied or reverted). */
  readonly inverse?: readonly PatchOp[];
  /** Journal position of the most recent application; orders dependants. */
  readonly appliedSeq?: number;
  readonly events: readonly LogEvent[];
}

/** Returns human/agent-readable problems with a document; empty = valid. */
export type DocumentValidator = (target: string, doc: JsonValue) => string[];

export class ChangeError extends Error {
  override readonly name: string = 'ChangeError';
}
export class ChangeConflictError extends ChangeError {
  override readonly name = 'ChangeConflictError';
}
export class ChangeValidationError extends ChangeError {
  override readonly name = 'ChangeValidationError';
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`document would be invalid: ${problems.join('; ')}`);
    this.problems = problems;
  }
}
export class DependantsError extends ChangeError {
  override readonly name = 'DependantsError';
  readonly dependants: readonly string[];
  constructor(dependants: readonly string[]) {
    super(`later changes depend on this one: ${dependants.join(', ')}`);
    this.dependants = dependants;
  }
}

/** Rebuild every change's state from the journal. */
export function foldChanges(events: readonly LogEvent[]): Map<string, ChangeState> {
  const out = new Map<string, ChangeState>();
  events.forEach((e, seq) => {
    switch (e.type) {
      case 'change.proposed':
        out.set(e.changeId, {
          changeId: e.changeId,
          target: e.target,
          patch: e.patch,
          reason: e.reason,
          evidence: e.evidence,
          author: e.author,
          proposedAt: e.at,
          status: 'proposed',
          events: [e],
        });
        return;
      case 'change.applied':
      case 'change.restored':
      case 'change.rejected':
      case 'change.reverted': {
        const prev = out.get(e.changeId);
        if (prev === undefined) return;
        const events = [...prev.events, e];
        if (e.type === 'change.rejected') out.set(e.changeId, { ...prev, status: 'rejected', events });
        else if (e.type === 'change.reverted') out.set(e.changeId, { ...prev, status: 'reverted', events });
        else if (e.type === 'change.applied' || e.type === 'change.restored') {
          out.set(e.changeId, { ...prev, status: 'applied', inverse: e.inverse, appliedSeq: seq, events });
        }
        return;
      }
      default:
        return;
    }
  });
  return out;
}

/** Replay the journal to compute a document's content (null = absent). */
export function materialize(events: readonly LogEvent[], target: string): JsonValue {
  const patches = new Map<string, readonly PatchOp[]>();
  const lastInverse = new Map<string, readonly PatchOp[]>();
  let doc: JsonValue = null;
  for (const e of events) {
    if (e.type === 'change.proposed') {
      if (e.target === target) patches.set(e.changeId, e.patch);
    } else if (e.type === 'change.applied' || e.type === 'change.restored') {
      const patch = patches.get(e.changeId);
      if (patch === undefined) continue;
      doc = applyPatch(doc, patch).doc;
      lastInverse.set(e.changeId, e.inverse);
    } else if (e.type === 'change.reverted') {
      const inverse = lastInverse.get(e.changeId);
      if (inverse !== undefined) doc = applyPatch(doc, inverse).doc;
    }
  }
  return doc;
}

export interface ProposeInput {
  readonly author: Author;
  readonly target: string;
  readonly patch: readonly PatchOp[];
  readonly reason: string;
  readonly evidence?: readonly string[];
}

/**
 * Every change to a profile document goes through here. The journal is the source of truth:
 * an event is appended *before* the document file is written, and {@link reconcile} rebuilds
 * any file that a crash left behind. Documents are JSON objects or arrays; null means absent.
 */
export class ChangeService {
  readonly #validators: DocumentValidator[] = [];

  readonly journal: Journal;
  readonly root: string;

  constructor(journal: Journal, root: string) {
    this.journal = journal;
    this.root = root;
  }

  addValidator(v: DocumentValidator): void {
    this.#validators.push(v);
  }

  get(changeId: string): ChangeState | undefined {
    return foldChanges(this.journal.events).get(changeId);
  }

  list(filter: HistoryFilter & { status?: ChangeStatus; target?: string } = {}): ChangeState[] {
    return [...foldChanges(this.journal.events).values()].filter(
      (c) =>
        (filter.status === undefined || c.status === filter.status) &&
        (filter.target === undefined || c.target === filter.target) &&
        matchesFilter(c.events[0]!, filter),
    );
  }

  async read(target: string): Promise<JsonValue> {
    const file = await resolveInsideReal(this.root, target);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as JsonValue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Propose a change; in `auto` mode it is applied immediately. Throws if it cannot apply now. */
  propose(input: ProposeInput, mode: ChangeMode): Promise<ChangeState> {
    return this.journal.exclusive(async () => {
      const current = await this.read(input.target);
      const next = this.#tryApply(current, input.patch, input.target);
      const changeId = newId('chg');
      await this.journal.append({
        type: 'change.proposed',
        changeId,
        author: input.author,
        target: input.target,
        patch: [...input.patch],
        reason: input.reason,
        evidence: [...(input.evidence ?? [])],
      });
      if (mode === 'auto') await this.#commit(changeId, 'change.applied', input.author, input.target, next);
      return this.get(changeId)!;
    });
  }

  accept(changeId: string, by: Author): Promise<ChangeState> {
    return this.journal.exclusive(async () => {
      const c = this.#expect(changeId, 'proposed');
      const next = this.#tryApply(await this.read(c.target), c.patch, c.target);
      await this.#commit(changeId, 'change.applied', by, c.target, next);
      return this.get(changeId)!;
    });
  }

  reject(changeId: string, by: Author, reason?: string): Promise<ChangeState> {
    return this.journal.exclusive(async () => {
      this.#expect(changeId, 'proposed');
      await this.journal.append({ type: 'change.rejected', changeId, author: by, ...(reason ? { reason } : {}) });
      return this.get(changeId)!;
    });
  }

  /** Changes applied after `changeId` on the same document whose edits overlap it (transitively). */
  dependantsOf(changeId: string): string[] {
    const all = foldChanges(this.journal.events);
    const root = all.get(changeId);
    if (root?.status !== 'applied') return [];
    const later = [...all.values()]
      .filter((c) => c.status === 'applied' && c.target === root.target && c.appliedSeq! > root.appliedSeq!)
      .sort((a, b) => a.appliedSeq! - b.appliedSeq!);
    const touched = [...touchedPaths(root.patch)];
    const deps: string[] = [];
    for (const c of later) {
      const paths = touchedPaths(c.patch);
      if (paths.some((p) => touched.some((t) => pathsOverlap(p, t)))) {
        deps.push(c.changeId);
        touched.push(...paths);
      }
    }
    return deps;
  }

  /** Undo an applied change. With dependants, they are reverted first (newest first). */
  revert(changeId: string, by: Author, opts: { withDependants?: boolean; reason?: string } = {}): Promise<string[]> {
    return this.journal.exclusive(async () => {
      this.#expect(changeId, 'applied');
      const deps = this.dependantsOf(changeId);
      if (deps.length > 0 && !opts.withDependants) throw new DependantsError(deps);
      const order = [...deps.reverse(), changeId];
      for (const id of order) await this.#revertOne(id, by, opts.reason);
      return order;
    });
  }

  /** Redo a reverted change on top of the current document. */
  redo(changeId: string, by: Author): Promise<ChangeState> {
    return this.journal.exclusive(async () => {
      const c = this.#expect(changeId, 'reverted');
      const next = this.#tryApply(await this.read(c.target), c.patch, c.target);
      await this.#commit(changeId, 'change.restored', by, c.target, next);
      return this.get(changeId)!;
    });
  }

  /** Bulk undo: revert every applied change matching the filter, newest first. */
  async revertWhere(filter: HistoryFilter, by: Author, reason?: string): Promise<string[]> {
    const targets = this.list({ ...filter, status: 'applied' }).sort((a, b) => b.appliedSeq! - a.appliedSeq!);
    const done: string[] = [];
    for (const c of targets) {
      if (this.get(c.changeId)?.status !== 'applied') continue; // already reverted as a dependant
      done.push(...(await this.revert(c.changeId, by, { withDependants: true, ...(reason ? { reason } : {}) })));
    }
    return done;
  }

  /** Rewrite any document file that disagrees with the journal (e.g. after a crash). */
  reconcile(): Promise<string[]> {
    return this.journal.exclusive(async () => {
      const targets = new Set([...foldChanges(this.journal.events).values()].map((c) => c.target));
      const fixed: string[] = [];
      for (const target of [...targets].sort()) {
        const expected = materialize(this.journal.events, target);
        let actual: JsonValue | undefined;
        try {
          actual = await this.read(target);
        } catch {
          actual = undefined; // unreadable file: rewrite it
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          await this.#write(target, expected);
          fixed.push(target);
        }
      }
      return fixed;
    });
  }

  async #revertOne(changeId: string, by: Author, reason?: string): Promise<void> {
    const c = this.get(changeId)!;
    const next = this.#tryApply(await this.read(c.target), c.inverse!, c.target);
    await this.journal.append({ type: 'change.reverted', changeId, author: by, ...(reason ? { reason } : {}) });
    await this.#write(c.target, next.doc);
  }

  #expect(changeId: string, status: ChangeStatus): ChangeState {
    const c = this.get(changeId);
    if (c === undefined) throw new ChangeError(`unknown change ${changeId}`);
    if (c.status !== status) throw new ChangeError(`change ${changeId} is ${c.status}, expected ${status}`);
    return c;
  }

  #tryApply(doc: JsonValue, patch: readonly PatchOp[], target: string): { doc: JsonValue; inverse: PatchOp[] } {
    let result;
    try {
      result = applyPatch(doc, patch);
    } catch (err) {
      throw new ChangeConflictError(`cannot apply to ${target}: ${(err as Error).message}`);
    }
    if (result.doc !== null && typeof result.doc !== 'object') {
      throw new ChangeValidationError(['a document must be a JSON object or array']);
    }
    if (result.doc !== null) {
      const problems = this.#validators.flatMap((v) => v(target, result.doc));
      if (problems.length > 0) throw new ChangeValidationError(problems);
    }
    return result;
  }

  async #commit(
    changeId: string,
    type: 'change.applied' | 'change.restored',
    by: Author,
    target: string,
    next: { doc: JsonValue; inverse: PatchOp[] },
  ): Promise<void> {
    await this.journal.append({ type, changeId, author: by, inverse: next.inverse });
    await this.#write(target, next.doc);
  }

  async #write(target: string, doc: JsonValue): Promise<void> {
    const file = await resolveInsideReal(this.root, target);
    if (doc === null) await rm(file, { force: true });
    else await writeJsonAtomic(file, doc);
  }
}
