// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lesson as lessonSchema, lessonUnits } from '@app/catalog';
import type { JsonValue, TranscriptEntry } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { LessonView } from '../src/lesson/LessonView.tsx';
import { ProgressContext } from '../src/lesson/progress.tsx';
import { CONTINUE, Conversation } from '../src/screens/Conversation.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { applyEntry, replay } from '../src/screens/turns.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { FakeRpc } from './fake-rpc.ts';

const lesson = lessonSchema.parse(fourNumbers);

function show(saved: Record<string, JsonValue> = {}) {
  const save = vi.fn<(key: string, value: JsonValue) => void>();
  const r = render(
    <ProgressContext.Provider value={{ saved, save }}>
      <LessonView lesson={lesson} />
    </ProgressContext.Provider>,
  );
  return { save, ...r };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('lesson progress in the page', () => {
  it('restores every kind of unit from what was saved', () => {
    show({
      'item:w1': { choice: 1, result: 1 },
      'block:why-not-derivative/2': { prediction: 'the exponential one' },
      'block:side/0': { answer: 'exp(ω dt) * q' },
      'task:step-2': { done: true },
      'block:exit/0': { text: 'It is expressed in the child frame, so…' },
    });
    expect(screen.getByText('Right.')).toBeInTheDocument();
    expect(screen.getByText('Your prediction: the exponential one')).toBeInTheDocument();
    expect(screen.getByText('You said: exp(ω dt) * q')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Sent to your tutor' })).toBeDisabled();
    expect(screen.getByLabelText('Your explanation')).toHaveValue('It is expressed in the child frame, so…');
    expect(screen.getByLabelText('Your progress')).toHaveTextContent(`5/${lessonUnits(lesson).length} all done`);
  });

  it('saves at the moments that matter: check, commit, reveal, send, done', async () => {
    const user = userEvent.setup();
    const { save } = show();
    await user.click(screen.getByLabelText('The force rule'));
    await user.click(screen.getByLabelText('Sure'));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(save).toHaveBeenCalledWith('item:w1', { choice: 1, confidence: 'sure', result: 1 });

    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'renormalize' } });
    await user.click(screen.getByRole('button', { name: 'Commit prediction' }));
    expect(save).toHaveBeenCalledWith('block:why-not-derivative/2', { prediction: 'renormalize' });

    const predict = screen.getByText('Predict').closest('.predict') as HTMLElement;
    await user.click(within(predict).getAllByRole('radio')[0]!);
    await user.click(within(predict).getByRole('button', { name: 'Reveal' }));
    expect(save).toHaveBeenCalledWith('block:side/0', { answer: expect.any(String) });

    fireEvent.change(screen.getByLabelText('Your explanation'), { target: { value: 'Because it lives in the child frame.' } });
    await user.click(screen.getByRole('button', { name: 'Send to your tutor' }));
    expect(save).toHaveBeenCalledWith('block:exit/0', { text: 'Because it lives in the child frame.' });

    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(save).toHaveBeenCalledWith('task:step-2', { done: true });
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(save).toHaveBeenLastCalledWith('task:step-2', null);
  });

  it('opens where the learner was, and notes the section being read', () => {
    vi.useFakeTimers();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset['section'] ?? '');
    };
    let fire: (entries: { isIntersecting: boolean; target: Element }[]) => void = () => undefined;
    const observed: Element[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof fire) {
          fire = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {}
      },
    );
    const { save, unmount } = show({ position: 'side' });
    expect(scrolled).toEqual(['side']);
    expect(observed).toHaveLength(lesson.sections.length);
    const at = (id: string) => observed.find((e) => (e as HTMLElement).dataset['section'] === id)!;
    act(() => fire([{ isIntersecting: true, target: at('side') }])); // where it already was: nothing to save
    act(() => fire([{ isIntersecting: false, target: at('exit') }]));
    act(() => fire([{ isIntersecting: true, target: at('build') }]));
    act(() => fire([{ isIntersecting: true, target: at('exit') }])); // quick scrolling: only the last one counts
    act(() => vi.advanceTimersByTime(900));
    expect(save.mock.calls).toEqual([['position', 'exit']]);
    unmount();
  });

  it('works without IntersectionObserver or a saved place', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    show({ 'task:step-2': null, 'item:w1': { choice: 1, result: 1 }, position: 42 });
    expect(screen.getByRole('checkbox', { name: 'Done' })).not.toBeChecked();
    expect(screen.getByLabelText('Your progress')).toHaveTextContent(`1/${lessonUnits(lesson).length} done so far`);
  });

  it('says "all done" when every unit is done', () => {
    show(Object.fromEntries(lessonUnits(lesson).map((k) => [k, { done: true }])));
    expect(screen.getByLabelText('Your progress')).toHaveTextContent('all done');
  });
});

