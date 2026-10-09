// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BrainDTO, BrainNodeDTO, ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { RpcProvider } from '../src/hooks.tsx';
import { App } from '../src/App.tsx';
import { BrainView, lookOf, radiusOf } from '../src/brain/BrainView.tsx';
import { FakeRpc } from './fake-rpc.ts';

const node = (id: string, over: Partial<BrainNodeDTO> = {}): BrainNodeDTO => ({
  id,
  title: id,
  suggested: false,
  discovered: true,
  mastery: 'practising',
  band: 'developing',
  confidence: 0.5,
  evidence: 4,
  struggling: [],
  projects: ['p-1'],
  ...over,
});

const brain: BrainDTO = {
  groups: [
    { id: 'linalg', title: 'Linear algebra' },
    { id: 'rot', title: 'Rotations' },
  ],
  nodes: [
    node('linalg.vectors', { title: 'Vectors', group: 'linalg', mastery: 'durable', band: 'strong', confidence: 0.9, evidence: 12 }),
    node('rot.quaternion', { title: 'Quaternions', group: 'rot', summary: 'Rotations as four numbers', mastery: 'provisional', evidence: 1 }),
    node('rot.exp', { title: 'Exponential map', group: 'rot', struggling: ['3 of the last 4 answers missed'], projects: ['p-1', 'p-2'] }),
    node('dyn.fs', { title: 'Featherstone', suggested: true, discovered: false, why: 'Builds on your rotations', mastery: 'unseen', evidence: 0, confidence: 0, projects: [] }),
    node('cpp.span', { title: 'std::span', discovered: false, mastery: 'unseen', evidence: 0, confidence: 0 }),
  ],
  edges: [
    { from: 'linalg.vectors', to: 'rot.quaternion', kind: 'prereq' },
    { from: 'rot.quaternion', to: 'rot.exp', kind: 'prereq' },
    { from: 'rot.exp', to: 'dyn.fs', kind: 'prereq' },
    { from: 'rot.quaternion', to: 'rot.exp', kind: 'confusable' },
    { from: 'cpp.span', to: 'missing.skill', kind: 'related' },
  ],
};

function reducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

afterEach(() => vi.unstubAllGlobals());

const mount = (data: BrainDTO, onBack = () => undefined) =>
  render(
    <RpcProvider client={new FakeRpc().handle('brain.get', () => data).asClient()}>
      <BrainView onBack={onBack} />
    </RpcProvider>,
  );

