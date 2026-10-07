import { useState } from 'react';
import { agentPermissions, type AgentPermissions } from '@app/catalog';
import type { ProjectDTO, SourceDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';
import { AddFilesButton, AttachedList, FileDrop, formatSize, useAttach } from '../sources.tsx';
import { FolderField, PermissionsEditor } from './ProjectFields.tsx';

/** The files imported into the project: see what the tutor reads, add more, take one out (undoable in History). */
function ImportedFiles({ projectId }: { projectId: string }) {
  const rpc = useRpc();
  const sources = useQuery('sources.list', { projectId }, ['sources']);
  const attach = useAttach(rpc, projectId);
  const [preview, setPreview] = useState<{ source: SourceDTO; text: string; truncated: boolean }>();
  const [error, setError] = useState<string>();
  const show = async (source: SourceDTO) => {
    setError(undefined);
    try {
      setPreview({ source, ...(await rpc.call('sources.text', { projectId, sourceId: source.id })) });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="imported" aria-label="Imported files">
      <h3>Imported files</h3>
      <FileDrop onFiles={(files) => void attach.add(files)}>
        {sources.data?.length === 0 && <p className="quiet">None yet. Drop files here, or add them in the tutor chat.</p>}
        <ul className="sources">
          {sources.data?.map((s) => (
            <li key={s.id}>
              <button type="button" className="text" onClick={() => void show(s)}>
                {s.name}
              </button>
              <span className="quiet">
                {' '}
                {s.kind}
                {s.pages ? `, ${s.pages} pages` : ''}, {formatSize(s.size)}
                {s.note ? ` · ${s.note}` : ''}
              </span>
              <button
                type="button"
                className="text remove"
                aria-label={`Remove ${s.name}`}
                onClick={() => void rpc.call('sources.remove', { projectId, sourceId: s.id }).catch((err: Error) => setError(err.message))}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
        <AttachedList items={attach.items} />
        <AddFilesButton onFiles={(files) => void attach.add(files)} />
      </FileDrop>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="source-preview" role="region" aria-label={`Text of ${preview.source.name}`}>
          <p>
            What your tutor reads in <strong>{preview.source.name}</strong>
            {preview.truncated ? ' (the beginning of it)' : ''}:{' '}
            <button type="button" className="text" onClick={() => setPreview(undefined)}>
              close
            </button>
          </p>
          <pre>{preview.text || '(no text)'}</pre>
        </div>
      )}
    </section>
  );
}

/** The learner's own project settings: the goal, where and how its tests run, and what the tutor may do. Only the learner sets these. */
export function ProjectSettings({ project }: { project: ProjectDTO }) {
  const rpc = useRpc();
  const [f, setF] = useState({ goal: project.goal, why: project.why, workspace: project.workspace ?? '', testCommand: project.testCommand ?? '' });
  const [permissions, setPermissions] = useState<AgentPermissions>(() => agentPermissions.parse(project.agent ?? {}));
  const [state, setState] = useState<{ saved?: boolean; error?: string }>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value });
    setState({});
  };
  return (
    <div className="project-settings-wrap">
      <form
        className="project-settings"
        aria-label="Project settings"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await rpc.call('projects.update', {
              projectId: project.id,
              goal: f.goal,
              why: f.why,
              workspace: f.workspace.trim(),
              testCommand: f.testCommand.trim(),
              agent: permissions,
            });
            setState({ saved: true });
          } catch (err) {
            setState({ error: (err as Error).message });
          }
        }}
      >
        <h2>Project</h2>
        <label>
          Goal
          <textarea required rows={3} value={f.goal} onChange={set('goal')} />
        </label>
        <label>
          Why it matters to you
          <textarea rows={2} value={f.why} onChange={set('why')} />
        </label>
        <FolderField
          label="Workspace folder"
          value={f.workspace}
          placeholder="/home/you/dev/my-engine"
          onChange={(workspace) => {
            setF({ ...f, workspace });
            setState({});
          }}
        />
        <label>
          Test command
          <input value={f.testCommand} onChange={set('testCommand')} placeholder="ctest --test-dir build -R {suite}" />
        </label>
        <p className="quiet">
          Runs in the workspace folder when you run a checkpoint, without a shell. Write <code>{'{suite}'}</code> where a task's test filter should go, or leave
          it out to run everything. For several steps, put them in a script.
        </p>
        {f.workspace.trim() && (
          <PermissionsEditor
            value={permissions}
            onChange={(p) => {
              setPermissions(p);
              setState({});
            }}
          />
        )}
        <div className="actions">
          <button type="submit" className="primary">
            Save
          </button>
          {state.saved && (
            <span className="quiet" role="status">
              Saved.
            </span>
          )}
        </div>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
      </form>
      <ImportedFiles projectId={project.id} />
    </div>
  );
}
