// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileDTO, ProjectDTO, ReviewQueueDTO, ReviewSlotDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { Home } from '../src/screens/Home.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { Review } from '../src/screens/Review.tsx';
import { FakeRpc } from './fake-rpc.ts';

const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } };
const project: ProjectDTO = { id: 'p-1', title: 'HMP', goal: 'Featherstone', why: '', createdAt: '2026-10-05T10:00:00.000Z' };

const slots: ReviewSlotDTO[] = [
  {
    kc: 'quaternion.unit',
    skill: 'Unit quaternions',
    retrievability: 0.6,
    reviews: 2,
    question: {
      id: '~reviews/r-1',
      seen: 'new',
      context: 'A quaternion is written $q = (w, x, y, z)$.',
      item: { id: 'r-1', kind: 'numeric', prompt: 'How many numbers make a quaternion?', kcs: ['quaternion.unit'], difficulty: 1, why: 'w, x, y, z', transfer: false, answer: 4, tolerance: 0 },
    },
  },
  {
    kc: 'quaternion.exp-map-side',
    skill: 'Which side the exponential map multiplies',
    retrievability: 0.8,
    reviews: 1,
    question: {
      id: 'l2/w1',
      seen: 'again',
      from: 'Joints',
      item: { id: 'w1', kind: 'mcq', prompt: 'Which side?', kcs: ['quaternion.exp-map-side'], difficulty: 3, why: 'Body frame.', transfer: true, options: ['Left', 'Right'], answer: 1 },
    },
  },
];

const mount = (r: FakeRpc, ui: React.ReactNode) => render(<RpcProvider client={r.asClient()}>{ui}</RpcProvider>);

