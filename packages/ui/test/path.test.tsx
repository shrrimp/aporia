// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { learnerForm } from '@app/catalog';
import type { CurriculumDTO, HistoryItemDTO, MilestoneDTO, NextStepDTO, ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { RpcFailure } from '../src/rpc.ts';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { FormCard } from '../src/screens/FormCard.tsx';
import { PathView, type PathActions } from '../src/screens/PathView.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { FakeRpc } from './fake-rpc.ts';

const level = { mastery: 'unseen' as const, confidence: 0, evidence: 0 };
const curriculum = (next: NextStepDTO, over: Partial<CurriculumDTO> = {}): CurriculumDTO => ({
  goals: ['rot.exp'],
  nodes: [
    { id: 'vec', title: 'Vectors', layer: 0, state: 'mastered', needs: [], goal: false, mastery: 'durable', band: 'solid', confidence: 0.8, evidence: 6 },
    { id: 'quat', title: 'Unit quaternions', summary: 'Rotations as four numbers', layer: 1, state: 'in-progress', needs: [], goal: false, mastery: 'practising', band: 'developing', confidence: 0.4, evidence: 1 },
    { id: 'side', title: 'Which side', layer: 1, state: 'available', needs: [], goal: false, ...level },
    { id: 'rot.exp', title: 'The exponential map', layer: 2, state: 'locked', needs: ['Unit quaternions'], goal: true, ...level },
  ],
  edges: [
    { from: 'vec', to: 'quat' },
    { from: 'quat', to: 'rot.exp' },
  ],
  plan: [
    { id: 'four', title: 'Four Numbers', kcs: ['quat'], lessonId: 'l1', status: 'in-progress', progress: { done: 2, total: 9 }, capability: 'your joints rotate' },
    { id: 'next', title: 'Closing the loop', kcs: ['rot.exp'], status: 'planned' },
    { id: 'done', title: 'Vectors again', kcs: ['vec'], lessonId: 'l0', status: 'done', progress: { done: 0, total: 0 } },
  ],
  next,
  roadmap: [],
  assessment: {
    summary: 'Strong on vectors, shaky on frames.',
    strengths: [{ text: 'vectors', kcs: [] }],
    gaps: [{ text: 'frames', kcs: [] }],
    misconceptions: [{ text: 'rotation order does not matter', kcs: [] }],
    bridges: [{ text: 'your voxel engine transforms', kcs: [] }],
    preferences: ['maths first'],
  },
  ...over,
});

/** The path page reads the history (for roadmap changes) through the app. */
const renderPath = (ui: React.ReactElement, rpc: FakeRpc = new FakeRpc().handle('history.list', () => [])) => render(<RpcProvider client={rpc.asClient()}>{ui}</RpcProvider>);

function actions(): PathActions & { [K in keyof PathActions]: ReturnType<typeof vi.fn> } {
  return { openLesson: vi.fn(), openReview: vi.fn(), startSession: vi.fn() } as never;
}

describe('PathView', () => {
  it('shows the skills as a path, their details, the plan and the interview findings', async () => {
    const user = userEvent.setup();
    const a = actions();
    renderPath(<PathView projectId="p-1" curriculum={curriculum({ kind: 'lesson', lessonId: 'l1', title: 'Four Numbers', text: 'Continue "Four Numbers".' })} actions={a} />);
    const locked = screen.getByRole('button', { name: 'The exponential map: locked, a goal of this project, needs Unit quaternions' });
    expect(locked).toHaveClass('state-locked', 'goal');
    expect(screen.getByRole('button', { name: 'Vectors: mastered' })).toHaveClass('state-mastered');

    await user.click(screen.getByRole('button', { name: 'Unit quaternions: in progress' }));
    const detail = screen.getByRole('region', { name: 'Unit quaternions' });
    expect(detail).toHaveTextContent('Rotations as four numbers');
    expect(detail).toHaveTextContent('practising · level developing · 1 piece of evidence · confidence 40%');
    expect(document.querySelectorAll('.path-edges path.on')).toHaveLength(2);
    await user.click(locked);
    expect(screen.getByRole('region', { name: 'The exponential map' })).toHaveTextContent('locked · needs Unit quaternions');
    expect(screen.getByRole('region', { name: 'The exponential map' })).toHaveTextContent('not seen yet · 0 pieces of evidence');
    await user.click(locked);
    expect(screen.queryByRole('region', { name: 'The exponential map' })).toBeNull();

    const plan = document.querySelector<HTMLElement>('ol.plan')!;
    expect(within(plan).getByText('started')).toBeInTheDocument();
    expect(within(plan).getByText('After it: your joints rotate')).toBeInTheDocument();
    expect(within(plan).getByText('2/9')).toBeInTheDocument();
    await user.click(within(plan).getByRole('button', { name: 'Vectors again' }));
    expect(a.openLesson).toHaveBeenCalledWith('l0');
    expect(within(plan).queryByRole('button', { name: 'Closing the loop' })).toBeNull();

    const found = screen.getByRole('region', { name: 'What the interview found' });
    for (const t of ['Strong on vectors, shaky on frames.', 'Strong on', 'To work on', 'Possible misconceptions', 'What you can build on', 'maths first']) expect(found).toHaveTextContent(t);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(a.openLesson).toHaveBeenCalledWith('l1');
  });

  it.each([
    [{ kind: 'interview', existing: false, text: 'Start with a short interview.' } as NextStepDTO, 'Start the interview', 'startSession', /^Interview me/],
    [{ kind: 'review', due: 4, text: 'Review 4 items first.' } as NextStepDTO, 'Review now', 'openReview', undefined],
    [{ kind: 'draft', planId: 'next', title: 'Closing the loop', text: 'Next on the plan.' } as NextStepDTO, 'Ask your tutor to write it', 'startSession', /"Closing the loop" \(plan item next\)/],
    [{ kind: 'plan', text: 'Everything planned is done.' } as NextStepDTO, 'Plan with your tutor', 'startSession', /propose what to learn next/],
  ])('offers the next step: %o', async (next, label, action, arg) => {
    const user = userEvent.setup();
    const a = actions();
    renderPath(<PathView projectId="p-1" curriculum={curriculum(next)} actions={a} />);
    expect(screen.getByRole('region', { name: "What's next" })).toHaveTextContent(next.text);
    await user.click(screen.getByRole('button', { name: label }));
    if (arg) expect(a[action as keyof PathActions]).toHaveBeenCalledWith(expect.objectContaining({ question: expect.stringMatching(arg) }));
    else expect(a[action as keyof PathActions]).toHaveBeenCalled();
  });

  it('says where the path will come from before the interview', () => {
    renderPath(<PathView projectId="p-1" curriculum={curriculum({ kind: 'interview', existing: false, text: 'Start.' }, { nodes: [], edges: [], plan: [], assessment: undefined as never })} actions={actions()} />);
    expect(screen.getByText(/drafts the skills of this project during the interview/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Plan' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'What the interview found' })).toBeNull();
  });
});

describe('the path in a project', () => {
  it('opens from the contents and acts on the project', async () => {
    const user = userEvent.setup();
    const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false } };
    const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
      .handle('lessons.get', () => fourNumbers)
      .handle('history.list', () => [])
      .handle('reviews.summary', () => ({}))
      .handle('reviews.queue', () => ({ items: [], dueCount: 0 }))
      .handle('ask', () => ({ askId: 'a1' }))
      .handle('curriculum.get', () => current);
    let current = curriculum({ kind: 'draft', planId: 'next', title: 'Closing the loop', text: 'Next on the plan.' });
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: fourNumbers.title });
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByText(/lessons planned/)).toHaveTextContent('Your path: 4 skills, 3 lessons planned.');
    await user.click(screen.getByRole('button', { name: 'See the path' }));
    expect(await screen.findByRole('heading', { name: 'Where this project takes you' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask your tutor to write it' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({ question: expect.stringMatching(/Closing the loop/), thread: 'session' });
    await user.click(screen.getByRole('button', { name: 'Path' }));
    await user.click(await screen.findByRole('button', { name: 'Four Numbers' }));
    expect(await screen.findByRole('heading', { level: 1, name: fourNumbers.title })).toBeVisible();
    current = curriculum({ kind: 'review', due: 3, text: 'Review 3 items first.' });
    act(() => r.emit('changed', { what: 'reviews' }));
    await user.click(screen.getByRole('button', { name: 'Path' }));
    await user.click(await screen.findByRole('button', { name: 'Review now' }));
    expect(await screen.findByText(/Nothing is due/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toHaveAttribute('aria-current', 'true');
  });
});

describe('spot-the-line probes', () => {
  it('lets the learner point at a line', async () => {
    const user = userEvent.setup();
    const form = learnerForm.parse({
      title: 'Find it',
      questions: [{ id: 'bug', kind: 'line', prompt: 'Which line is wrong?', code: 'a = 1;\n\nc = a * 2;', lang: 'cpp', probe: { kcs: ['k'], difficulty: 3, answer: 3 } }],
    });
    const onSubmit = vi.fn();
    const { rerender } = render(<FormCard form={form} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('radio', { name: 'Line 3' }));
    expect(screen.getByRole('radio', { name: 'Line 3' }).closest('label')).toHaveClass('on');
    await user.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('→ line 3: c = a * 2;'), { bug: { line: 3 } });
    rerender(<FormCard form={form} onSubmit={onSubmit} submitted={{ bug: { line: 3 } }} />);
    expect(screen.getByText('line 3')).toBeInTheDocument();
  });
});

describe('the roadmap and claims on the path', () => {
  const ms = (id: string, over: Partial<MilestoneDTO> = {}): MilestoneDTO => ({ id, title: id.toUpperCase(), goal: '', kcs: [], order: 1, status: 'planned', ...over });
  const change = (id: string, summary: string, status: HistoryItemDTO['status'], author: HistoryItemDTO['author'] = { kind: 'agent' }): HistoryItemDTO => ({
    id,
    kind: 'change',
    at: '',
    author,
    summary,
    status,
    target: 'projects/p-1/roadmap.json',
  });

  it('shows the milestones, lets the learner set their status, and judge or undo the tutor’s changes', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('history.list', () => [
        change('chg_p', 'roadmap, stage-3: from your repo', 'proposed'),
        change('chg_a', 'roadmap, stage-1: from your repo', 'applied'),
        change('chg_r', 'roadmap, stage-0: first try', 'reverted'),
        change('chg_l', 'roadmap, stage-1: marked active', 'applied', { kind: 'learner' }),
        change('chg_x', 'roadmap, stage-9: no', 'rejected'),
        change('chg_s', 'start the roadmap', 'applied', { kind: 'system' }),
      ])
      .handle('roadmap.setStatus', () => ({ ok: true }))
      .handle('history.accept', () => ({ id: 'chg_p' }))
      .handle('history.reject', () => {
        throw new RpcFailure({ code: 'conflict', message: 'already decided' });
      })
      .handle('history.undo', () => ({ undone: ['chg_a'] }))
      .handle('history.redo', () => ({ id: 'chg_r' }))
      .handle('history.diff', () => ({ kind: 'document', target: 't', before: {}, after: { x: 1 } }));
    const roadmap = [ms('stage-1', { status: 'active', capability: 'things fall', goal: 'A **free** body.' }), ms('stage-2', { order: 2, status: 'done' })];
    renderPath(<PathView projectId="p-1" curriculum={curriculum({ kind: 'plan', text: 'x' }, { roadmap })} actions={actions()} />, r);
    const section = screen.getByRole('region', { name: 'Roadmap' });
    expect(within(section).getByText('STAGE-1').closest('li')).toHaveClass('status-active');
    expect(within(section).getByText('Unlocks: things fall')).toBeInTheDocument();
    expect(within(section).getByText('free').tagName).toBe('STRONG');
    await user.selectOptions(within(section).getByLabelText('Status of STAGE-2'), 'active');
    expect(r.calls.find((c) => c.method === 'roadmap.setStatus')!.params).toEqual({ projectId: 'p-1', milestoneId: 'stage-2', status: 'active' });

    expect(await within(section).findByText('stage-3: from your repo')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Accept' }));
    expect(r.calls.find((c) => c.method === 'history.accept')!.params).toEqual({ id: 'chg_p' });
    await user.click(within(section).getByRole('button', { name: 'Reject' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('already decided');
    await user.click(within(section).getByText('Show the change'));
    expect(await within(section).findByLabelText('Changes')).toHaveTextContent('"x": 1');

    await user.click(within(section).getByText('Changes to the roadmap'));
    const past = within(section).getByText('Changes to the roadmap').closest('details')!;
    expect(within(past).queryByText(/stage-9/)).toBeNull(); // rejected proposals were never part of it
    expect(within(past).queryByText(/start the roadmap/)).toBeNull();
    expect(within(past).getByText('stage-1: marked active').closest('li')).toHaveTextContent(/marked active you undo/);
    await user.click(within(past).getAllByRole('button', { name: 'undo' })[0]!);
    expect(r.calls.find((c) => c.method === 'history.undo')!.params).toEqual({ id: 'chg_a', withDependants: true });
    await user.click(within(past).getByRole('button', { name: 'redo' }));
    expect(r.calls.find((c) => c.method === 'history.redo')!.params).toEqual({ id: 'chg_r' });
  });

  it('says there is no roadmap yet, and marks claimed skills as to verify', async () => {
    const user = userEvent.setup();
    const nodes = curriculum({ kind: 'plan', text: 'x' }).nodes.map((n) =>
      n.id === 'side' ? { ...n, claim: { from: 'workspace' as const, basis: 'physics/Joint.cpp uses the right side' } } : n.id === 'quat' ? { ...n, claim: { from: 'sources' as const, basis: 'lesson 03' } } : n,
    );
    renderPath(<PathView projectId="p-1" curriculum={curriculum({ kind: 'interview', existing: true, text: 'Start from your work.' }, { nodes })} actions={actions()} />);
    expect(screen.getByText(/No roadmap yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start from my existing work' })).toBeInTheDocument();
    const side = screen.getByRole('button', { name: 'Which side: ready to learn, claimed from your work, to verify' });
    expect(side).toHaveClass('claimed');
    await user.click(side);
    expect(screen.getByRole('region', { name: 'Which side' })).toHaveTextContent('Claimed, to verify: physics/Joint.cpp uses the right side (from your code)');
    // With evidence, the claim is history, not a question.
    await user.click(screen.getByRole('button', { name: /^Unit quaternions/ }));
    expect(screen.getByRole('region', { name: 'Unit quaternions' })).toHaveTextContent('Claimed at the start: lesson 03 (from your files)');
    expect(screen.getByRole('button', { name: /^Unit quaternions/ })).not.toHaveClass('claimed');
  });

  it('starts from existing work when there is some', async () => {
    const user = userEvent.setup();
    const a = actions();
    renderPath(<PathView projectId="p-1" curriculum={curriculum({ kind: 'interview', existing: true, text: 'x' })} actions={a} />);
    await user.click(screen.getByRole('button', { name: 'Start from my existing work' }));
    expect(a.startSession).toHaveBeenCalledWith({ question: expect.stringMatching(/^I already have work for this project[\s\S]*claims[\s\S]*probes/), shown: { kind: 'existing-work' } });
  });
});
