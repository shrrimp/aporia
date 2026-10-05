// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Component } from '@app/catalog';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider, useQuery, useRpc } from '../src/hooks.tsx';
import { Block } from '../src/lesson/Blocks.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { Conversation } from '../src/screens/Conversation.tsx';
import { Home } from '../src/screens/Home.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { FakeRpc } from './fake-rpc.ts';

const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false } };
const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };
const second = { ...fourNumbers, id: 'second', title: 'Second Lesson' };

function rpc() {
  return new FakeRpc()
    .handle('lessons.list', () => [
      { id: 'hmp-09-four-numbers', title: 'Four Numbers, Three Speeds', kind: 'build', estimateMin: 120 },
      { id: 'second', title: 'Second Lesson', kind: 'build', estimateMin: 30 },
    ])
    .handle('lessons.get', ({ lessonId }) => (lessonId === 'second' ? second : fourNumbers))
    .handle('history.list', () => [{ id: 'chg_1', kind: 'change', at: '2026-10-05T10:00:00.000Z', author: { kind: 'agent' }, summary: 's', status: 'proposed' }])
    .handle('learner.summary', () => ({ kcs: [], insights: [], recentSuccess: { correct: 0, total: 0 } }))
    .handle('answers.record', () => ({ id: 'ev' }))
    .handle('ask', () => ({ askId: 'a' }));
}
const mount = (r: FakeRpc, ui: React.ReactNode) => render(<RpcProvider client={r.asClient()}>{ui}</RpcProvider>);

