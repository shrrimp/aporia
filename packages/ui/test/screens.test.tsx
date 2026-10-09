// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HistoryItemDTO, ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { App } from '../src/App.tsx';
import { HistoryPanel } from '../src/screens/HistoryPanel.tsx';
import { MePanel } from '../src/screens/MePanel.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { DEFAULT_PERMISSIONS } from '@app/catalog';
import { FakeRpc } from './fake-rpc.ts';

const profile: ProfileDTO = { id: 'prof_1', displayName: 'Jules', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } };
const project: ProjectDTO = { id: 'hmp-abc123', title: 'Heavy Metal Physics', goal: 'Featherstone', why: 'engine', createdAt: '2026-10-05T10:00:00.000Z' };

function baseRpc() {
  return new FakeRpc()
    .handle('app.info', () => ({ name: 'Aporia', id: 'aporia', tagline: 'Learn by doing.', agent: 'Fake' }))
    .handle('profiles.list', () => [profile])
    .handle('profiles.open', () => profile)
    .handle('profiles.create', ({ displayName }) => ({ ...profile, id: 'prof_2', displayName }))
    .handle('projects.list', () => [project])
    .handle('lessons.list', () => [{ id: 'hmp-09-four-numbers', title: 'Four Numbers, Three Speeds', kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
    .handle('lessons.get', () => fourNumbers)
    .handle('history.list', () => [])
    .handle('learner.summary', () => ({ kcs: [], insights: [], recentSuccess: { correct: 0, total: 0 } }))
    .handle('answers.record', () => ({ id: 'ev_1' }));
}

const mount = (rpc: FakeRpc, ui: React.ReactNode) => render(<RpcProvider client={rpc.asClient()}>{ui}</RpcProvider>);

describe('App flow', () => {
  it('goes from profile to project to lesson, and back', async () => {
    const user = userEvent.setup();
    const rpc = baseRpc();
    mount(rpc, <App />);
    expect(await screen.findByText('Aporia')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Jules/ }));
    await user.click(await screen.findByRole('button', { name: /Heavy Metal Physics/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Four Numbers, Three Speeds' })).toBeInTheDocument();
    await user.click(screen.getByLabelText('The force rule'));
    await user.click(screen.getByRole('radio', { name: 'Sure' }));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(rpc.calls.find((c) => c.method === 'answers.record')!.params).toMatchObject({ projectId: project.id, lessonId: 'hmp-09-four-numbers', itemId: 'w1', outcome: 1 });
    await user.click(screen.getByRole('button', { name: 'You' }));
    expect(await screen.findByText(/No evidence yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^History/ }));
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: /switch/ }));
    expect(await screen.findByRole('heading', { name: 'Who is learning?' })).toBeInTheDocument();
  });

  it('shows connection status changes', async () => {
    const rpc = baseRpc();
    mount(rpc, <App />);
    act(() => rpc.setStatus('closed'));
    expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();
    act(() => rpc.setStatus('connecting'));
    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
  });

  it('creates profiles and projects, and reports errors', async () => {
    const user = userEvent.setup();
    const rpc = baseRpc().handle('projects.list', () => []);
    mount(rpc, <App />);
    await user.type(await screen.findByPlaceholderText('Your name'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(rpc.calls.some((c) => c.method === 'profiles.create')).toBe(true);
    await user.click(await screen.findByRole('button', { name: '+ Start a new project' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: '+ Start a new project' }));
    await user.type(screen.getByLabelText(/What do you want/), 'Rust CLI');
    await user.type(screen.getByLabelText('Describe the goal'), 'Ship a CLI');
    await user.type(screen.getByLabelText('Workspace folder'), '/tmp/ws');
    await user.type(screen.getByLabelText('Test command'), 'cargo test');
    rpc.handle('projects.create', () => {
      throw new RpcFailure({ code: 'invalid_params', message: 'bad project' });
    });
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad project');
    rpc.handle('projects.create', (p) => ({ ...project, ...p, id: 'rust-cli-1' })).handle('lessons.list', () => []);
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(rpc.calls.filter((c) => c.method === 'projects.create').at(-1)!.params).toEqual({
      title: 'Rust CLI',
      goal: 'Ship a CLI',
      why: '',
      workspace: '/tmp/ws',
      testCommand: 'cargo test',
      agent: DEFAULT_PERMISSIONS,
    });
    expect(await screen.findByText(/Lessons appear here/)).toBeInTheDocument();
    rpc.handle('ask', () => ({ askId: 'a1' }));
    // A folder of existing work: the tutor starts from it (or from scratch, if the learner prefers).
    await user.click(screen.getByRole('button', { name: 'Start from my existing work' }));
    expect(rpc.calls.find((c) => c.method === 'ask')!.params).toMatchObject({ projectId: 'rust-cli-1', question: expect.stringMatching(/I already have work/) });

  });

  it('reports profile errors', async () => {
    const user = userEvent.setup();
    const rpc = baseRpc()
      .handle('profiles.open', () => {
        throw new RpcFailure({ code: 'conflict', message: 'in use' });
      })
      .handle('profiles.create', () => {
        throw new RpcFailure({ code: 'invalid_params', message: 'bad name' });
      });
    mount(rpc, <App />);
    await user.click(await screen.findByRole('button', { name: /Jules/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('in use');
    await user.type(screen.getByPlaceholderText('Your name'), 'X');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad name');
  });

  it('shows unreadable lessons instead of crashing', async () => {
    const user = userEvent.setup();
    mount(baseRpc().handle('lessons.get', () => ({ nope: 1 })), <App />);
    await user.click(await screen.findByRole('button', { name: /Jules/ }));
    await user.click(await screen.findByRole('button', { name: /Heavy Metal Physics/ }));
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
  });
});

describe('HistoryPanel', () => {
  const item = (over: Partial<HistoryItemDTO>): HistoryItemDTO => ({
    id: 'chg_1',
    kind: 'change',
    at: '2026-10-05T10:00:00.000Z',
    author: { kind: 'agent', agent: 'claude', model: 'opus', session: 's1' },
    summary: 'new lesson',
    status: 'applied',
    ...over,
  });

  it('accepts, rejects, redoes, and undoes whole sessions', async () => {
    const user = userEvent.setup();
    const rpc = baseRpc()
      .handle('history.list', () => [
        item({ id: 'chg_p', status: 'proposed', summary: 'proposed one' }),
        item({ id: 'chg_r', status: 'reverted', author: { kind: 'learner' } }),
        item({ id: 'ev_1', kind: 'observation', status: 'revoked', author: { kind: 'system' } }),
        item({ id: 'chg_a', author: { kind: 'agent' } }),
      ])
      .handle('history.accept', ({ id }) => ({ id }))
      .handle('history.reject', ({ id }) => ({ id }))
      .handle('history.redo', ({ id }) => ({ id }));
    mount(rpc, <HistoryPanel />);
    expect(await screen.findByText('1 change(s) waiting for your review')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(screen.getAllByRole('button', { name: 'Redo' })[0]!);
    expect(rpc.calls.map((c) => c.method)).toEqual(expect.arrayContaining(['history.accept', 'history.reject', 'history.redo']));
    expect(screen.getByText(/you ·/)).toBeInTheDocument();
    expect(screen.getByText(/the app ·/)).toBeInTheDocument();
  });

  it('asks before undoing dependants, and shows other errors', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const rpc = baseRpc()
      .handle('history.list', () => [item({})])
      .handle('history.undo', ({ withDependants }) => {
        attempt++;
        if (attempt === 1) throw new RpcFailure({ code: 'dependants', message: 'deps', data: { dependants: ['chg_2'] } });
        if (!withDependants) throw new RpcFailure({ code: 'conflict', message: 'cannot' });
        return { undone: ['chg_2', 'chg_1'] };
      })
      .handle('history.undoWhere', () => ({ undone: [] }));
    mount(rpc, <HistoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('1 later change(s) build on this one');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot');
    attempt = 0;
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await user.click(await screen.findByRole('button', { name: 'Undo all 2' }));
    expect(rpc.calls.filter((c) => c.method === 'history.undo').at(-1)!.params).toEqual({ id: 'chg_1', withDependants: true });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Undo this whole session' }));
    expect(rpc.calls.find((c) => c.method === 'history.undoWhere')!.params).toEqual({ filter: { session: 's1' } });
  });

  it('has no keyboard shortcut for undo (D4)', async () => {
    const user = userEvent.setup();
    const rpc = baseRpc().handle('history.list', () => [item({})]);
    mount(rpc, <HistoryPanel />);
    await screen.findByRole('button', { name: 'Undo' });
    await user.keyboard('{Control>}z{/Control}{Meta>}z{/Meta}');
    expect(rpc.calls.some((c) => c.method === 'history.undo')).toBe(false);
  });
});

describe('MePanel', () => {
  it('shows skills, insights and changes settings', async () => {
    const user = userEvent.setup();
    const rpc = baseRpc()
      .handle('learner.summary', () => ({
        kcs: [{ kc: 'quaternion.unit', band: 'solid', mastery: 'durable', confidence: 0.7 }, { kc: 'x.y', band: 'new', mastery: 'weird', confidence: 0 }],
        insights: [{ id: 'ins_1', text: 'Maths first', trust: 0.8, scope: 'global' }],
        recentSuccess: { correct: 3, total: 4 },
      }))
      .handle('profiles.updateSettings', (s) => ({ ...profile, settings: { ...profile.settings, ...s } }));
    const updates: ProfileDTO[] = [];
    mount(rpc, <MePanel profile={profile} onSettings={(p) => updates.push(p)} />);
    expect(await screen.findByText('learned — it stuck')).toBeInTheDocument();
    expect(screen.getByText('weird')).toBeInTheDocument();
    expect(screen.getByText(/Recent first tries: 3\/4/)).toBeInTheDocument();
    expect(screen.getByText('Maths first')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    const [memory, reviews] = screen.getAllByRole('combobox');
    await user.selectOptions(memory!, 'interaction');
    await waitFor(() => expect(updates.map((u) => u.settings.changeMode)).toContain('auto'));
    expect(updates.at(-1)!.settings.sessionMode).toBe('interaction');
    expect(reviews).toHaveValue('pool');
    await user.selectOptions(reviews!, 'when-due');
    await waitFor(() => expect(updates.at(-1)!.settings.reviewQuestions).toBe('when-due'));
  });
});

describe('coming back after a restart', () => {
  function placed(place: Record<string, unknown>) {
    const sets: Record<string, unknown>[] = [];
    const rpc = baseRpc()
      .handle('place.get', () => place)
      .handle('place.set', (p: Record<string, unknown>) => {
        sets.push(p);
        return {};
      });
    return { rpc, sets };
  }

  it('opens the profile, project, lesson and panel the learner was on, and remembers moves', async () => {
    const user = userEvent.setup();
    const { rpc, sets } = placed({ profileId: profile.id, projectId: project.id, view: 'lesson', lessonId: 'hmp-09-four-numbers', margin: 'me' });
    mount(rpc, <App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Four Numbers, Three Speeds' })).toBeInTheDocument();
    expect(await screen.findByText(/No evidence yet/)).toBeInTheDocument();
    await waitFor(() => expect(sets.at(-1)).toEqual({ view: 'lesson', lessonId: 'hmp-09-four-numbers', margin: 'me', editor: false, file: null }));
    await user.click(screen.getByRole('button', { name: /^History/ }));
    await waitFor(() => expect(sets.at(-1)).toMatchObject({ margin: 'history' }));
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(sets.at(-1)).toEqual({ projectId: null, view: null, lessonId: null, margin: null, editor: null, file: null });
  });

  it('keeps the workspace layout, in every project and across restarts', async () => {
    const user = userEvent.setup();
    const { rpc, sets } = placed({ profileId: profile.id, projectId: project.id, layout: { contents: 300, folded: true } });
    mount(rpc, <App />);
    expect(await screen.findByRole('separator', { name: 'Resize the contents' })).toHaveAttribute('aria-valuenow', '56');
    await user.click(screen.getByRole('button', { name: 'Expand contents' }));
    expect(sets.at(-1)).toEqual({ layout: { contents: 300, folded: false } });
    expect(screen.getByRole('separator', { name: 'Resize the contents' })).toHaveAttribute('aria-valuenow', '300');
    // Another project opens with the same layout.
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: new RegExp(project.title) }));
    expect(await screen.findByRole('separator', { name: 'Resize the contents' })).toHaveAttribute('aria-valuenow', '300');
  });

  it('opens the first lesson when the remembered one is gone', async () => {
    const { rpc } = placed({ profileId: profile.id, projectId: project.id, view: 'lesson', lessonId: 'deleted-lesson' });
    mount(rpc, <App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Four Numbers, Three Speeds' })).toBeInTheDocument();
    expect(rpc.calls.filter((c) => c.method === 'lessons.get').map((c) => (c.params as { lessonId: string }).lessonId)).not.toContain('deleted-lesson');
  });

  it('opens the project list when the project is gone, and the picker when the profile cannot be opened', async () => {
    const user = userEvent.setup();
    const gone = placed({ profileId: profile.id, projectId: 'deleted' });
    const view = mount(gone.rpc, <App />);
    expect(await screen.findByRole('button', { name: /Heavy Metal Physics/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /switch/ }));
    expect(gone.sets.at(-1)).toEqual({ profileId: null });
    view.unmount();

    const locked = placed({ profileId: profile.id });
    locked.rpc.handle('profiles.open', () => {
      throw new RpcFailure({ code: 'conflict', message: 'open in another window' });
    });
    mount(locked.rpc, <App />);
    expect(await screen.findByRole('heading', { name: 'Who is learning?' })).toBeInTheDocument();
  });
});
