import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { DraftDTO, WorkspaceEntryDTO } from '@app/server/protocol';
import { useRpc } from '../hooks.tsx';
import { RpcFailure } from '../rpc.ts';

export interface CodeViewProps {
  readonly path: string;
  readonly value: string;
  /**
   * Bumped when the content comes from disk (opened, reloaded): only then does the view take
   * `value`. In between, the view owns the text and reports it through onChange; pushing the
   * parent's copy back while typing would undo keystrokes not rendered yet.
   */
  readonly revision: number;
  readonly readOnly: boolean;
  onChange(value: string): void;
  /** Save now. The view passes its current text: a keystroke not rendered yet is still saved. */
  onSave(value: string): void;
}

/** The code view itself. Monaco in the app; replaceable (tests use a textarea). */
// Loading Monaco needs a real browser: tests swap in a textarea before this ever runs.
/* v8 ignore next */
let CodeView: ComponentType<CodeViewProps> = lazy(() => import('./MonacoView.tsx'));
export function setCodeView(view: ComponentType<CodeViewProps>): void {
  CodeView = view;
}

interface Buffer {
  content: string;
  revision: number;
  /** What is on disk (as last read or saved); undefined for a file not created yet. */
  version: string | undefined;
  saved: string;
  /** The text came from a draft kept when the app closed, not from disk. */
  restored?: boolean;
}

/** Unsaved text is kept (outside the workspace) this long after the last keystroke. */
const DRAFT_MS = 400;

interface Conflict {
  readonly path: string;
  readonly message: string;
  /** The version now on disk, to overwrite it on purpose (null: deleted). */
  readonly version: string | null;
}

const parent = (dir: string) => dir.split('/').slice(0, -1).join('/');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * The embedded editor (roadmap 1.8): the learner's own files, next to the lesson. Edits stay in
 * memory per file until saved; a save never overwrites a change made meanwhile in another
 * editor without asking. External editors keep working: the checkpoints and the tutor read the
 * files on disk.
 */
