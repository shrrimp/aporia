// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RpcProvider } from '../src/hooks.tsx';
import { Conversation } from '../src/screens/Conversation.tsx';
import { Proposals } from '../src/screens/Proposals.tsx';
import { describeTool } from '../src/screens/activity.ts';
import { PIXELS, PixelMark } from '../src/PixelMark.tsx';
import { MathField } from '../src/MathField.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { FakeRpc } from './fake-rpc.ts';

const mount = (r: FakeRpc, ui: React.ReactNode) => render(<RpcProvider client={r.asClient()}>{ui}</RpcProvider>);

describe('describeTool', () => {
  it.each([
    ['mcp__aporia__get_teaching_context', 'Reading your learner profile', 'context', undefined],
    ['mcp__aporia__draft_lesson', 'Writing a lesson', 'lesson', undefined],
    ['mcp__aporia__record_evidence', 'Noting what you showed', 'note', undefined],
    ['mcp__other_server__do_thing', 'Using an app tool', 'other', 'do thing'],
    ['record_insight', 'Noting how you learn', 'note', undefined],
    ['Read /home/u/ws/physics/Joint.cpp', 'Reading your code', 'code', 'Joint.cpp'],
    ['Read', 'Reading your code', 'code', undefined],
    ['grep "qdot"', 'Searching your code', 'code', '"qdot"'],
    ['Grep', 'Searching your code', 'code', undefined],
    ['Glob **/*.cpp', 'Looking through your files', 'code', '**/*.cpp'],
    ['List', 'Looking through your files', 'code', undefined],
    ['Something odd', 'Working', 'other', 'Something odd'],
    [undefined, 'Working', 'other', undefined],
  ])('%s', (title, label, kind, detail) => {
    const a = describeTool(title);
    expect(a.label).toBe(label);
    expect(a.kind).toBe(kind);
    expect(a.detail).toBe(detail);
  });
});

describe('PixelMark and MathField', () => {
  it('draws an "a" in pixels and animates only while working', () => {
    const { container, rerender } = render(<PixelMark size={20} />);
    expect(container.querySelectorAll('rect')).toHaveLength(PIXELS.length);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('svg')).not.toHaveClass('working');
    rerender(<PixelMark working label="Tutor is working" />);
    expect(screen.getByRole('img', { name: 'Tutor is working' })).toHaveClass('working');
    const r = container.querySelector('rect') as SVGRectElement;
    expect(r.style.getPropertyValue('--ax')).toMatch(/^-?\d+px$/);
  });

  it('puts faint glyphs behind the app, hidden from assistive tech', () => {
    const { container } = render(<MathField />);
    expect(container.querySelector('.mathfield')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('.mathfield span').length).toBeGreaterThan(8);
  });
});