describe('brain view', () => {
  it('draws every skill by what the evidence says, with the group, links and a summary', async () => {
    reducedMotion(true);
    mount(brain);
    const map = await screen.findByRole('group', { name: 'Map of 5 skills, 3 met so far' });
    expect(screen.getByText('1 learned to stay · 2 in progress · 1 need attention · 1 to discover')).toBeInTheDocument();
    expect(within(map).getByRole('button', { name: 'Vectors: learned, and it stuck' })).toHaveClass('look-durable');
    expect(within(map).getByRole('button', { name: 'Quaternions: got it (to confirm later)' })).toHaveClass('look-mastered');
    expect(within(map).getByRole('button', { name: 'Exponential map: learning; needs attention: 3 of the last 4 answers missed' })).toHaveClass('struggling');
    expect(within(map).getByRole('button', { name: 'Featherstone: not discovered yet: a suggestion' })).toHaveClass('look-undiscovered');
    expect(within(map).getByRole('button', { name: 'std::span: planned, not met yet' })).toHaveClass('look-unseen');
    expect(map.querySelectorAll('.brain-edge')).toHaveLength(4); // the link to an unknown skill is not drawn
    expect(map.querySelectorAll('.brain-edge[marker-end]')).toHaveLength(3);
    expect(screen.getByText('Linear algebra')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Legend' })).toBeInTheDocument();
  });

  it('shows a skill when it is picked, by pointer or keyboard, and lets it go', async () => {
    reducedMotion(true);
    const user = userEvent.setup();
    mount(brain);
    const map = await screen.findByRole('group', { name: /Map of 5 skills/ });
    fireEvent.pointerDown(within(map).getByRole('button', { name: /^Exponential map/ }), { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(map);
    const details = screen.getByRole('complementary', { name: 'Exponential map' });
    expect(details).toHaveTextContent('Rotations');
    expect(details).toHaveTextContent('Needs attention');
    expect(details).toHaveTextContent('3 of the last 4 answers missed');
    expect(details).toHaveTextContent('Builds on: Quaternions');
    expect(details).toHaveTextContent('Leads to: Featherstone');
    expect(details).toHaveTextContent('Often mixed up with: Quaternions');
    expect(details).toHaveTextContent('Used in 2 projects');
    expect(details).toHaveTextContent('level developing · 4 pieces of evidence · the app is 50% sure');
    expect(map.querySelectorAll('.brain-node.dim')).toHaveLength(2); // only the neighbours stay lit
    expect(map.querySelectorAll('.brain-edge.on')).toHaveLength(3);

    within(map).getByRole('button', { name: /^Featherstone/ }).focus();
    await user.keyboard('{Enter}');
    const fs = screen.getByRole('complementary', { name: 'Featherstone' });
    expect(fs).toHaveTextContent('Why it could be next: Builds on your rotations');
    expect(fs).not.toHaveTextContent('evidence');
    expect(fs).toHaveTextContent('Skill');
    await user.keyboard(' ');
    within(map).getByRole('button', { name: /^Vectors/ }).focus();
    await user.keyboard('x');
    expect(screen.getByRole('complementary', { name: 'Featherstone' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).toBeNull();

    // Clicking the background lets go too.
    fireEvent.pointerDown(within(map).getByRole('button', { name: /^Vectors/ }), { pointerId: 1 });
    fireEvent.pointerUp(map);
    expect(screen.getByRole('complementary', { name: 'Vectors' })).toHaveTextContent('Used in 1 project');
    fireEvent.pointerDown(map, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(map);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('can be dragged, panned and zoomed', async () => {
    reducedMotion(true);
    mount(brain);
    const map = await screen.findByRole('group', { name: /Map of 5 skills/ });
    const vectors = within(map).getByRole('button', { name: /^Vectors/ });
    const before = vectors.getAttribute('transform');
    fireEvent.pointerDown(vectors, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 333, clientY: 222 });
    fireEvent.pointerUp(map, { pointerId: 1 });
    expect(vectors.getAttribute('transform')).not.toBe(before);
    fireEvent.pointerMove(map, { clientX: 1, clientY: 1 }); // not dragging: nothing happens

    const viewBox = () => map.getAttribute('viewBox')!.split(' ').map(Number);
    const [x0, y0, w0] = viewBox();
    fireEvent.pointerDown(map, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(map, { pointerId: 2, clientX: 150, clientY: 80 });
    fireEvent.pointerCancel(map, { pointerId: 2 });
    expect(viewBox()[0]).toBe(x0! - 50);
    expect(viewBox()[1]).toBe(y0! + 20);
    fireEvent.wheel(map, { deltaY: 300, clientX: 0, clientY: 0 });
    expect(viewBox()[2]).toBeGreaterThan(w0!);
    fireEvent.wheel(map, { deltaY: -100000 });
    expect(viewBox()[2]).toBeLessThan(w0! * 1.5);
  });

  it('floats into place and then stops moving', async () => {
    reducedMotion(false);
    mount(brain);
    const map = await screen.findByRole('group', { name: /Map of 5 skills/ });
    const vectors = within(map).getByRole('button', { name: /^Vectors/ });
    const start = vectors.getAttribute('transform');
    await waitFor(() => expect(vectors.getAttribute('transform')).not.toBe(start));
    // Once at rest, nothing moves any more.
    await waitFor(
      async () => {
        const a = vectors.getAttribute('transform');
        await new Promise((r) => setTimeout(r, 60));
        expect(vectors.getAttribute('transform')).toBe(a);
      },
      { timeout: 8000 },
    );
  });

  it('works without animation frames or media queries', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('matchMedia', undefined);
    mount(brain);
    expect(await screen.findByRole('group', { name: /Map of 5 skills/ })).toBeInTheDocument();
  });

  it('lists the same skills by group, and says when the map is empty', async () => {
    reducedMotion(true);
    const user = userEvent.setup();
    const onBack = vi.fn();
    const { unmount } = mount(brain, onBack);
    await screen.findByRole('group', { name: /Map of 5 skills/ });
    await user.click(screen.getByRole('radio', { name: 'List' }));
    const rot = screen.getByRole('region', { name: 'Rotations' });
    expect(within(rot).getByText(/learning · needs attention: 3 of the last 4 answers missed/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Other skills' })).getAllByRole('button')).toHaveLength(2);
    await user.click(within(rot).getByRole('button', { name: 'Quaternions' }));
    expect(screen.getByRole('complementary', { name: 'Quaternions' })).toHaveTextContent('Rotations as four numbers');
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '← Back' }));
    expect(onBack).toHaveBeenCalled();
    unmount();

    mount({ groups: [{ id: 'empty', title: 'Nothing here' }], nodes: [], edges: [] });
    expect(await screen.findByText(/Your map is empty for now/)).toBeInTheDocument();
  });

  it('shows what the learner\'s work suggests as claims to verify, apart from what is known', async () => {
    reducedMotion(true);
    const user = userEvent.setup();
    const claimed: BrainDTO = {
      ...brain,
      nodes: [
        ...brain.nodes,
        node('quat.slerp', { title: 'Slerp', discovered: false, mastery: 'unseen', evidence: 0, confidence: 0, claim: { from: 'workspace', basis: 'math/Quat.cpp has slerp' } }),
        node('vec.cross', { title: 'Cross product', claim: { from: 'sources', basis: 'lesson 02' } }),
      ],
    };
    mount(claimed);
    const map = await screen.findByRole('group', { name: /Map of 7 skills/ });
    expect(screen.getByText(/· 1 to verify ·/)).toBeInTheDocument();
    const slerp = within(map).getByRole('button', { name: 'Slerp: claimed from your work, to verify' });
    expect(slerp).toHaveClass('look-claimed');
    fireEvent.pointerDown(slerp, { pointerId: 1 });
    expect(screen.getByRole('complementary', { name: 'Slerp' })).toHaveTextContent('Claimed, to verify: math/Quat.cpp has slerp');
    fireEvent.pointerDown(within(map).getByRole('button', { name: /^Cross product/ }), { pointerId: 1 });
    expect(screen.getByRole('complementary', { name: 'Cross product' })).toHaveTextContent('Claimed at the start: lesson 02');
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('claimed from your work, to verify');
    await user.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.getByText('claimed from your work, to verify', { selector: '.quiet' })).toBeInTheDocument();
  });

  it('sizes and colours nodes from evidence only', () => {
    expect(lookOf(node('a', { mastery: 'introduced' }))).toBe('learning');
    expect(radiusOf(node('a', { evidence: 0 }))).toBe(7);
    expect(radiusOf(node('a', { evidence: 400 }))).toBe(18);
    expect(radiusOf(node('a', { discovered: false }))).toBe(6);
  });

  it('folds groups into one node as it zooms out, and opens them again', async () => {
    reducedMotion(true);
    const user = userEvent.setup();
    const nested: BrainDTO = {
      groups: [
        { id: 'maths', title: 'Mathematics' },
        { id: 'linalg', title: 'Linear algebra', parent: 'maths' },
        { id: 'rot', title: 'Rotations', parent: 'maths' },
        { id: 'talk', title: 'Communication' },
      ],
      nodes: [
        ...brain.nodes.map((n) => (n.group === 'linalg' || n.group === 'rot' ? n : { ...n, group: 'talk' })),
        node('linalg.matrices', { title: 'Matrices', group: 'linalg', discovered: false, mastery: 'unseen', evidence: 0, confidence: 0 }),
      ],
      edges: brain.edges,
    };
    mount(nested);
    const map = await screen.findByRole('group', { name: /Map of 6 skills/ });
    expect(map.querySelectorAll('.brain-fold')).toHaveLength(0);
    // The list nests areas inside their domain.
    await user.click(screen.getByRole('radio', { name: 'List' }));
    expect(within(screen.getByRole('region', { name: 'Mathematics' })).getByRole('region', { name: 'Rotations' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('region', { name: 'Rotations' })).getByRole('button', { name: 'Quaternions' }));
    expect(screen.getByRole('complementary', { name: 'Quaternions' })).toHaveTextContent('Mathematics › Rotations');
    await user.click(screen.getByRole('radio', { name: 'Map' }));

    const zoomOut = async (times: number) => {
      for (let i = 0; i < times; i++) await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    };
    const m = () => screen.getByRole('group', { name: /Map of 6 skills/ });
    await zoomOut(6);
    // Skill names give way to tooltips when they would be too small to read.
    expect(m().querySelector('.brain-node title, .brain-fold')).not.toBeNull();
    await zoomOut(10);
    const folds = within(m()).getAllByRole('button', { name: /Open it$/ });
    expect(folds.map((f) => f.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Mathematics: 4 skills, 3 met, 1 need attention\. Open it$/), expect.stringMatching(/^Communication: 2 skills, 0 met\. Open it$/)]),
    );
    expect(m().querySelectorAll('.brain-edge.kind-merged').length).toBeGreaterThan(0);

    // Unfolded on request: every skill again.
    await user.click(screen.getByLabelText('Fold groups when zoomed out'));
    expect(m().querySelectorAll('.brain-fold')).toHaveLength(0);
    expect(m().querySelectorAll('.brain-node')).toHaveLength(6);
    await user.click(screen.getByLabelText('Fold groups when zoomed out'));

    // Opening a folded group zooms into it, by pointer or keyboard.
    const before = m().getAttribute('viewBox');
    const maths = within(m()).getByRole('button', { name: /^Mathematics:/ });
    fireEvent.pointerDown(maths, { pointerId: 1 });
    await user.click(maths);
    expect(m().getAttribute('viewBox')).not.toBe(before);
    expect(within(m()).getByRole('button', { name: /^Quaternions/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    await zoomOut(16);
    within(m()).getByRole('button', { name: /^Communication:/ }).focus();
    await user.keyboard('{Enter}');
    expect(within(m()).queryByRole('button', { name: /^Communication:/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
  });

  it('measures the map, and follows its size', async () => {
    reducedMotion(true);
    const observed: (() => void)[] = [];
    let disconnected = false;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed.push(cb);
        }
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
    );
    const { unmount } = mount(brain);
    await screen.findByRole('group', { name: /Map of 5 skills/ });
    expect(observed).toHaveLength(1);
    observed[0]!();
    unmount();
    expect(disconnected).toBe(true);
  });

  it('opens from home and from the learner panel', async () => {
    reducedMotion(true);
    const user = userEvent.setup();
    const profile: ProfileDTO = { id: 'prof_1', displayName: 'Jules', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } };
    const project: ProjectDTO = { id: 'p-1', title: 'HMP', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };
    const r = new FakeRpc()
      .handle('app.info', () => ({ name: 'Aporia', id: 'aporia', tagline: 't', agent: 'Fake' }))
      .handle('profiles.list', () => [profile])
      .handle('profiles.open', () => profile)
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [])
      .handle('history.list', () => [])
      .handle('learner.summary', () => ({ kcs: [], insights: [], recentSuccess: { correct: 0, total: 0 } }))
      .handle('brain.get', () => brain);
    render(
      <RpcProvider client={r.asClient()}>
        <App />
      </RpcProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Jules/ }));
    await user.click(await screen.findByRole('button', { name: 'Your brain' }));
    expect(await screen.findByRole('heading', { name: 'Your brain' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← Back' }));
    await user.click(await screen.findByRole('button', { name: /HMP/ }));
    await user.click(await screen.findByRole('button', { name: 'You' }));
    await user.click(await screen.findByRole('button', { name: /map of your brain/ }));
    expect(await screen.findByRole('heading', { name: 'Your brain' })).toBeInTheDocument();
  });

  it('is where the app reopens if the learner was on it', async () => {
    reducedMotion(true);
    const user = userEvent.setup();
    const profile: ProfileDTO = { id: 'prof_1', displayName: 'Jules', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } };
    const sets: unknown[] = [];
    const r = new FakeRpc()
      .handle('app.info', () => ({ name: 'Aporia', id: 'aporia', tagline: 't', agent: 'Fake' }))
      .handle('place.get', () => ({ profileId: profile.id, brain: true }))
      .handle('place.set', (p: unknown) => (sets.push(p), {}))
      .handle('profiles.open', () => profile)
      .handle('projects.list', () => [])
      .handle('brain.get', () => brain);
    render(
      <RpcProvider client={r.asClient()}>
        <App />
      </RpcProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Your brain' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← Back' }));
    expect(sets.at(-1)).toEqual({ brain: null });
  });
});
