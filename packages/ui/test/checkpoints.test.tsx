// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CheckpointRunDTO, CheckpointsDTO, ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { DEFAULT_PERMISSIONS } from '@app/catalog';
import { ProjectSettings } from '../src/screens/ProjectSettings.tsx';
import { FakeRpc } from './fake-rpc.ts';

const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false } };
const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', workspace: '/w', testCommand: 'ctest -R {suite}', createdAt: '2026-10-05T10:00:00.000Z' };

const run = (over: { [K in keyof CheckpointRunDTO]?: CheckpointRunDTO[K] | undefined } = {}): CheckpointRunDTO => ({
  id: 'ev_1',
  at: '2026-10-06T10:00:00.000Z',
  counts: { passed: 100, failed: 48, total: 148 },
  expect: { passed: 119, of: 148 },
  reached: false,
  exitCode: 8,
  timedOut: false,
  durationMs: 1234,
  failures: [],
  ...(Object.fromEntries(Object.entries(over)) as Partial<CheckpointRunDTO>),
});

function rpc(list: CheckpointsDTO) {
  let current = list;
  const r = new FakeRpc()
    .handle('projects.list', () => [project])
    .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
    .handle('lessons.get', () => fourNumbers)
    .handle('history.list', () => [])
    .handle('checkpoints.list', () => current)
    .handle('checkpoints.cancel', () => ({ cancelled: true }))
    .handle('projects.update', (p) => ({ ...project, ...p }));
  return Object.assign(r, { set: (l: CheckpointsDTO) => (current = l) });
}

const mount = (r: FakeRpc) =>
  render(
    <RpcProvider client={r.asClient()}>
      <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
    </RpcProvider>,
  );

describe('checkpoints in a task', () => {
  it('runs the checkpoint and shows the result, the ladder, the failing tests and the output', async () => {
    const user = userEvent.setup();
    const r = rpc({ runnable: true, tasks: { 'step-2': { reached: false, runs: 1, recent: [run()] } } });
    r.handle('checkpoints.run', () => {
      const done = run({ id: 'ev_2', counts: { passed: 121, failed: 27, total: 148 }, reached: true, durationMs: 400, failures: ['MultiDof.ball'] });
      r.set({ runnable: true, tasks: { 'step-2': { reached: true, runs: 2, recent: [run(), done] } } });
      return { ...done, output: '121 passed', truncated: true };
    });
    mount(r);
    expect(await screen.findByText('100 of 148 passing')).toBeInTheDocument();
    expect(screen.getByText(/this step expects 119/)).toBeInTheDocument();
    expect(screen.getByText('1.2 s')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run checkpoint' }));
    expect(await screen.findByText('121 of 148 passing')).toBeInTheDocument();
    expect(screen.getByText(/this step is reached/)).toBeInTheDocument();
    expect(screen.getByText('400 ms')).toBeInTheDocument();
    expect(screen.getByText('Failing (1)')).toBeInTheDocument();
    expect(screen.getByText('MultiDof.ball')).toBeInTheDocument();
    expect(screen.getByText('Test output (the end of it)')).toBeInTheDocument();
    expect(screen.getByText('121 passed')).toBeInTheDocument();
    expect(r.calls.find((c) => c.method === 'checkpoints.run')!.params).toEqual({ projectId: 'p-1', lessonId: fourNumbers.id, taskId: 'step-2' });
    // The server says the checkpoints changed: the ladder now has both runs.
    act(() => r.emit('changed', { what: 'checkpoints' }));
    const ladder = await screen.findByRole('list', { name: 'Your runs, oldest first' });
    await waitFor(() => expect(ladder.textContent).toBe('100121'));
  });

  it('describes runs without a summary and runs that took too long', async () => {
    const r = rpc({ runnable: true, tasks: { 'step-2': { reached: false, runs: 2, recent: [run({ timedOut: true, counts: undefined, exitCode: null, durationMs: 15_000 })] } } });
    mount(r);
    expect(await screen.findByText('Stopped: the tests ran too long.')).toBeInTheDocument();
    expect(screen.getByText('15 s')).toBeInTheDocument();
    r.set({ runnable: true, tasks: { 'step-2': { reached: false, runs: 2, recent: [run({ counts: undefined, exitCode: null })] } } });
    act(() => r.emit('changed', { what: 'checkpoints' }));
    expect(await screen.findByText(/exit code none\), but the app could not find a test summary/)).toBeInTheDocument();
  });

  it('can stop a running checkpoint, and blocks a second one', async () => {
    const user = userEvent.setup();
    const r = rpc({ runnable: true, running: 'step-2', tasks: {} });
    // Already finished on the server: stopping it is not an error worth showing.
    r.handle('checkpoints.cancel', () => {
      throw new RpcFailure({ code: 'not_found', message: 'nothing running' });
    });
    mount(r);
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(r.calls.some((c) => c.method === 'checkpoints.cancel')).toBe(true);
    expect(screen.getByText('running your tests…')).toBeInTheDocument();
    r.set({ runnable: true, running: 'other-task', tasks: {} });
    act(() => r.emit('changed', { what: 'checkpoints' }));
    expect(await screen.findByRole('button', { name: 'Run checkpoint' })).toBeDisabled();
  });

  it('says when a run was stopped, and shows errors', async () => {
    const user = userEvent.setup();
    const r = rpc({ runnable: true, tasks: {} });
    r.handle('checkpoints.run', () => ({ ...run({ id: '' }), cancelled: true, output: '', truncated: false }));
    mount(r);
    await user.click(await screen.findByRole('button', { name: 'Run checkpoint' }));
    expect(await screen.findByText('Stopped. Nothing was recorded.')).toBeInTheDocument();
    r.handle('checkpoints.run', () => {
      throw new RpcFailure({ code: 'invalid_params', message: '"ctest" was not found.' });
    });
    await user.click(screen.getByRole('button', { name: 'Run checkpoint' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('"ctest" was not found.');
  });

  it('explains why it cannot run, and the project settings fix it', async () => {
    const user = userEvent.setup();
    const r = rpc({ runnable: false, reason: 'This project has no test command.', tasks: {} });
    mount(r);
    expect(await screen.findByText(/This project has no test command\. Set it in the project settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run checkpoint' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Project' }));
    const command = screen.getByLabelText('Test command');
    expect(command).toHaveValue('ctest -R {suite}');
    await user.clear(command);
    await user.type(command, 'ctest --test-dir build');
    await user.type(screen.getByLabelText('Why it matters to you'), 'my engine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(r.calls.find((c) => c.method === 'projects.update')!.params).toEqual({
      projectId: 'p-1',
      goal: 'g',
      why: 'my engine',
      workspace: '/w',
      testCommand: 'ctest --test-dir build',
      agent: DEFAULT_PERMISSIONS,
    });
    r.handle('projects.update', () => {
      throw new RpcFailure({ code: 'invalid_params', message: 'only works in a shell' });
    });
    await user.type(screen.getByLabelText('Goal'), '!');
    expect(screen.queryByText('Saved.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('only works in a shell');
  });
});

describe('ProjectSettings', () => {
  it('starts empty for a project without a workspace', () => {
    render(
      <RpcProvider client={new FakeRpc().asClient()}>
        <ProjectSettings project={{ ...project, workspace: undefined as never, testCommand: undefined as never }} />
      </RpcProvider>,
    );
    expect(screen.getByLabelText('Workspace folder')).toHaveValue('');
    expect(screen.getByLabelText('Test command')).toHaveValue('');
  });
});