describe('Review', () => {
  it('asks a question on each due skill, with its context, records the answers, and offers another round', async () => {
    const user = userEvent.setup();
    let queue: ReviewQueueDTO = { slots, dueCount: 25, writing: false };
    const r = new FakeRpc().handle('reviews.queue', () => queue).handle('reviews.answer', () => ({ id: 'ev' }));
    mount(r, <Review projectId="p-1" />);
    const first = await screen.findByRole('article', { name: 'Unit quaternions' });
    expect(first).toHaveTextContent('A quaternion is written');
    expect(within(first).queryByText('Seen before')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2 left (25 skills due in all: the most at risk first)');

    await user.type(within(first).getByLabelText('Your answer'), '4');
    await user.click(within(first).getByRole('radio', { name: 'Sure' }));
    await user.click(within(first).getByRole('button', { name: 'Check' }));
    expect(await within(first).findByText('Right.')).toBeInTheDocument();
    expect(r.calls.find((c) => c.method === 'reviews.answer')!.params).toEqual({ projectId: 'p-1', questionId: '~reviews/r-1', evidenceType: 'production', outcome: 1, confidence: 'sure' });
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('1 of 2 left');

    // A lesson's own item, until the tutor has written questions on its skill: it says so.
    const second = screen.getByRole('article', { name: 'Which side the exponential map multiplies' });
    expect(second).toHaveTextContent('Seen before');
    expect(second).toHaveTextContent('From Joints');
    await user.click(within(second).getByLabelText('Left'));
    await user.click(within(second).getByRole('radio', { name: 'Guessing' }));
    await user.click(within(second).getByRole('button', { name: 'Check' }));
    expect(await within(second).findByText('Not quite.')).toBeInTheDocument();
    expect(r.calls.filter((c) => c.method === 'reviews.answer').at(-1)!.params).toMatchObject({ questionId: 'l2/w1', evidenceType: 'recognition', outcome: 0 });

    queue = { slots: [], dueCount: 0, nextDue: '2026-10-09T10:00:00.000Z', writing: false };
    await user.click(await screen.findByRole('button', { name: 'Check for more' }));
    expect(await screen.findByText(/Nothing is due\. The next skill comes back on/)).toBeInTheDocument();
  });

  it('retires a question that makes no sense without the lesson, withdrawing the answer given to it', async () => {
    const user = userEvent.setup();
    let flagOk = false;
    const r = new FakeRpc()
      .handle('reviews.queue', () => ({ slots, dueCount: 2, writing: false }))
      .handle('reviews.answer', () => ({ id: 'ev_1' }))
      .handle('reviews.flag', () => {
        if (!flagOk) throw new Error('offline');
        return { ok: true };
      });
    mount(r, <Review projectId="p-1" />);
    const second = await screen.findByRole('article', { name: 'Which side the exponential map multiplies' });
    await user.click(within(second).getByLabelText('Left'));
    await user.click(within(second).getByRole('radio', { name: 'Guessing' }));
    await user.click(within(second).getByRole('button', { name: 'Check' }));
    await user.click(within(second).getByRole('button', { name: "Doesn't make sense without the lesson" }));
    expect(await within(second).findByText(/did not go through/)).toBeInTheDocument();
    flagOk = true;
    await user.click(within(second).getByRole('button', { name: "Doesn't make sense without the lesson" }));
    expect(await within(second).findByText(/won't be asked again, and your answer to it does not count/)).toBeInTheDocument();
    expect(r.calls.filter((c) => c.method === 'reviews.flag').at(-1)!.params).toEqual({ projectId: 'p-1', questionId: 'l2/w1', evidenceId: 'ev_1' });

    // Flagged before answering: it counts as done, and there is no answer to withdraw.
    const first = screen.getByRole('article', { name: 'Unit quaternions' });
    await user.click(within(first).getByRole('button', { name: "Doesn't make sense without the lesson" }));
    expect(await within(first).findByText(/won't be asked again;/)).toBeInTheDocument();
    expect(r.calls.filter((c) => c.method === 'reviews.flag').at(-1)!.params).toEqual({ projectId: 'p-1', questionId: '~reviews/r-1' });
    expect(screen.getByRole('status')).toHaveTextContent('0 of 2 left');
  });

  it('flags a question whose answer could not be saved, with no answer to withdraw', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('reviews.queue', () => ({ slots: [slots[1]!], dueCount: 1, writing: false }))
      .handle('reviews.answer', () => {
        throw new Error('offline');
      })
      .handle('reviews.flag', () => ({ ok: true }));
    mount(r, <Review projectId="p-1" />);
    const card = await screen.findByRole('article', { name: 'Which side the exponential map multiplies' });
    await user.click(within(card).getByLabelText('Right'));
    await user.click(within(card).getByRole('radio', { name: 'Sure' }));
    await user.click(within(card).getByRole('button', { name: 'Check' }));
    await user.click(within(card).getByRole('button', { name: "Doesn't make sense without the lesson" }));
    expect(await within(card).findByText(/won't be asked again/)).toBeInTheDocument();
    expect(r.calls.find((c) => c.method === 'reviews.flag')!.params).toEqual({ projectId: 'p-1', questionId: 'l2/w1' });
  });

  it('fills the skills still waiting once the tutor has written their questions, keeping the answered ones', async () => {
    const user = userEvent.setup();
    const waiting: ReviewSlotDTO = { kc: 'k', skill: 'Spatial forces', retrievability: 0.4, reviews: 1 };
    let queue: ReviewQueueDTO = { slots: [slots[0]!, waiting], dueCount: 2, writing: true };
    const r = new FakeRpc().handle('reviews.queue', () => queue).handle('reviews.answer', () => ({ id: 'ev' }));
    mount(r, <Review projectId="p-1" />);
    expect(await screen.findByText(/Your tutor is writing new questions/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Spatial forces' })).toHaveTextContent('A question on this skill is being written.');
    const first = screen.getByRole('article', { name: 'Unit quaternions' });
    await user.type(within(first).getByLabelText('Your answer'), '4');
    await user.click(within(first).getByRole('radio', { name: 'Sure' }));
    await user.click(within(first).getByRole('button', { name: 'Check' }));

    queue = {
      slots: [{ ...waiting, question: { id: '~reviews/r-2', seen: 'new', item: { id: 'r-2', kind: 'numeric', prompt: 'Torque of 2 N at 3 m?', kcs: ['k'], difficulty: 2, why: 'r × F', transfer: false, answer: 6, tolerance: 0 } } }],
      dueCount: 1,
      writing: false,
    };
    act(() => r.emit('changed', { what: 'reviews' }));
    expect(await screen.findByText('Torque of 2 N at 3 m?')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Unit quaternions' })).getByText('Right.')).toBeInTheDocument();
    expect(screen.queryByText(/Your tutor is writing/)).toBeNull();
    // Not writing any more: changes no longer reload the page.
    act(() => r.emit('changed', { what: 'reviews' }));
    expect(r.calls.filter((c) => c.method === 'reviews.queue')).toHaveLength(2);
  });

  it('says when nothing was answered yet, and when a skill has no question', async () => {
    const r = new FakeRpc().handle('reviews.queue', () => ({ slots: [], dueCount: 0, writing: false }));
    const view = mount(r, <Review projectId="p-1" />);
    expect(await screen.findByText(/Skills appear here once you have answered questions on them/)).toBeInTheDocument();
    view.unmount();
    mount(new FakeRpc().handle('reviews.queue', () => ({ slots: [{ kc: 'k', skill: 'Spatial forces', retrievability: 0.4, reviews: 1 }], dueCount: 1, writing: false })), <Review projectId="p-1" />);
    expect(await screen.findByText('No question on this skill yet.')).toBeInTheDocument();
  });

  it('is reached from the project, showing how many are due, and from home', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('projects.list', () => [project, { ...project, id: 'p-2', title: 'Other', workspace: '/w' }])
      .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
      .handle('lessons.get', () => fourNumbers)
      .handle('history.list', () => [])
      .handle('reviews.summary', () => ({ 'p-1': { due: 2 }, 'p-2': { due: 0 } }))
      .handle('reviews.queue', () => ({ slots, dueCount: 2, writing: false }));
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
