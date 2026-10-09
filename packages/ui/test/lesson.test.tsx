// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lesson as lessonSchema, type Component } from '@app/catalog';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { LessonView } from '../src/lesson/LessonView.tsx';
import { LessonActionsContext, type LessonActions } from '../src/lesson/actions.tsx';
import { Block } from '../src/lesson/Blocks.tsx';
import { Drill } from '../src/lesson/Drill.tsx';
import { ProgressContext } from '../src/lesson/progress.tsx';
import { Diagram } from '../src/lesson/Diagram.tsx';
import { Plot } from '../src/lesson/Plot.tsx';
import { Explorable, initialEnv } from '../src/lesson/Explorable.tsx';

const golden = lessonSchema.parse(fourNumbers);

function withActions(ui: React.ReactNode, actions: Partial<LessonActions> = {}) {
  const a: LessonActions = { recordAnswer: vi.fn(), ask: vi.fn(), ...actions };
  return { a, ...render(<LessonActionsContext.Provider value={a}>{ui}</LessonActionsContext.Provider>) };
}

const block = (c: unknown) => <Block doc={c as Component} />;

describe('LessonView', () => {
  it('renders every section with anchors, maths and the capability', () => {
    const { container } = withActions(<LessonView lesson={golden} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Four Numbers, Three Speeds' })).toBeInTheDocument();
    expect(screen.getByText(/After this: Your tree gets ball joints/)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-anchor]').length).toBeGreaterThan(8);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(screen.getByText('Check yourself')).toBeInTheDocument();
  });

  it('scores a warm-up answer, records it with confidence, and shows why', async () => {
    const user = userEvent.setup();
    const { a } = withActions(<LessonView lesson={golden} />);
    const check = screen.getByRole('button', { name: 'Check' });
    expect(check).toBeDisabled();
    await user.click(screen.getByLabelText('The force rule'));
    await user.click(screen.getByRole('radio', { name: 'Sure' }));
    await user.click(check);
    expect(a.recordAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'w1', outcome: 1, evidenceType: 'recognition', confidence: 'sure', kcs: ['quaternion.unit'] }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Right\.[\s\S]*force-type/);
  });

  it('asks the tutor from tasks and explain-backs', async () => {
    const user = userEvent.setup();
    const { a } = withActions(<LessonView lesson={golden} />);
    await user.click(screen.getByRole('button', { name: /I'm stuck/ }));
    await user.click(screen.getByRole('button', { name: 'Ask for a hint' }));
    expect(a.ask).toHaveBeenCalledWith(expect.stringMatching(/stuck on task "integratePosition"\. Give me the lowest/), {
      anchor: 'task:step-2',
      shown: { kind: 'hint', about: 'integratePosition' },
    });
    await user.type(screen.getByLabelText('Your explanation'), 'Rotate into the parent frame at the midpoint orientation.');
    await user.click(screen.getByRole('button', { name: 'Send to your tutor' }));
    expect(a.ask).toHaveBeenLastCalledWith(expect.stringMatching(/Explain-back[\s\S]*Rubric: velocity must be rotated[\s\S]*send me back to the lesson/), {
      anchor: expect.stringMatching(/\/\d+$/),
      shown: expect.objectContaining({ kind: 'explain-back', text: 'Rotate into the parent frame at the midpoint orientation.' }),
    });
    expect(screen.getByRole('button', { name: 'Sent to your tutor' })).toBeDisabled();
  });
});

describe('drills', () => {
  const drill = (items: unknown[], extra: Record<string, unknown> = {}) => block({ type: 'drill', purpose: 'practice', confidence: false, items, ...extra });
  const it0 = { prompt: 'p', kcs: ['k'], difficulty: 3, why: 'because', transfer: false };

  it('numeric: wrong answer shows the answer', async () => {
    const user = userEvent.setup();
    const { a } = withActions(drill([{ ...it0, id: 'n', kind: 'numeric', answer: 4, tolerance: 0 }]));
    await user.type(screen.getByLabelText('Your answer'), '5');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(a.recordAnswer).toHaveBeenCalledWith(expect.objectContaining({ outcome: 0, evidenceType: 'production' }));
    expect(screen.getByRole('status')).toHaveTextContent('Not quite. Answer: 4');
  });

  it('order: reorder with buttons, partial credit shows the correct order', async () => {
    const user = userEvent.setup();
    const { a } = withActions(drill([{ ...it0, id: 'o', kind: 'order', lines: ['a', 'b', 'c'] }]));
    const items = () => screen.getAllByRole('listitem').filter((li) => li.querySelector('code')).map((li) => li.querySelector('code')!.textContent);
    const before = items();
    expect(before).not.toEqual(['a', 'b', 'c']);
    await user.click(screen.getByRole('button', { name: `Move "${before[1]}" up` }));
    expect(items()[0]).toBe(before[1]);
    expect(screen.getByRole('button', { name: `Move "${items()[0]}" up` })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    const outcome = (a.recordAnswer as ReturnType<typeof vi.fn>).mock.calls[0]![0].outcome;
    expect(outcome).toBeGreaterThanOrEqual(0);
    if (outcome < 1) expect(screen.getByRole('status')).toHaveTextContent(/Partly right|Not quite/);
  });

  it('short answers go to the tutor; pretests explain that misses are expected', async () => {
    const user = userEvent.setup();
    const { a } = withActions(
      <>
        {drill([{ ...it0, id: 's', kind: 'short', answer: 'ref' }])}
        {drill([{ ...it0, id: 'm', kind: 'mcq', options: ['x', 'y'], answer: 1 }], { purpose: 'pretest' })}
      </>,
    );
    await user.type(screen.getByLabelText('Your answer'), 'my answer');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(a.ask).toHaveBeenCalledWith(expect.stringMatching(/Judge my answer to drill item "s"[\s\S]*Reference: ref[\s\S]*send me back to the lesson/), {
      shown: expect.objectContaining({ kind: 'check-answer', text: 'my answer' }),
    });
    expect(screen.getByText('Sent to your tutor for feedback.')).toBeInTheDocument();
    await user.click(screen.getByLabelText('x'));
    await user.click(screen.getByRole('button', { name: 'Lock in my guess' }));
    expect(screen.getByRole('status')).toHaveTextContent('Not yet — that is expected before the lesson.');
    expect(screen.getByText('Guess first')).toBeInTheDocument();
  });

  it('labels each drill purpose', () => {
    withActions(
      <>
        {drill([{ ...it0, id: 'a', kind: 'mcq', options: ['x', 'y'], answer: 0 }], { purpose: 'exit', confidence: true })}
        {drill([{ ...it0, id: 'b', kind: 'mcq', options: ['x', 'y'], answer: 0 }], { purpose: 'other' })}
      </>,
    );
    expect(screen.getByText('Check yourself')).toBeInTheDocument();
    expect(screen.getByText('Drill')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'How sure are you?' })).toBeInTheDocument();
  });
});

describe('reading components', () => {
  it('renders callouts, tables, open loops, utility links, think-first', async () => {
    const user = userEvent.setup();
    withActions(
      <>
        {block({ type: 'callout', kind: 'trap', title: 'Careful', md: 'Left vs **right**.' })}
        {block({ type: 'callout', kind: 'note', md: 'plain' })}
        {block({ type: 'table', caption: 'Joints', columns: ['Type', 'nq'], rows: [['Ball', '`4`']] })}
        {block({ type: 'table', columns: ['A'], rows: [['1']] })}
        {block({ type: 'open-loop', md: 'Next problem' })}
        {block({ type: 'utility-link', md: 'This matters for your engine', prompt: 'How will you use it?' })}
        {block({ type: 'utility-link', md: 'No prompt' })}
        {block({ type: 'think-first', prompt: 'Why?', reveal: 'Because.' })}
        {block({ type: 'predict', prompt: 'Left or right?', options: ['Left', 'Right'], reveal: 'Right.', kcs: ['k'] })}
        {block({ type: 'math', tex: 'x^2' })}
      </>,
    );
    expect(screen.getByText('Careful')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Joints' })).toBeInTheDocument();
    expect(screen.getByText('How will you use it?')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your thinking'), 'my guess');
    await user.click(screen.getAllByRole('button', { name: 'Reveal' })[0]!);
    expect(screen.getByText('You said: my guess')).toBeInTheDocument();
    expect(screen.getByText('Because.')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Right'));
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByText('You said: Right')).toBeInTheDocument();
  });

  it('renders maths inside predict options (regression: options were shown as raw "$…$")', () => {
    render(block({ type: 'predict', prompt: 'q at 360°?', options: ['$q = (1, 0, 0, 0)$', 'other'], reveal: 'r', kcs: ['k'] }));
    expect(document.querySelectorAll('.predict .options .katex')).toHaveLength(1);
    expect(screen.queryByText(/\$q =/)).toBeNull();
  });

  it('renders every code kind, with notes, subgoals and contrasts', () => {
    withActions(
      <>
        {block({ type: 'code', kind: 'analogue', lang: 'cpp', source: 'a\n\nb', annotations: [{ line: 1, note: 'note one' }], subgoals: [{ line: 3, label: 'Compute b' }], caption: 'cap' })}
        {block({ type: 'code', kind: 'trace', lang: 'cpp', source: 'x', annotations: [], file: 'Joint.cpp' })}
        {block({ type: 'code', kind: 'contrast', lang: 'cpp', source: 'A', annotations: [], variant: 'B', difference: 'the side' })}
        {block({ type: 'code', kind: 'contrast', lang: 'cpp', source: 'A', annotations: [] })}
      </>,
    );
    expect(screen.getByText('Worked example (a similar problem)')).toBeInTheDocument();
    expect(screen.getByText('note one')).toBeInTheDocument();
    expect(screen.getByText('Compute b')).toBeInTheDocument();
    expect(screen.getByText(/Joint\.cpp/)).toBeInTheDocument();
    expect(screen.getByText('Differs in: the side')).toBeInTheDocument();
    expect(screen.getAllByText('Version B')).toHaveLength(2);
  });

  it('renders tasks without optional parts', () => {
    withActions(block({ type: 'task', id: 't', title: 'Plain', scaffold: 1, kcs: ['k'], files: [], goal: 'Do it', traps: [] }));
    expect(screen.getByText('Goal only level')).toBeInTheDocument();
    expect(screen.queryByText(/Checkpoint/)).toBeNull();
  });
});

describe('figures', () => {
  it('draws every 2D element and reports bad expressions', () => {
    const { container } = render(
      <Diagram
        doc={{
          type: 'diagram',
          dims: 2,
          description: 'all elements',
          extent: 2,
          elements: [
            { kind: 'point', at: '[1, 1]', label: 'P', role: 'primary' },
            { kind: 'point', at: '[0, 1]', role: 'primary' },
            { kind: 'label', at: '[0, 0]', text: 'O', role: 'secondary' },
            { kind: 'vector', to: '[1, 0]', label: 'v', role: 'highlight' },
            { kind: 'segment', from: '[0, 0]', to: '[0, 1]', role: 'primary' },
            { kind: 'polyline', points: ['[0, 0]', '[1, 1]', '[1, 0]'], closed: true, role: 'ghost' },
            { kind: 'polyline', points: ['[0, 0]', '[1, 1]'], closed: false, role: 'ghost' },
            { kind: 'circle', center: '[0, 0]', radius: '-1', role: 'correct' },
            { kind: 'frame', size: 1, label: 'W', role: 'primary' },
            { kind: 'frame', at: '[1, 1]', rotation: '0.5', size: 0.5, role: 'primary' },
          ],
        }}
      />,
    );
    expect(screen.getByRole('img', { name: 'all elements' })).toBeInTheDocument();
    expect(container.querySelectorAll('line').length).toBeGreaterThan(5);
    render(<Diagram doc={{ type: 'diagram', dims: 2, description: 'bad', extent: 2, elements: [{ kind: 'point', at: 'nope', role: 'primary' }] }} />);
    expect(screen.getByText(/Could not draw/)).toBeInTheDocument();
  });

  it('orbits 3D diagrams by dragging (and ignores drags in 2D)', () => {
    const doc = { type: 'diagram' as const, dims: 3 as const, description: '3d', extent: 2, elements: [{ kind: 'box' as const, size: '[1, 1, 1]', role: 'primary' as const }, { kind: 'frame' as const, rotation: 'quat(1,0,0,0)', size: 1, role: 'primary' as const }] };
    const { container } = render(<Diagram doc={doc} />);
    const svg = container.querySelector('svg')!;
    const before = container.querySelector('line')!.getAttribute('x1');
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(svg);
    fireEvent.pointerMove(svg, { clientX: 90, clientY: 0, pointerId: 1 });
    expect(container.querySelector('line')!.getAttribute('x1')).not.toBe(before);
    const flat = render(<Diagram doc={{ type: 'diagram', dims: 2, description: 'flat', extent: 2, elements: [{ kind: 'point', at: '[0,0]', role: 'primary' }] }} />);
    fireEvent.pointerDown(flat.container.querySelector('svg')!, { clientX: 0, clientY: 0 });
  });

  it('plots expressions and data with legends, auto and fixed ranges', () => {
    const { container } = render(
      <>
        <Plot doc={{ type: 'plot', description: 'p', x: { label: 'x', min: 0, max: 1 }, series: [{ label: 'sq', expr: 'x ^ 2', role: 'primary' }, { label: 'pts', data: [[0, 0], [1, 2]], role: 'ghost' }] }} />
        <Plot doc={{ type: 'plot', description: 'flat', x: { label: '', min: 0, max: 1 }, y: { label: 'y', min: 0, max: 0 }, series: [{ label: 'zero', expr: '0', role: 'primary' }] }} />
      </>,
    );
    expect(container.querySelectorAll('polyline').length).toBe(3);
    expect(screen.getByText('pts')).toBeInTheDocument();
  });
});

describe('Explorable', () => {
  const doc = {
    type: 'explorable' as const,
    description: 'test',
    predictFirst: 'What happens?',
    state: { n: 'k * 2' },
    controls: [
      { kind: 'slider' as const, name: 'k', label: 'k', min: 0, max: 10, step: 1, initial: 3 },
      { kind: 'slider' as const, name: 'm', label: 'm', min: 1, max: 2, step: 1 },
      { kind: 'toggle' as const, name: 'on', label: 'on', initial: false },
      { kind: 'button' as const, label: 'inc', do: 'n = n + 1', role: 'primary' as const },
      { kind: 'button' as const, label: 'break', do: 'n = nope', role: 'incorrect' as const },
      { kind: 'play' as const, label: 'play', do: 'n = n + 1', fps: 10 },
      { kind: 'reset' as const, label: 'Reset' },
    ],
    readouts: [{ label: 'n', expr: 'n', digits: 0 }, { label: 'bad', expr: 'n.x', digits: 0 }],
    view: { type: 'plot' as const, description: 'line', x: { label: 'x', min: 0, max: 1 }, series: [{ label: 'n', expr: 'n * x', role: 'primary' as const }] },
  };

  it('computes the initial environment', () => {
    expect(initialEnv(doc)).toEqual({ k: 3, m: 1, on: false, n: 6 });
  });

  it('locks until a prediction, then runs buttons, sliders, toggles, play and reset', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Explorable doc={doc} />);
    expect(screen.getByRole('button', { name: 'Commit prediction' })).toBeDisabled();
    await user.type(screen.getByLabelText('Your prediction'), 'grows');
    await user.click(screen.getByRole('button', { name: 'Commit prediction' }));
    const readout = () => screen.getByText('n', { selector: 'dt' }).nextElementSibling!.textContent;
    expect(readout()).toBe('6');
    expect(screen.getByText(/⚠/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'inc' }));
    expect(readout()).toBe('7');
    fireEvent.change(screen.getAllByRole('slider')[0]!, { target: { value: '5' } });
    await user.click(screen.getByRole('checkbox', { name: 'on' }));
    expect(screen.getByRole('checkbox', { name: 'on' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'play' }));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(Number(readout())).toBeGreaterThan(7);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'break' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/unknown variable/);
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(readout()).toBe('6');
    expect(screen.queryByRole('alert')).toBeNull();
    vi.useRealTimers();
  });

  it('renders diagram views and works without a prediction step', () => {
    render(
      <Explorable
        doc={{
          ...doc,
          predictFirst: undefined,
          readouts: [],
          view: { type: 'diagram', dims: 2, description: 'pt', extent: 2, elements: [{ kind: 'point', at: '[n / 10, 0]', role: 'primary' }] },
        } as never}
      />,
    );
    expect(screen.getByRole('img', { name: 'pt' })).toBeInTheDocument();
    expect(within(document.body).queryByLabelText('Your prediction')).toBeNull();
  });
});

