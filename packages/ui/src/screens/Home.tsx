import { useState } from 'react';
import type { ProjectDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';

function NewProject({ onCreated, onCancel }: { onCreated: (p: ProjectDTO) => void; onCancel: () => void }) {
  const rpc = useRpc();
  const [f, setF] = useState({ title: '', goal: '', why: '', workspace: '', testCommand: '' });
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="new-project"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          onCreated(
            await rpc.call('projects.create', {
              title: f.title,
              goal: f.goal,
              why: f.why,
              ...(f.workspace.trim() ? { workspace: f.workspace.trim() } : {}),
              ...(f.testCommand.trim() ? { testCommand: f.testCommand.trim() } : {}),
            }),
          );
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <h2>Start a new project</h2>
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
        <legend>Coding project? (optional)</legend>
        <label>
          Workspace folder
          <input value={f.workspace} onChange={set('workspace')} placeholder="/home/you/dev/my-engine" />
        </label>
        <label>
          Test command
          <input value={f.testCommand} onChange={set('testCommand')} placeholder="ctest --test-dir build" />
        </label>
      </fieldset>
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit">Create project</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

export function Home({ onOpen }: { onOpen: (p: ProjectDTO) => void }) {
  const projects = useQuery('projects.list', {}, ['projects']);
  const [creating, setCreating] = useState(false);
  if (creating) return <main className="screen"><NewProject onCreated={onOpen} onCancel={() => setCreating(false)} /></main>;
  return (
    <main className="screen">
      <h1>Your projects</h1>
      <ul className="projects">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onOpen(p)}>
              <strong>{p.title}</strong>
              <span>{p.goal}</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="new" onClick={() => setCreating(true)}>+ Start a new project</button>
        </li>
      </ul>
    </main>
  );
}
