import { useState } from 'react';
import type { ProjectDTO } from '@app/server/protocol';
import type { AgentPermissions } from '@app/catalog';
import { useQuery, useRpc } from '../hooks.tsx';
import { AddFilesButton, FileDrop, formatSize, uploadFile } from '../sources.tsx';
import { FolderField, PermissionsEditor, defaultPermissions } from './ProjectFields.tsx';

function NewProject({ onCreated, onCancel }: { onCreated: (p: ProjectDTO) => void; onCancel: () => void }) {
  const rpc = useRpc();
  const [f, setF] = useState({ title: '', goal: '', why: '', workspace: '', testCommand: '' });
  const [permissions, setPermissions] = useState<AgentPermissions>(defaultPermissions);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const addFiles = (more: File[]) => setFiles((xs) => [...xs, ...more.filter((m) => !xs.some((x) => x.name === m.name && x.size === m.size))]);
  return (
    <form
      className="new-project"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        let project: ProjectDTO;
        try {
          setBusy('Creating the project…');
          project = await rpc.call('projects.create', {
            title: f.title,
            goal: f.goal,
            why: f.why,
            ...(f.workspace.trim() ? { workspace: f.workspace.trim(), agent: permissions } : {}),
            ...(f.testCommand.trim() ? { testCommand: f.testCommand.trim() } : {}),
          });
        } catch (err) {
          setBusy(undefined);
          setError((err as Error).message);
          return;
        }
        // The project exists: a file that cannot be added is reported, and can be added again later.
        const failed: string[] = [];
        for (const [i, file] of files.entries()) {
          setBusy(`Adding ${file.name} (${i + 1} of ${files.length})…`);
          try {
            await uploadFile(rpc, project.id, file);
          } catch (err) {
            failed.push(`${file.name}: ${(err as Error).message}`);
          }
        }
        setBusy(undefined);
        if (failed.length) {
          setError(`The project was created, but some files could not be added (add them again from the tutor):\n${failed.join('\n')}`);
          setTimeout(() => onCreated(project), 2500);
          return;
        }
        onCreated(project);
      }}
    >
      <h1>New project</h1>
      <label>
        What do you want to build or understand?
        <input required value={f.title} onChange={set('title')} placeholder="A reduced-coordinate physics engine" />
      </label>
      <label>
        Describe the goal
        <textarea required rows={3} value={f.goal} onChange={set('goal')} placeholder="What should you be able to do at the end?" />
      </label>
      <label>
        Why does it matter to you?
        <textarea rows={2} value={f.why} onChange={set('why')} placeholder="Your tutor will connect every lesson back to this." />
      </label>
      <fieldset>
        <legend>Your code (optional): a new or an existing folder</legend>
        <FolderField label="Workspace folder" value={f.workspace} onChange={(workspace) => setF({ ...f, workspace })} placeholder="/home/you/dev/my-engine" />
        <label>
          Test command
          <input value={f.testCommand} onChange={set('testCommand')} placeholder="ctest --test-dir build -R {suite}" />
        </label>
        <p className="quiet">Runs in the workspace folder, without a shell. Write {'{suite}'} where a task's test filter goes, or leave it out to run everything.</p>
        {f.workspace.trim() && <PermissionsEditor value={permissions} onChange={setPermissions} />}
      </fieldset>
      <fieldset>
        <legend>Files to learn from (optional)</legend>
        <FileDrop onFiles={addFiles} className="new-files">
          <p className="quiet">
            Papers, notes, old lessons, code from elsewhere: drop them here. They are copied into the project, so you can move or delete the originals. You can add
            more at any time in the tutor chat.
          </p>
          {files.length > 0 && (
            <ul className="attached" aria-label="Files to add">
              {files.map((file) => (
                <li key={`${file.name}:${file.size}`}>
                  <span className="name">{file.name}</span>
                  <span className="quiet"> {formatSize(file.size)}</span>
                  <button type="button" className="text" aria-label={`Do not add ${file.name}`} onClick={() => setFiles((xs) => xs.filter((x) => x !== file))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <AddFilesButton onFiles={addFiles} label="Choose files" />
        </FileDrop>
      </fieldset>
      <div className="actions">
        {busy && (
          <span className="quiet" role="status">
            {busy}
          </span>
        )}
        <button type="button" onClick={onCancel} disabled={busy !== undefined}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy !== undefined}>
          Create project
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function Home({ onOpen }: { onOpen: (p: ProjectDTO) => void }) {
  const projects = useQuery('projects.list', {}, ['projects']);
  const reviews = useQuery('reviews.summary', {}, ['reviews', 'projects']);
  const [creating, setCreating] = useState(false);
  if (creating) return <main className="screen"><NewProject onCreated={onOpen} onCancel={() => setCreating(false)} /></main>;
  return (
    <main className="screen">
      <h1>Projects</h1>
      <ul className="projects">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <button type="button" className="row" onClick={() => onOpen(p)}>
              <span className="row-title">{p.title}</span>
              <span className="row-sub">{p.goal}</span>
              <span className="row-meta">
                {(reviews.data?.[p.id]?.due ?? 0) > 0 && <span className="due">{reviews.data![p.id]!.due} to review · </span>}
                {p.workspace ? 'code' : 'study'}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="row new" onClick={() => setCreating(true)}>
            + Start a new project
          </button>
        </li>
      </ul>
    </main>
  );
}