export function Editor({ projectId, open, onOpen }: { projectId: string; open: string | undefined; onOpen: (path: string) => void }) {
  const rpc = useRpc();
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntryDTO[]>();
  const [listError, setListError] = useState<string>();
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<Conflict>();
  const [saving, setSaving] = useState(false);
  // Unsaved text from before a restart or crash, by path; kept until saved or discarded.
  const drafts = useMemo(
    () =>
      rpc.call('drafts.list', { projectId }).then(
        (list) => new Map<string, DraftDTO>(list.map((d) => [d.path, d])),
        () => new Map<string, DraftDTO>(),
      ),
    [rpc, projectId],
  );
  const [draftPaths, setDraftPaths] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    void drafts.then((d) => live && setDraftPaths(new Set(d.keys())));
    return () => {
      live = false;
    };
  }, [drafts]);

  useEffect(() => {
    let live = true;
    rpc.call('workspace.list', { projectId, dir }).then(
      (e) => {
        if (!live) return;
        setEntries(e);
        setListError(undefined);
      },
      (err: Error) => live && setListError(err.message),
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId, dir]);

  // Drafts are written shortly after typing stops, and at once when the editor closes.
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => void }>());
  const keepDraft = useCallback(
    (path: string, content: string | null, baseVersion: string | undefined, delay = DRAFT_MS) => {
      const before = pending.current.get(path);
      if (before) clearTimeout(before.timer);
      const write = () => {
        pending.current.delete(path);
        void rpc.call('drafts.set', { projectId, path, content, ...(baseVersion === undefined ? {} : { baseVersion }) }).catch(() => undefined);
        setDraftPaths((d) => {
          const next = new Set(d);
          if (content === null) next.delete(path);
          else next.add(path);
          return next;
        });
      };
      if (delay === 0) write();
      else pending.current.set(path, { timer: setTimeout(write, delay), write });
    },
    [rpc, projectId],
  );
  useEffect(
    () => () => {
      for (const p of [...pending.current.values()]) {
        clearTimeout(p.timer);
        p.write();
      }
    },
    [],
  );

  const load = useCallback(
    async (path: string) => {
      setError(undefined);
      try {
        const [r, kept] = await Promise.all([rpc.call('workspace.read', { projectId, path }), drafts]);
        const draft = kept.get(path);
        kept.delete(path); // used once: a reload from disk later means the disk version
        if (draft && draft.content === r.content) keepDraft(path, null, undefined, 0);
        // The draft's base version, not the disk's: if the file changed meanwhile, saving asks first.
        const next: Buffer =
          draft && draft.content !== r.content
            ? { content: draft.content, version: draft.baseVersion, saved: r.content, revision: 0, restored: true }
            : { content: r.content, version: r.version, saved: r.content, revision: 0 };
        setBuffers((b) => ({ ...b, [path]: { ...next, revision: (b[path]?.revision ?? 0) + 1 } }));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [rpc, projectId, drafts, keepDraft],
  );

  useEffect(() => {
    if (open !== undefined && buffers[open] === undefined) void load(open);
    // Load once per newly opened file; later changes to the buffers must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  const buffer = open === undefined ? undefined : buffers[open];
  const dirty = buffer !== undefined && buffer.content !== buffer.saved;

  const save = useCallback(
    async (overwrite?: string | null, text?: string) => {
      if (open === undefined || !buffer) return;
      const content = text ?? buffer.content;
      setSaving(true);
      setError(undefined);
      try {
        const base = overwrite === undefined ? buffer.version : overwrite ?? undefined;
        const { version } = await rpc.call('workspace.write', { projectId, path: open, content, ...(base === undefined ? {} : { baseVersion: base }) });
        const typedSince = buffersRef.current[open]!.content !== buffer.content;
        setBuffers((b) => ({ ...b, [open]: { ...b[open]!, content: typedSince ? b[open]!.content : content, version, saved: content, restored: false } }));
        if (!typedSince) keepDraft(open, null, undefined, 0);
        setConflict(undefined);
      } catch (err) {
        if (err instanceof RpcFailure && err.code === 'conflict') {
          setConflict({ path: open, message: err.message, version: (err.data as { version: string | null } | undefined)?.version ?? null });
        } else setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [rpc, projectId, open, buffer, keepDraft],
  );

  const edit = useCallback(
    (content: string) => {
      if (open === undefined) return;
      const b = buffersRef.current[open];
      if (!b) return;
      setBuffers((all) => (all[open] ? { ...all, [open]: { ...all[open], content } } : all));
      keepDraft(open, content === b.saved ? null : content, b.version);
    },
    [open, keepDraft],
  );

  const changed = new Set([...draftPaths, ...Object.entries(buffers).filter(([, b]) => b.content !== b.saved).map(([p]) => p)]);

  return (
    <section className="editor" aria-label="Editor">
      <nav className="editor-files" aria-label="Workspace files">
        <p className="editor-dir">
          <button type="button" className="text" disabled={dir === ''} onClick={() => setDir(parent(dir))}>
            {dir === '' ? 'workspace' : '← up'}
          </button>
          {dir && <span className="quiet"> /{dir}</span>}
        </p>
        {listError && <p className="error">{listError}</p>}
        <ul>
          {entries?.map((e) => (
            <li key={e.name}>
              <button
                type="button"
                className={`entry kind-${e.kind}`}
                aria-current={open === join(dir, e.name)}
                onClick={() => (e.kind === 'dir' ? setDir(join(dir, e.name)) : onOpen(join(dir, e.name)))}
              >
                {e.name}
                {e.kind === 'dir' ? '/' : ''}
                {changed.has(join(dir, e.name)) && <span className="dirty" aria-label="unsaved"> ●</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="editor-main">
        <header className="editor-head">
          <span className="editor-path">{open ?? 'Pick a file'}</span>
          {dirty && <span className="dirty">{buffer.restored ? 'unsaved (kept from your last session)' : 'unsaved'}</span>}
          <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>
        {conflict && conflict.path === open && (
          <div className="editor-conflict" role="alert">
            <p>{conflict.message}</p>
            <button
              type="button"
              onClick={() =>
                void load(conflict.path).then(() => {
                  keepDraft(conflict.path, null, undefined, 0); // the disk version wins: forget the edits
                  setConflict(undefined);
                })
              }
            >
              Reload from disk
            </button>
            <button type="button" onClick={() => void save(conflict.version)}>
              Keep mine (overwrite)
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {open !== undefined && buffer && (
          <Suspense fallback={<p className="quiet">Loading the editor…</p>}>
            <CodeView path={open} value={buffer.content} revision={buffer.revision} readOnly={saving} onChange={edit} onSave={(text) => void save(undefined, text)} />
          </Suspense>
        )}
        {open === undefined && <p className="quiet editor-empty">Open a file from the list, or from a task's file names. Saving writes it to your workspace; your own editor works too.</p>}
      </div>
    </section>
  );
}
