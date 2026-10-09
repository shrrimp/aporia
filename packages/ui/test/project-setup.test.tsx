// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { DEFAULT_PERMISSIONS, type AgentPermissions } from '@app/catalog';
import type { HistoryItemDTO, ProjectDTO, SourceDTO } from '@app/server/protocol';
import { RpcProvider } from '../src/hooks.tsx';
import { Home } from '../src/screens/Home.tsx';
import { FolderField, PermissionsEditor } from '../src/screens/ProjectFields.tsx';
import { ChangeDiff, Proposals, concerns, describeTarget } from '../src/screens/Proposals.tsx';
import { ProjectSettings } from '../src/screens/ProjectSettings.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { FakeRpc } from './fake-rpc.ts';

afterEach(() => {
  delete window.__APP_SHELL__;
});

function Field({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <FolderField label="Workspace folder" value={v} onChange={setV} />;
}

describe('choosing a folder', () => {
  it("uses the desktop app's own dialog", async () => {
    const user = userEvent.setup();
    const pickFolder = vi.fn().mockResolvedValueOnce('/home/me/dev/engine').mockResolvedValueOnce(null);
    window.__APP_SHELL__ = { platform: 'linux', pickFolder };
    render(<Field initial="/home/me" />);
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    await waitFor(() => expect(screen.getByLabelText('Workspace folder')).toHaveValue('/home/me/dev/engine'));
    expect(pickFolder).toHaveBeenCalledWith('/home/me');
    await user.click(screen.getByRole('button', { name: 'Choose…' })); // cancelled: unchanged
    expect(screen.getByLabelText('Workspace folder')).toHaveValue('/home/me/dev/engine');
  });

  it('browses folders inside the app elsewhere', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc().handle('folders.list', ({ path }: { path?: string }) => {
      if (path === '/nope') throw new RpcFailure({ code: 'not_found', message: 'no folder /nope' });
      if (path === '/home/me/dev') return { path: '/home/me/dev', parent: '/home/me', folders: [] };
      if (path === 'C:\\Users') return { path: 'C:\\Users', folders: ['me'] };
      return { path: '/home/me', parent: '/home', folders: ['dev', 'docs'] };
    });
    const { unmount } = render(
      <RpcProvider client={r.asClient()}>
        <Field initial="/nope" />
      </RpcProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a folder' });
    expect(await within(dialog).findByText('/home/me')).toBeInTheDocument(); // the typed path did not exist: home instead
    await user.click(within(dialog).getByRole('button', { name: 'dev/' }));
    expect(await within(dialog).findByText('No folders here.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '↑ up' }));
    await within(dialog).findByRole('button', { name: 'docs/' });
    await user.click(within(dialog).getByRole('button', { name: 'Use this folder' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Workspace folder')).toHaveValue('/home/me');
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    // Windows paths join with a backslash.
    render(
      <RpcProvider client={r.asClient()}>
        <Field initial={'C:\\Users'} />
      </RpcProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    await user.click(await screen.findByRole('button', { name: 'me/' }));
    await waitFor(() => expect(r.calls.at(-1)!.params).toEqual({ path: 'C:\\Users\\me' }));
  });
});

describe('what the tutor may do', () => {
  it('is a checklist with the details that matter', async () => {
    const user = userEvent.setup();
    const seen: AgentPermissions[] = [];
    function Editor() {
      const [p, setP] = useState<AgentPermissions>(DEFAULT_PERMISSIONS);
      return (
        <PermissionsEditor
          value={p}
          onChange={(next) => {
            seen.push(next);
            setP(next);
          }}
        />
      );
    }
    render(<Editor />);
    expect(screen.getByRole('checkbox', { name: /Write tests/ })).toBeChecked();
    await user.clear(screen.getByLabelText('Tests folder'));
    await user.type(screen.getByLabelText('Tests folder'), 'tests/aporia');
    await user.click(screen.getByRole('checkbox', { name: /Write supporting code/ }));
    await user.type(screen.getByLabelText('Tool folders'), 'viewer, tools/plots');
    await user.click(screen.getByRole('checkbox', { name: /Run your tests/ }));
    await user.type(screen.getByLabelText('Commands'), './build/bench --a,b{enter}./sim');
    await user.click(screen.getByRole('checkbox', { name: /Propose edits to my own files/ }));
    await user.type(screen.getByLabelText(/Anything else/), 'The viewer is yours.');
    expect(seen.at(-1)).toEqual({
      tests: true,
      testsDir: 'tests/aporia',
      tools: true,
      toolDirs: ['viewer', 'tools/plots'],
      measure: true,
      commands: ['./build/bench --a,b', './sim'],
      editMine: true,
      notes: 'The viewer is yours.',
    });
    await user.click(screen.getByRole('checkbox', { name: /Write tests/ }));
    expect(screen.queryByLabelText('Tests folder')).toBeNull();
  });

  it('is saved with the project settings', async () => {
    const user = userEvent.setup();
    const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', workspace: '/w', agent: { ...DEFAULT_PERMISSIONS, tools: true, toolDirs: ['viewer'] }, createdAt: '' };
    const r = new FakeRpc().handle('sources.list', () => []).handle('projects.update', (p) => ({ ...project, ...p }));
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectSettings project={project} />
      </RpcProvider>,
    );
    expect(screen.getByLabelText('Tool folders')).toHaveValue('viewer');
    await user.click(screen.getByRole('checkbox', { name: /Run your tests/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(r.calls.find((c) => c.method === 'projects.update')!.params).toMatchObject({ agent: { measure: true, tools: true, toolDirs: ['viewer'] } });
    await user.click(screen.getByRole('checkbox', { name: /Run your tests/ }));
    expect(screen.queryByText('Saved.')).toBeNull();
  });
});

describe('a new project with existing work', () => {
  const created: ProjectDTO = { id: 'engine-1', title: 'Engine', goal: 'g', why: '', workspace: '/home/me/engine', createdAt: '' };
  function rpc() {
    let n = 0;
    return new FakeRpc()
      .handle('projects.list', () => [])
      .handle('projects.create', () => created)
      .handle('sources.begin', ({ name }) => {
        if (name === 'broken.pdf') throw new RpcFailure({ code: 'invalid_params', message: 'unreadable' });
        return { uploadId: `u${++n}` };
      })
      .handle('sources.chunk', () => ({ received: 1 }))
      .handle('sources.finish', () => ({ id: `src_${n}`, name: 'x', kind: 'text', size: 1, chars: 1, addedAt: '', existed: false }) as SourceDTO & { existed: boolean });
  }

  it('takes a folder, permissions and files, then adds the files to the new project', async () => {
    const user = userEvent.setup();
    const r = rpc();
    const onOpen = vi.fn();
    render(
      <RpcProvider client={r.asClient()}>
        <Home onOpen={onOpen} />
      </RpcProvider>,
    );
    await user.click(await screen.findByRole('button', { name: '+ Start a new project' }));
    await user.type(screen.getByLabelText(/What do you want/), 'Engine');
    await user.type(screen.getByLabelText('Describe the goal'), 'g');
    expect(screen.queryByRole('group', { name: /What your tutor may do/ })).toBeNull();
    await user.type(screen.getByLabelText('Workspace folder'), '/home/me/engine');
    await user.click(screen.getByRole('checkbox', { name: /Write supporting code/ }));
    await user.type(screen.getByLabelText('Tool folders'), 'viewer');
    const lessons = [new File(['<h1>01</h1>'], 'lesson-01.html'), new File(['n'], 'notes.md')];
    await user.upload(screen.getByLabelText('Choose files'), lessons);
    await user.upload(screen.getByLabelText('Choose files'), [new File(['n'], 'notes.md')]); // the same file twice is listed once
    expect(within(screen.getByRole('list', { name: 'Files to add' })).getAllByRole('listitem')).toHaveLength(2);
    await user.upload(screen.getByLabelText('Choose files'), [new File(['x'], 'oops.txt')]);
    await user.click(screen.getByRole('button', { name: 'Do not add oops.txt' }));
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(created));
    expect(r.calls.find((c) => c.method === 'projects.create')!.params).toMatchObject({ workspace: '/home/me/engine', agent: { tools: true, toolDirs: ['viewer'] } });
    expect(r.calls.filter((c) => c.method === 'sources.begin').map((c) => (c.params as { name: string }).name)).toEqual(['lesson-01.html', 'notes.md']);
  });

  it('opens the project even when a file cannot be added, saying which', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const r = rpc();
      const onOpen = vi.fn();
      render(
        <RpcProvider client={r.asClient()}>
          <Home onOpen={onOpen} />
        </RpcProvider>,
      );
      await user.click(await screen.findByRole('button', { name: '+ Start a new project' }));
      await user.type(screen.getByLabelText(/What do you want/), 'Theory');
      await user.type(screen.getByLabelText('Describe the goal'), 'g');
      await user.upload(screen.getByLabelText('Choose files'), [new File(['%PDF'], 'broken.pdf')]);
      await user.click(screen.getByRole('button', { name: 'Create project' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('broken.pdf: unreadable');
      expect(r.calls.find((c) => c.method === 'projects.create')!.params).not.toHaveProperty('agent'); // no folder: nothing to allow
      vi.advanceTimersByTime(3000);
      await waitFor(() => expect(onOpen).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('looking at a proposed change', () => {
  const pending = (id: string, target: string, summary: string): HistoryItemDTO => ({ id, kind: 'change', at: '', author: { kind: 'agent' }, summary, status: 'proposed', target });

  it('names what it touches and shows the lines it changes', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('history.list', () => [pending('chg_1', 'projects/p/agent-files/abc.json', 'aporia-tests/a.cpp: a test'), pending('chg_2', 'projects/p/roadmap.json', 'roadmap, s1: x')])
      .handle('history.diff', ({ id }) =>
        id === 'chg_1'
          ? { kind: 'file', path: 'aporia-tests/a.cpp', before: null, after: '// a\nint x;' }
          : { kind: 'document', target: 'projects/p/roadmap.json', before: { milestones: {} }, after: { milestones: { s1: { title: 'S1' } } } },
      );
    render(
      <RpcProvider client={r.asClient()}>
        <Proposals />
      </RpcProvider>,
    );
    expect(await screen.findByText(/a file in your workspace/)).toBeInTheDocument();
    expect(screen.getByText(/the roadmap/)).toBeInTheDocument();
    expect(r.calls.some((c) => c.method === 'history.diff')).toBe(false); // nothing loads until opened
    const [first, second] = screen.getAllByText('Show the change');
    await user.click(first!);
    const changes = await screen.findByLabelText('Changes');
    expect(changes).toHaveTextContent('+ // a + int x;');
    expect(screen.getByText('(a new file)')).toBeInTheDocument();
    await user.click(second!);
    await waitFor(() => expect(screen.getAllByLabelText('Changes')).toHaveLength(2));
    expect(screen.getAllByLabelText('Changes')[1]).toHaveTextContent('- "milestones": {} + "milestones": { + "s1": {');
  });

  it('says when it cannot be compared', async () => {
    const r = new FakeRpc().handle('history.diff', ({ id }) => {
      if (id === 'bad') throw new RpcFailure({ code: 'conflict', message: 'no longer applies' });
      return id === 'del' ? { kind: 'file', path: 'x', before: 'a', after: null } : { kind: 'document', target: 't', before: null, after: null };
    });
    const { unmount } = render(
      <RpcProvider client={r.asClient()}>
        <ChangeDiff id="bad" />
      </RpcProvider>,
    );
    expect(await screen.findByText('no longer applies')).toBeInTheDocument();
    unmount();
    const del = render(
      <RpcProvider client={r.asClient()}>
        <ChangeDiff id="del" />
      </RpcProvider>,
    );
    expect(await screen.findByText('(removed)')).toBeInTheDocument();
    del.unmount();
    render(
      <RpcProvider client={r.asClient()}>
        <ChangeDiff id="empty" />
      </RpcProvider>,
    );
    expect(await screen.findByLabelText('Changes')).toBeEmptyDOMElement();
  });

  it('describes every kind of document', () => {
    expect(
      ['projects/p/curriculum.json', 'projects/p/assessment.json', 'projects/p/sources.json', 'learner/skills.json', 'projects/p/project.json', 'projects/p/lessons/l1.json', 'other.json', undefined].map(describeTarget),
    ).toEqual(['the lesson plan', 'what the interview found', 'imported files', 'your skill map', 'project settings', 'lesson “l1”', 'other.json', 'a change']);
  });
});

describe('the first session of a project with existing work', () => {
  it('can still start from scratch', async () => {
    const user = userEvent.setup();
    const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '' };
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [])
      .handle('history.list', () => [])
      .handle('sources.list', () => [{ id: 'src_1', name: 'lesson-01.html', kind: 'html', size: 1, chars: 1, addedAt: '' }])
      .handle('ask', () => ({ askId: 'a1' }));
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={{ id: 'prof_1', displayName: 'J', createdAt: '', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } }} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    expect(await screen.findByText(/You already have work here and 1 imported file\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start from scratch' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({ question: expect.stringMatching(/^Interview me/) });
  });
});

describe('proposals in a project', () => {
  it("show this project's changes and the profile's, never another project's", async () => {
    const r = new FakeRpc().handle('history.list', () => [
      { id: 'a', kind: 'change', at: '', author: { kind: 'agent' }, summary: 'mine', status: 'proposed', target: 'projects/p-1/roadmap.json' },
      { id: 'b', kind: 'change', at: '', author: { kind: 'agent' }, summary: 'other project', status: 'proposed', target: 'projects/p-2/roadmap.json' },
      { id: 'c', kind: 'change', at: '', author: { kind: 'agent' }, summary: 'skill map', status: 'proposed', target: 'learner/skills.json' },
    ]);
    render(
      <RpcProvider client={r.asClient()}>
        <Proposals projectId="p-1" />
      </RpcProvider>,
    );
    expect(await screen.findByText(/mine/)).toBeInTheDocument();
    expect(screen.getByText('· skill map')).toBeInTheDocument();
    expect(screen.queryByText(/other project/)).toBeNull();
    expect(concerns(undefined, 'p-1')).toBe(true);
  });
});
