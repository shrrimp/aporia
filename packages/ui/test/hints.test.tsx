// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileDTO, ProjectDTO, TaskHintsDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { RpcProvider } from '../src/hooks.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { FakeRpc } from './fake-rpc.ts';

const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false } };
const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };

function setup(hints: Record<string, TaskHintsDTO>) {
  const r = new FakeRpc()
    .handle('projects.list', () => [project])
    .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
    .handle('lessons.get', () => fourNumbers)
    .handle('history.list', () => [])
    .handle('hints.get', () => hints)
    .handle('hints.attempt', () => ({ recorded: true }))
    .handle('ask', () => ({ askId: 'a1' }));
  render(
    <RpcProvider client={r.asClient()}>
      <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
    </RpcProvider>,
  );
  return r;
}

const at = '2026-10-08T10:00:00.000Z';

describe('the hint ladder in a task', () => {
  it('shows the levels used, and when the next one needs an attempt', async () => {
    setup({
      'step-2': {
        levels: [
          { level: 1, name: 'Point', summary: 'which side', at },
          { level: 2, name: 'Question', at },
          { level: 3, name: 'Analogy', at },
        ],
        max: 3,
        attemptSince: false,
        nextNeedsAttempt: true,
      },
    });
    const ladder = await screen.findByLabelText('Hints so far');
    expect(within(ladder).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['L1 Point · which side', 'L2 Question', 'L3 Analogy']);
    expect(ladder).toHaveTextContent(/try something first/);
  });

  it('records what the learner tried as an attempt, then asks', async () => {
    const user = userEvent.setup();
    const r = setup({});
    await screen.findByRole('heading', { level: 1, name: fourNumbers.title });
    expect(screen.queryByLabelText('Hints so far')).toBeNull();
    await user.click(screen.getByRole('button', { name: /I'm stuck/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: /I'm stuck/ }));
    await user.type(screen.getByLabelText(/What have you tried/), 'I multiplied on the left');
    await user.click(screen.getByRole('button', { name: 'Ask for a hint' }));
    expect(r.calls.find((c) => c.method === 'hints.attempt')!.params).toEqual({ projectId: 'p-1', lessonId: fourNumbers.id, taskId: 'step-2', text: 'I multiplied on the left' });
    await waitFor(() => expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({ question: expect.stringMatching(/What I tried: I multiplied on the left\. Give me/), anchor: 'task:step-2' }));
  });

  it('says so when the attempt cannot be saved, and does not ask', async () => {
    const user = userEvent.setup();
    const r = setup({});
    r.handle('hints.attempt', () => {
      throw new RpcFailure({ code: 'internal', message: 'disk full' });
    });
    await screen.findByRole('heading', { level: 1, name: fourNumbers.title });
    await user.click(screen.getByRole('button', { name: /I'm stuck/ }));
    await user.type(screen.getByLabelText(/What have you tried/), 'x');
    await user.click(screen.getByRole('button', { name: 'Ask for a hint' }));
    expect(await screen.findByText('disk full')).toBeInTheDocument();
    expect(r.calls.some((c) => c.method === 'ask')).toBe(false);
  });
});