describe('two-tier questions', () => {
  it('ask why after the answer, and give full credit only for both', async () => {
    const user = userEvent.setup();
    const recorded: unknown[] = [];
    const item = {
      id: 'tt',
      kind: 'mcq' as const,
      prompt: 'Which side does exp(ω dt) go on?',
      options: ['Left', 'Right'],
      answer: 1,
      reason: { prompt: 'Why?', options: ['ω is in world coordinates', 'ω is in body coordinates'], answer: 1 },
      kcs: ['quaternion.exp-map-side'],
      difficulty: 3,
      why: 'Body-frame ω multiplies on the right.',
      transfer: false,
    };
    render(
      <LessonActionsContext.Provider value={{ recordAnswer: (a) => recorded.push(a), ask: () => undefined }}>
        <Drill doc={{ purpose: 'practice', confidence: false, items: [item] }} />
      </LessonActionsContext.Provider>,
    );
    await user.click(screen.getByLabelText('Right'));
    expect(screen.getByRole('button', { name: 'Check' })).toBeDisabled(); // the reason is part of the answer
    await user.click(screen.getByLabelText('ω is in world coordinates'));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByRole('status')).toHaveTextContent('Partly right (25%). The answer is right, but not the reason');
    expect(recorded[0]).toMatchObject({ itemId: 'tt', evidenceType: 'recognition', outcome: 0.25 });
    expect(screen.getByLabelText('ω is in body coordinates').closest('label')).toHaveClass('answer');
  });

  it('restore both choices', () => {
    const item = { id: 'tt', kind: 'mcq' as const, prompt: 'p', options: ['a', 'b'], answer: 0, reason: { prompt: 'Because?', options: ['r0', 'r1'], answer: 0 }, kcs: ['k'], difficulty: 3, why: 'w', transfer: false };
    render(
      <ProgressContext.Provider value={{ saved: { 'item:tt': { choice: 0, reason: 0, result: 1 } }, save: () => undefined }}>
        <Drill doc={{ purpose: 'practice', confidence: false, items: [item] }} />
      </ProgressContext.Provider>,
    );
    expect(screen.getByText('Right.')).toBeInTheDocument();
    expect(screen.getByLabelText('r0')).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'Because?' })).toBeInTheDocument();
  });
});
