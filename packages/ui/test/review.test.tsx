// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileDTO, ProjectDTO, ReviewItemDTO, ReviewQueueDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { Home } from '../src/screens/Home.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { Review } from '../src/screens/Review.tsx';
import { FakeRpc } from './fake-rpc.ts';

const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false } };
const project: ProjectDTO = { id: 'p-1', title: 'HMP', goal: 'Featherstone', why: '', createdAt: '2026-10-05T10:00:00.000Z' };

const items: ReviewItemDTO[] = [
  {
    itemId: 'l1/n1',
    lessonId: 'l1',
    lessonTitle: 'Unit quaternions',
    item: { id: 'n1', kind: 'numeric', prompt: 'How many numbers make a quaternion?', kcs: ['quaternion.unit'], difficulty: 1, why: 'w, x, y, z', transfer: false, answer: 4, tolerance: 0 },
    retrievability: 0.6,
    reviews: 2,
  },
  {
    itemId: 'l2/m1',
    lessonId: 'l2',
    lessonTitle: 'Joints',
    item: { id: 'm1', kind: 'mcq', prompt: 'Which side?', kcs: ['quaternion.exp-map-side'], difficulty: 3, why: 'Body frame.', transfer: true, options: ['Left', 'Right'], answer: 1 },
    retrievability: 0.8,
    reviews: 1,
  },
];

const mount = (r: FakeRpc, ui: React.ReactNode) => render(<RpcProvider client={r.asClient()}>{ui}</RpcProvider>);

describe('Review', () => {
  it('asks each due item, records the answers on the original items, and offers another round', async () => {
    const user = userEvent.setup();
    let queue: ReviewQueueDTO = { items, dueCount: 25 };
    const r = new FakeRpc().handle('reviews.queue', () => queue).handle('answers.record', () => ({ id: 'ev' }));
    mount(r, <Review projectId="p-1" />);
    expect(await screen.findByText('From Unit quaternions')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2 left (25 due in all: the most at risk first)');

    await user.type(screen.getByLabelText('Your answer'), '4');
    await user.click(screen.getAllByRole('radio', { name: 'Sure' })[0]!);
    await user.click(screen.getAllByRole('button', { name: 'Check' })[0]!);
    expect(await screen.findByText('Right.')).toBeInTheDocument();
    expect(r.calls.find((c) => c.method === 'answers.record')!.params).toEqual({
      projectId: 'p-1', lessonId: 'l1', itemId: 'n1', kcs: ['quaternion.unit'], difficulty: 1, evidenceType: 'production', outcome: 1, transfer: false, confidence: 'sure',
    });
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('1 of 2 left');

    const second = screen.getByText('Which side?').closest('li')!;
    await user.click(within(second).getByLabelText('Left'));
    await user.click(within(second).getByRole('radio', { name: 'Guessing' }));
    await user.click(within(second).getByRole('button', { name: 'Check' }));
    expect(await within(second).findByText('Not quite.')).toBeInTheDocument();
    expect(r.calls.filter((c) => c.method === 'answers.record').at(-1)!.params).toMatchObject({ lessonId: 'l2', itemId: 'm1', evidenceType: 'recognition', outcome: 0, transfer: true });

    queue = { items: [], dueCount: 0, nextDue: '2026-10-09T10:00:00.000Z' };
    await user.click(await screen.findByRole('button', { name: 'Check for more' }));
    expect(await screen.findByText(/Nothing is due\. The next item comes back on/)).toBeInTheDocument();
  });

  it('says when nothing was answered yet', async () => {
    mount(new FakeRpc().handle('reviews.queue', () => ({ items: [], dueCount: 0 })), <Review projectId="p-1" />);
    expect(await screen.findByText(/Items appear here once you have answered them/)).toBeInTheDocument();
  });

  it('is reached from the project, showing how many are due, and from home', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('projects.list', () => [project, { ...project, id: 'p-2', title: 'Other', workspace: '/w' }])
      .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
      .handle('lessons.get', () => fourNumbers)
      .handle('history.list', () => [])
      .handle('reviews.summary', () => ({ 'p-1': { due: 2 }, 'p-2': { due: 0 } }))
      .handle('reviews.queue', () => ({ items, dueCount: 2 }));
    const home = mount(r, <Home onOpen={() => undefined} />);
    expect(await screen.findByText(/2 to review/)).toBeInTheDocument();
    expect(screen.getAllByText(/to review/)).toHaveLength(1);
    home.unmount();

    mount(r, <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: /Review/ }));
    expect(screen.getByLabelText('2 due')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'What you learned, from memory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Review/ })).toHaveAttribute('aria-current', 'true');
  });
});
