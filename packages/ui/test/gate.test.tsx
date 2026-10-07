// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { Markdown } from '../src/lesson/Markdown.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { FakeRpc } from './fake-rpc.ts';

const SOLUTION = [
  'Here it is:',
  '',
  '```cpp',
  'void integratePosition(const Joint& j, std::span<double> q, std::span<const double> v, double dt) {',
  '    Quat w = qexp(Vec3(v[0], v[1], v[2]) * dt);',
  '    store(q, (load(q) * w).normalized());',
  '}',
  '```',
  '',
  'And an unrelated example:',
  '',
  '```cpp',
  'double area(double r) {',
  '    double a = r * r;',
  '    return 3.14159 * a;',
  '}',
  '```',
].join('\n');

describe('the solution gate', () => {
  it('hides only the code a gate flags, until the learner chooses to see it', async () => {
    const user = userEvent.setup();
    render(<Markdown md={SOLUTION} gate={(code) => (code.includes('integratePosition') ? 'integratePosition' : undefined)} />);
    expect(screen.getByRole('note')).toHaveTextContent('This code may be the answer to integratePosition');
    expect(screen.queryByText(/qexp/)).toBeNull();
    expect(screen.getByText(/3\.14159/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show anyway' }));
    expect(screen.getByText(/qexp/)).toBeInTheDocument();
  });

  it('guards the tutor replies in a project while the task is open', async () => {
    const user = userEvent.setup();
    const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false } };
    const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
      .handle('lessons.get', () => fourNumbers)
      .handle('history.list', () => [])
      .handle('ask', () => ({ askId: 'a1' }));
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: fourNumbers.title });
    await user.click(screen.getByRole('button', { name: /give me a hint/ }));
    await user.click(screen.getByRole('button', { name: 'Ask for a hint' }));
    await screen.findByText(/I'm stuck on task/);
    act(() => r.emit('ask.event', { askId: 'a1', event: { kind: 'text', text: SOLUTION } }));
    expect(await screen.findByText(/may be the answer to/)).toBeInTheDocument();

    // Once the task is done, nothing is held back.
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(screen.queryByText(/may be the answer to/)).toBeNull();
    expect(screen.getByText(/qexp/)).toBeInTheDocument();
  });
});