describe('progress in the project', () => {
  it('waits for saved progress, sends saves to the server, and shows counts in the contents', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const loaded = new Promise<void>((r) => (release = r));
    const r = new FakeRpc()
      .handle('lessons.list', () => [
        { id: 'hmp-09-four-numbers', title: 'Four Numbers, Three Speeds', kind: 'build', estimateMin: 120, progress: { done: 5, total: 5 } },
        { id: 'b', title: 'B', kind: 'build', estimateMin: 5, progress: { done: 1, total: 4 } },
        { id: 'c', title: 'C', kind: 'build', estimateMin: 5, progress: { done: 0, total: 4 } },
      ])
      .handle('lessons.get', () => fourNumbers)
      .handle('progress.get', async () => {
        await loaded;
        return { 'item:w1': { choice: 1, result: 1 } };
      })
      .handle('history.list', () => [])
      .handle('progress.set', () => Promise.reject(new Error('disk full'))); // the page keeps going
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView
          project={{ id: 'p', title: 'P', goal: 'g', why: '', createdAt: '' } as never}
          profile={{ id: 'x', displayName: 'A', settings: { changeMode: 'review', sessionMode: 'lesson' } } as never}
          onProfile={() => undefined}
          onBack={() => undefined}
        />
      </RpcProvider>,
    );
    expect(await screen.findByLabelText('5 of 5 done')).toHaveClass('all');
    expect(screen.getByLabelText('1 of 4 done')).not.toHaveClass('all');
    expect(screen.queryByLabelText('0 of 4 done')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Four Numbers, Three Speeds' })).toBeNull();
    await act(async () => release());
    expect(await screen.findByText('Right.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(r.calls.find((c) => c.method === 'progress.set')!.params).toEqual({ projectId: 'p', lessonId: 'hmp-09-four-numbers', key: 'task:step-2', value: { done: true } });
    expect(screen.getByLabelText('Your progress')).toHaveTextContent('2/');
  });
});

describe('saved conversations', () => {
  const form = { title: 'Quick', questions: [{ id: 'q', kind: 'single', prompt: 'Pick', options: ['one', 'two'], allowUnsure: true, optional: false, allowOther: false }] } as const;
  const saved: TranscriptEntry[] = [
    { t: 'ask', askId: 'a1', at: '', question: 'Interview me' },
    { t: 'event', askId: 'a1', event: { kind: 'tool', id: 's1', title: 'mcp__aporia__ask_learner', status: 'completed' } },
    { t: 'event', askId: 'a1', event: { kind: 'text', text: 'Here is a form.' } },
    { t: 'event', askId: 'a1', event: { kind: 'form', form: form as never } },
    { t: 'end', askId: 'a1', state: 'done' },
    { t: 'submitted', askId: 'a1', form: 0, answers: { q: { choice: 'two' } } },
    { t: 'ask', askId: 'a2', at: '', question: 'Answers to the form "Quick"', answersTo: 'Quick' },
    { t: 'event', askId: 'a2', event: { kind: 'text', text: 'Thanks, drafting' } },
  ];

  it('replays a saved conversation, marking a turn cut off by a restart', async () => {
    const r = new FakeRpc().handle('history.list', () => []).handle('conversations.get', (p: { thread: string }) => (p.thread === 'session' ? saved : []));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={undefined} />
      </RpcProvider>,
    );
    expect(await screen.findByText('Here is a form.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Quick' })).toHaveTextContent('two');
    expect(screen.getByText('Sent my answers to “Quick”')).toBeInTheDocument();
    expect(screen.getByText(/Cut off: the app closed/)).toBeInTheDocument();
    expect(r.calls.find((c) => c.method === 'conversations.get')!.params).toEqual({ projectId: 'p', thread: 'session' });
  });

  it('offers to continue a cut-off turn', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('history.list', () => [])
      .handle('conversations.get', () => saved)
      .handle('conversations.running', () => [])
      .handle('ask', () => ({ askId: 'a3' }));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={undefined} />
      </RpcProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({ question: CONTINUE, thread: 'session' });
    // Working again: no second offer.
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  it('keeps a turn that is still running when the page reloads, and follows it', async () => {
    const busy: boolean[] = [];
    const r = new FakeRpc()
      .handle('history.list', () => [])
      .handle('conversations.get', () => saved)
      .handle('conversations.running', () => ['a2']);
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={undefined} onBusy={(b) => busy.push(b)} />
      </RpcProvider>,
    );
    expect(await screen.findByText('Thanks, drafting')).toBeInTheDocument();
    expect(screen.queryByText(/Cut off/)).not.toBeInTheDocument();
    await waitFor(() => expect(busy.at(-1)).toBe(true));
    act(() => r.emit('ask.event', { askId: 'a2', event: { kind: 'tool', id: 't', title: 'Draft the lesson', status: 'completed' } }));
    act(() => r.emit('ask.done', { askId: 'a2', stopReason: 'end_turn' }));
    await waitFor(() => expect(busy.at(-1)).toBe(false));
  });

  it('sends form answers with their structure, so the summary comes back after a restart', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('history.list', () => [])
      .handle('conversations.get', () => saved.slice(0, 5))
      .handle('ask', () => ({ askId: 'a9' }));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={undefined} variant="chat" />
      </RpcProvider>,
    );
    await user.click(await screen.findByLabelText('one'));
    await user.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({
      thread: 'chat',
      answers: { askId: 'a1', form: 0, title: 'Quick', values: { q: { choice: 'one' } } },
    });
  });

  it('keeps turns that started while the saved conversation loaded', async () => {
    let release!: (e: TranscriptEntry[]) => void;
    const r = new FakeRpc()
      .handle('history.list', () => [])
      .handle('conversations.get', () => new Promise((res) => (release = res)))
      .handle('ask', () => ({ askId: 'new' }));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={{ question: 'fresh question', nonce: 1 }} />
      </RpcProvider>,
    );
    await screen.findByText('fresh question');
    await act(async () => release(saved.slice(0, 5)));
    const questions = [...document.querySelectorAll('.you .question')].map((q) => q.textContent);
    expect(questions).toEqual(['Interview me', 'fresh question']);
  });

  it('starts empty when the saved conversation cannot be read', async () => {
    const r = new FakeRpc().handle('history.list', () => []).handle('conversations.get', () => Promise.reject(new Error('disk')));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={undefined} intro={<p>Welcome</p>} />
      </RpcProvider>,
    );
    expect(await screen.findByText('Welcome')).toBeInTheDocument();
  });
});

