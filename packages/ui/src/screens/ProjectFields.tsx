import { useEffect, useState } from 'react';
import { DEFAULT_PERMISSIONS, type AgentPermissions } from '@app/catalog';
import { useRpc } from '../hooks.tsx';

/** Browse folders inside the app (no native dialog, e.g. the app in a browser): folders only, never files. */
function FolderBrowser({ start, onPick, onClose }: { start: string | undefined; onPick: (path: string) => void; onClose: () => void }) {
  const rpc = useRpc();
  const [at, setAt] = useState<string | undefined>(start || undefined);
  const [view, setView] = useState<{ path: string; parent?: string; folders: string[] }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    rpc.call('folders.list', at === undefined ? {} : { path: at }).then(
      (v) => {
        if (!live) return;
        setView(v);
        setError(undefined);
      },
      (err: Error) => {
        if (!live) return;
        setError(err.message);
        // A typed path that does not exist: fall back to the home folder.
        if (at !== undefined) setAt(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, at]);
  const join = (base: string, name: string) => `${base.replace(/[\\/]+$/, '')}${base.includes('\\') && !base.includes('/') ? '\\' : '/'}${name}`;
  return (
    <div className="folder-browser" role="dialog" aria-label="Choose a folder">
      <p className="folder-at">
        <code>{view?.path ?? '…'}</code>
      </p>
      {error && <p className="error">{error}</p>}
      <ul>
        {view?.parent && (
          <li>
            <button type="button" className="text" onClick={() => setAt(view.parent)}>
              ↑ up
            </button>
          </li>
        )}
        {view?.folders.map((f) => (
          <li key={f}>
            <button type="button" className="text" onClick={() => setAt(join(view.path, f))}>
              {f}/
            </button>
          </li>
        ))}
        {view && view.folders.length === 0 && <li className="quiet">No folders here.</li>}
      </ul>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!view} onClick={() => view && onPick(view.path)}>
          Use this folder
        </button>
      </div>
    </div>
  );
}

/**
 * A folder of the learner's machine (a project's workspace): picked with the system's dialog in
 * the desktop app, with the in-app browser elsewhere, or typed.
 */
export function FolderField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [browsing, setBrowsing] = useState(false);
  const choose = async () => {
    const pick = window.__APP_SHELL__?.pickFolder;
    if (!pick) return setBrowsing(true);
    const chosen = await pick(value || undefined);
    if (chosen) onChange(chosen);
  };
  return (
    <div className="folder-field">
      <label>
        {label}
        <span className="folder-row">
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
          <button type="button" onClick={() => void choose()}>
            Choose…
          </button>
        </span>
      </label>
      {browsing && (
        <FolderBrowser
          start={value}
          onClose={() => setBrowsing(false)}
          onPick={(p) => {
            onChange(p);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}

/** Folders are separated by commas or lines; commands by lines only (a command may hold a comma). */
const split = (s: string, by: RegExp) =>
  s
    .split(by)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * What the tutor may do in the workspace, as a checklist with details. Shown when a project is
 * created and in its settings. The app enforces it: a write outside what is allowed is refused,
 * and edits to the learner's own files always wait for their review.
 */
export function PermissionsEditor({ value, onChange }: { value: AgentPermissions; onChange: (p: AgentPermissions) => void }) {
  const set = <K extends keyof AgentPermissions>(k: K, v: AgentPermissions[K]) => onChange({ ...value, [k]: v });
  // Typed as text, kept as lists: the text is what the learner is editing.
  const [tools, setTools] = useState(value.toolDirs.join(', '));
  const [commands, setCommands] = useState(value.commands.join('\n'));
  return (
    <fieldset className="permissions">
      <legend>What your tutor may do in this folder</legend>
      <p className="quiet">
        Your tutor reads your code to teach. It never writes the code a lesson asks you to write, and you can review and undo every file it writes.
      </p>
      <label className="check">
        <input type="checkbox" checked={value.tests} onChange={(e) => set('tests', e.target.checked)} />
        <span>
          Write tests, in a folder of their own (tests that use your code from outside, never edit it)
          {value.tests && <input aria-label="Tests folder" value={value.testsDir} onChange={(e) => set('testsDir', e.target.value)} />}
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.tools} onChange={(e) => set('tools', e.target.checked)} />
        <span>
          Write supporting code you are not here to learn (a viewer, plots, benchmarks), in these folders
          {value.tools && (
            <input
              aria-label="Tool folders"
              placeholder="viewer, tools/plots"
              value={tools}
              onChange={(e) => {
                setTools(e.target.value);
                set('toolDirs', split(e.target.value, /\n|,/));
              }}
            />
          )}
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.measure} onChange={(e) => set('measure', e.target.checked)} />
        <span>
          Run your tests, and these commands, to take measurements (one per line, no shell)
          {value.measure && (
            <textarea
              aria-label="Commands"
              rows={2}
              placeholder="./build/bench --quick"
              value={commands}
              onChange={(e) => {
                setCommands(e.target.value);
                set('commands', split(e.target.value, /\n/));
              }}
            />
          )}
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.editMine} onChange={(e) => set('editMine', e.target.checked)} />
        <span>Propose edits to my own files, e.g. adding the tests to the build (each one waits for my review)</span>
      </label>
      <label>
        Anything else it should know about what it may and may not do
        <textarea rows={2} value={value.notes} placeholder="The viewer is yours to write; the physics library is mine." onChange={(e) => set('notes', e.target.value)} />
      </label>
    </fieldset>
  );
}

export const defaultPermissions = (): AgentPermissions => structuredClone(DEFAULT_PERMISSIONS);