describe('ProjectView', () => {
  it('switches lessons, shows pending changes, and turns selections into questions', async () => {
    const user = userEvent.setup();
    const r = rpc();
    const { container } = mount(r, <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />);
    expect(await screen.findByLabelText('1 pending')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Second Lesson/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Second Lesson' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Second Lesson/ })).toHaveAttribute('aria-current', 'true');

    // Select text inside a lesson block.
    const para = container.querySelector('[data-anchor="why-not-derivative/0"] p')!;
    const range = document.createRange();
    range.selectNodeContents(para.firstChild!);
    range.getBoundingClientRect = () => ({ left: 10, width: 100, top: 50 }) as DOMRect;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.mouseUp(container.querySelector('.lesson')!.parentElement!);
    const chip = await screen.findByRole('button', { name: 'Ask about this' });
    fireEvent.mouseDown(chip);
    await user.click(chip);
    expect(await screen.findByText(/“A ball joint/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tutor' })).toHaveAttribute('aria-pressed', 'true');

    // Selecting nothing clears the chip; selecting outside the lesson is ignored.
    sel.removeAllRanges();
    fireEvent.mouseUp(container.querySelector('.lesson')!.parentElement!);
    expect(screen.queryByRole('button', { name: 'Ask about this' })).toBeNull();
    const outside = container.querySelector('.bar')!;
    const r2 = document.createRange();
    r2.selectNodeContents(outside);
    sel.addRange(r2);
    fireEvent.mouseUp(container.querySelector('.lesson')!.parentElement!);
    expect(screen.queryByRole('button', { name: 'Ask about this' })).toBeNull();

    // Element anchor nodes (selection starting on an element).
    sel.removeAllRanges();
    const r3 = document.createRange();
    r3.selectNodeContents(para);
    r3.getBoundingClientRect = () => ({ left: 0, width: 0, top: 0 }) as DOMRect;
    sel.addRange(r3);
    vi.spyOn(sel, 'anchorNode', 'get').mockReturnValue(para);
    fireEvent.mouseUp(container.querySelector('.lesson')!.parentElement!);
    expect(await screen.findByRole('button', { name: 'Ask about this' })).toBeInTheDocument();
    vi.restoreAllMocks();

    // Answers go to the service with the current lesson.
    await user.click(screen.getByLabelText('The force rule'));
    await user.click(screen.getByRole('radio', { name: 'Guessing' }));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(r.calls.find((c) => c.method === 'answers.record')!.params).toMatchObject({ lessonId: 'second', confidence: 'guess' });
    await user.click(screen.getByRole('button', { name: /^History/ }));
    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^History/ }));
    await user.click(screen.getByRole('button', { name: 'You' }));
    expect(screen.getByRole('region', { name: 'What the app knows about you' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'You' }));
  });

  it('opens a new project on the interview page and runs it there', async () => {
    const user = userEvent.setup();
    const r = rpc().handle('lessons.list', () => []).handle('history.list', () => []);
    mount(r, <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />);
    expect(await screen.findByText(/Lessons appear here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Interview/ })).toHaveAttribute('aria-current', 'true');
    await user.click(screen.getByRole('button', { name: 'Start the interview' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({ question: expect.stringMatching(/^Interview me/) });
    act(() => r.emit('ask.event', { askId: 'a', event: { kind: 'tool', id: 't', title: 'mcp__aporia__get_teaching_context', status: 'pending' } }));
    expect(await screen.findAllByText('working')).not.toHaveLength(0);
    expect(screen.getByText('Reading your learner profile')).toBeInTheDocument();
    act(() => r.emit('ask.done', { askId: 'a', stopReason: 'end_turn' }));
  });

  it('plans the next lesson from the sessions page, and shows proposals there unless the chat is open', async () => {
    const user = userEvent.setup();
    const r = rpc();
    mount(r, <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: /Sessions/ }));
    expect(screen.getByRole('region', { name: 'Proposed changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Plan the next lesson' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({ question: expect.stringMatching(/what should I learn next/) });
    await user.click(screen.getByRole('button', { name: /Back to/ }));
    expect(screen.getByRole('button', { name: /Four Numbers, Three Speeds/ })).toHaveAttribute('aria-current', 'true');
    await user.click(screen.getByRole('button', { name: /^Tutor/ }));
    expect(screen.getAllByRole('region', { name: 'Proposed changes' })).toHaveLength(1);
  });
});

describe('hooks', () => {
  it('useQuery reports errors, refreshes on matching changes, and ignores stale results', async () => {
    let n = 0;
    const r = new FakeRpc().handle('projects.list', () => {
      n++;
      if (n === 1) throw new RpcFailure({ code: 'no_profile', message: 'nope' });
      return [];
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => <RpcProvider client={r.asClient()}>{children}</RpcProvider>;
    const { result, unmount } = renderHook(() => useQuery('projects.list', {}, ['projects']), { wrapper });
    await waitFor(() => expect(result.current.error?.message).toBe('nope'));
    act(() => r.emit('changed', { what: 'history' }));
    expect(n).toBe(1);
    act(() => r.emit('changed', { what: 'projects' }));
    await waitFor(() => expect(result.current.data).toEqual([]));
    unmount();

    let release: (v: unknown) => void = () => undefined;
    const slow = new FakeRpc().handle('projects.list', () => new Promise((res) => (release = res)));
    const w2 = ({ children }: { children: React.ReactNode }) => <RpcProvider client={slow.asClient()}>{children}</RpcProvider>;
    const h2 = renderHook(() => useQuery('projects.list', {}), { wrapper: w2 });
    h2.unmount();
    release([]);
    const h3 = renderHook(() => useQuery('projects.list', null), { wrapper: w2 });
    expect(h3.result.current.loading).toBe(false);
  });

  it('useRpc requires a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useRpc())).toThrow(/outside RpcProvider/);
    vi.restoreAllMocks();
  });
});

describe('RpcClient default socket', () => {
  it('uses the browser WebSocket when no factory is given', async () => {
    const created: string[] = [];
    class StubSocket {
      readyState = 0;
      onopen = null;
      onclose = null;
      onmessage = null;
      constructor(url: string) {
        created.push(url);
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', StubSocket);
    const { RpcClient } = await import('../src/rpc.ts');
    const c = new RpcClient('ws://127.0.0.1:1/rpc?token=t');
    expect(created).toEqual(['ws://127.0.0.1:1/rpc?token=t']);
    c.close();
    vi.unstubAllGlobals();
  });
});

describe('misc branches', () => {
  it('lesson actions default to no-ops outside a lesson', async () => {
    const user = userEvent.setup();
    render(<Block doc={{ type: 'drill', purpose: 'practice', confidence: false, items: [{ id: 'm', kind: 'mcq', prompt: 'p', options: ['a', 'b'], answer: 0, kcs: ['k'], difficulty: 3, why: 'w', transfer: false }] } as Component} />);
    await user.click(screen.getByLabelText('a'));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    render(<Block doc={{ type: 'task', id: 't', title: 'T', scaffold: 2, kcs: ['k'], files: [], goal: 'g', traps: [] } as Component} />);
    await user.click(screen.getByRole('button', { name: /I'm stuck/ }));
  });

  it('order drills move down; numeric needs a number; long selections are truncated', async () => {
    const user = userEvent.setup();
    render(
      <Block
        doc={{
          type: 'drill', purpose: 'practice', confidence: false,
          items: [
            { id: 'o', kind: 'order', prompt: 'p', lines: ['a', 'b', 'c'], kcs: ['k'], difficulty: 3, why: 'w', transfer: false },
            { id: 'n', kind: 'numeric', prompt: 'p', answer: 1, tolerance: 0, kcs: ['k'], difficulty: 3, why: 'w', transfer: false },
          ],
        } as Component}
      />,
    );
    const first = screen.getAllByRole('button', { name: /^Move ".*" down$/ })[0]!;
    await user.click(first);
    await user.click(screen.getAllByRole('button', { name: /^Move ".*" up$/ })[2]!);
    await user.type(screen.getByLabelText('Your answer'), 'abc');
    expect(screen.getAllByRole('button', { name: 'Check' })[1]).toBeDisabled();

    const r = new FakeRpc().handle('ask', () => ({ askId: 'z' }));
    mount(r.handle('history.list', () => []), <Conversation variant="chat" projectId="p" lessonId={undefined} request={{ question: '', selection: 'x'.repeat(200), nonce: 1 }} />);
    expect(await screen.findByText(/“x{160}…”/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(r.calls.some((c) => c.method === 'ask')).toBe(false); // empty question is not sent
    await user.type(screen.getByLabelText('Your question'), 'q');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toEqual({ projectId: 'p', question: 'q', selection: 'x'.repeat(200) });
  });

  it('home lists projects and creates one without coding fields', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc().handle('projects.list', () => [project]).handle('projects.create', (p) => ({ ...project, ...p }));
    const opened: ProjectDTO[] = [];
    mount(r, <Home onOpen={(p) => opened.push(p)} />);
    await user.click(await screen.findByRole('button', { name: /^P/ }));
    await user.click(screen.getByRole('button', { name: '+ Start a new project' }));
    await user.type(screen.getByLabelText(/What do you want/), 'Maths');
    await user.type(screen.getByLabelText('Describe the goal'), 'Linear algebra');
    await user.type(screen.getByLabelText('Why does it matter to you?'), 'physics');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(r.calls.at(-1)!.params).toEqual({ title: 'Maths', goal: 'Linear algebra', why: 'physics' });
    expect(opened).toHaveLength(2);
  });
});