describe('Conversation', () => {
  const base = () => new FakeRpc().handle('history.list', () => []).handle('ask', () => ({ askId: 'a1' })).handle('ask.cancel', () => ({ ok: true }));

  it('chat: shows a loading line with the current activity, then the answer, steps and blocks', async () => {
    const user = userEvent.setup();
    const r = base();
    const busy: boolean[] = [];
    mount(r, <Conversation variant="chat" projectId="p" lessonId="l" request={undefined} onBusy={(b) => busy.push(b)} />);
    expect(screen.getByText(/won't write your solution/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your question'), 'why?');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(r.calls.find((c) => c.method === 'ask')!.params).toEqual({ projectId: 'p', question: 'why?', lessonId: 'l' });
    expect(await screen.findByText('Thinking…')).toBeInTheDocument();
    act(() => r.emit('ask.event', { askId: 'a1', event: { kind: 'tool', id: 't1', title: 'Read /ws/Joint.cpp', status: 'pending' } }));
    expect(screen.getByText('Reading your code…')).toBeInTheDocument();
    act(() => {
      r.emit('ask.event', { askId: 'a1', event: { kind: 'tool', id: 't1', status: 'completed' } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'tool', id: 't2', title: 'mcp__aporia__record_evidence' } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'tool', id: 't2', title: 'ignored later title', status: 'failed' } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'tool', id: 't3' } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'text', text: 'Because **frames**.' } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'permission', title: 'Edit', decision: { allow: false, reason: 'no' } } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'permission', title: 'Read', decision: { allow: true, reason: 'ok' } } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'blocked-fs', op: 'write', path: '/ws/solution.cpp' } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'blocked-fs', op: 'read', path: '/etc/passwd' } });
      r.emit('ask.event', { askId: 'zz', event: { kind: 'text', text: 'other turn' } });
    });
    expect(screen.getByText('frames')).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'What your tutor did' });
    expect(steps).toHaveTextContent('Reading your codeJoint.cpp');
    expect(steps).toHaveTextContent('Noting what you showeddid not go through');
    expect(steps).toHaveTextContent('Blocked by the appwriting solution.cpp');
    expect(steps).toHaveTextContent('Blocked by the appreading passwd');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    act(() => r.emit('ask.done', { askId: 'a1', stopReason: 'cancelled' }));
    expect(screen.getByText('Stopped.')).toBeInTheDocument();
    expect(busy).toContain(true);
    expect(busy.at(-1)).toBe(false);
  });

  it('page: shows the intro until the first message, the way back, and errors', async () => {
    const user = userEvent.setup();
    const r = base();
    let back = 0;
    mount(r, <Conversation projectId="p" lessonId={undefined} request={undefined} intro={<p>Intro here</p>} backTo="Lesson 1" onBack={() => back++} />);
    expect(screen.getByText('Intro here')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← Back to Lesson 1' }));
    expect(back).toBe(1);
    await user.type(screen.getByLabelText('Your message'), 'hello');
    await user.keyboard('{Enter}'); // plain Enter is a newline, not a send
    expect(r.calls.some((c) => c.method === 'ask')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.queryByText('Intro here')).toBeNull();
    act(() => r.emit('ask.error', { askId: 'a1', message: 'agent died' }));
    expect(screen.getByRole('alert')).toHaveTextContent('agent died');
    act(() => r.emit('ask.done', { askId: 'a1', stopReason: 'end_turn' }));
  });

  it('takes requests from the lesson: questions are sent, selections wait for a question', async () => {
    const user = userEvent.setup();
    const r = base();
    const activity: number[] = [];
    const { rerender } = mount(r, <Conversation variant="chat" projectId="p" lessonId="l" request={{ question: 'hint please', selection: 'sel', anchor: 'a', nonce: 1 }} onActivity={() => activity.push(1)} />);
    expect(r.calls.find((c) => c.method === 'ask')!.params).toEqual({ projectId: 'p', question: 'hint please', lessonId: 'l', selection: 'sel', anchor: 'a' });
    rerender(
      <RpcProvider client={r.asClient()}>
        <Conversation variant="chat" projectId="p" lessonId="l" request={{ question: '', selection: 'just this', anchor: 'b', nonce: 2 }} onActivity={() => activity.push(2)} />
      </RpcProvider>,
    );
    expect(await screen.findByText(/“just this”/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove selection' }));
    expect(screen.queryByText(/“just this”/)).toBeNull();
    expect(activity).toEqual([1, 2]);
  });

  it('reports failures to start a question', async () => {
    const r = base().handle('ask', () => {
      throw new RpcFailure({ code: 'no_profile', message: 'open a profile first' });
    });
    mount(r, <Conversation projectId="p" lessonId="l" request={{ question: 'q', nonce: 1 }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('open a profile first');
  });
});

describe('Proposals', () => {
  it('lists pending changes in words and accepts or rejects them inline', async () => {
    const user = userEvent.setup();
    const item = (id: string, target: string | undefined, status = 'proposed') => ({
      id,
      kind: 'change',
      at: '2026-10-05T10:00:00.000Z',
      author: { kind: 'agent' },
      summary: `reason ${id}`,
      status,
      ...(target ? { target } : {}),
    });
    const r = new FakeRpc()
      .handle('history.list', () => [
        item('chg_1', 'projects/p/lessons/hmp-09.json'),
        item('chg_2', 'projects/p/project.json'),
        item('chg_3', 'other/thing.json'),
        item('chg_4', undefined),
        item('chg_5', 'x.json', 'applied'),
      ])
      .handle('history.accept', ({ id }) => ({ id }))
      .handle('history.reject', () => {
        throw new RpcFailure({ code: 'conflict', message: 'already decided' });
      });
    mount(r, <Proposals />);
    const region = await screen.findByRole('region', { name: 'Proposed changes' });
    expect(region).toHaveTextContent('lesson “hmp-09” · reason chg_1');
    expect(region).toHaveTextContent('project settings · reason chg_2');
    expect(region).toHaveTextContent('other/thing.json · reason chg_3');
    expect(region).toHaveTextContent('a change · reason chg_4');
    expect(region).not.toHaveTextContent('chg_5');
    await user.click(screen.getAllByRole('button', { name: 'Accept' })[0]!);
    expect(r.calls.find((c) => c.method === 'history.accept')!.params).toEqual({ id: 'chg_1' });
    await user.click(screen.getAllByRole('button', { name: 'Reject' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('already decided');
  });

  it('renders nothing when nothing waits', () => {
    const { container } = mount(new FakeRpc().handle('history.list', () => []), <Proposals />);
    expect(container).toBeEmptyDOMElement();
  });
});