describe('turn reducer', () => {
  it('ignores repeats and unknown turns, and records errors and blocks', () => {
    let ts = applyEntry([], { t: 'ask', askId: 'a', at: '', question: 'q', selection: 'sel' });
    ts = applyEntry(ts, { t: 'ask', askId: 'a', at: '', question: 'q again' });
    expect(ts).toHaveLength(1);
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'tool', id: 't', status: 'pending' } });
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'tool', id: 't', title: 'mcp__aporia__draft_lesson', status: 'completed' } });
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'tool', id: 't', title: 'other' } });
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'permission', title: 'Bash', decision: { allow: false, reason: 'no' } } });
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'permission', title: 'Read', decision: { allow: true, reason: 'ok' } } });
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'blocked-fs', op: 'write', path: '/w/src/main.rs' } });
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'blocked-fs', op: 'read', path: 'C:\\w\\secret.txt' } });
    ts = applyEntry(ts, { t: 'event', askId: 'a', event: { kind: 'thought', text: 'hmm' } });
    ts = applyEntry(ts, { t: 'event', askId: 'zz', event: { kind: 'text', text: 'lost' } });
    ts = applyEntry(ts, { t: 'end', askId: 'a', state: 'error', error: 'agent crashed' });
    expect(ts[0]).toMatchObject({
      selection: 'sel',
      steps: [{ id: 't', title: 'mcp__aporia__draft_lesson', status: 'completed' }],
      blocked: [expect.any(String), 'writing main.rs', 'reading secret.txt'],
      state: 'error',
      error: 'agent crashed',
      answer: '',
    });
    expect(replay([{ t: 'ask', askId: 'b', at: '', question: 'q' }, { t: 'end', askId: 'b', state: 'cancelled' }])[0]!.state).toBe('cancelled');
  });
});
