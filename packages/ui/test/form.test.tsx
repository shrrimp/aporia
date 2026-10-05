// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { learnerForm, type FormAnswer } from '@app/catalog';
import { FormCard, answerText } from '../src/screens/FormCard.tsx';
import { Conversation } from '../src/screens/Conversation.tsx';
import { RpcProvider } from '../src/hooks.tsx';
import { GLYPHS, layout } from '../src/pixelfont.ts';
import { PIXELS, Wordmark } from '../src/PixelMark.tsx';
import { FakeRpc } from './fake-rpc.ts';

const form = learnerForm.parse({
  title: 'Where you are starting from',
  intro: 'No wrong answers.',
  questions: [
    { id: 'bg', kind: 'single', prompt: 'Background?', options: ['Never', 'Matrices'], allowOther: true },
    { id: 'tools', kind: 'multi', prompt: 'Tools?', options: ['glm', 'numpy'], allowOther: true },
    { id: 'conf', kind: 'scale', prompt: 'Comfort?', low: 'shaky', high: 'fluent' },
    { id: 'probe', kind: 'text', prompt: 'Why?', placeholder: 'One sentence' },
    { id: 'essay', kind: 'text', prompt: 'Long?', long: true, optional: true },
    { id: 'hours', kind: 'number', prompt: 'Hours?', unit: 'h', min: 0, max: 40 },
    { id: 'plain', kind: 'number', prompt: 'Any number?', optional: true, allowUnsure: false },
    { id: 'rank', kind: 'rank', prompt: 'Order', options: ['maths', 'code', 'drift'] },
  ],
  submitLabel: 'Send answers',
});

describe('FormCard', () => {
  it('collects every kind of answer by clicking, counts progress, and submits one structured message', async () => {
    const user = userEvent.setup();
    let sent: { message: string; answers: Record<string, FormAnswer> } | undefined;
    render(<FormCard form={form} onSubmit={(message, answers) => (sent = { message, answers })} />);
    expect(screen.getByText('No wrong answers.')).toBeInTheDocument();
    const progress = () => screen.getByText(/answered/).textContent;
    expect(progress()).toBe('3/8 answered'); // rank has a default order; optional questions count as answered
    expect(screen.getByRole('button', { name: 'Send answers' })).toBeDisabled();

    await user.click(screen.getByLabelText('Matrices'));
    await user.type(screen.getAllByLabelText('Something else')[0]!, 'Hmm');
    // typing into the single-choice "other" replaces the choice; clear it to come back to nothing
    fireEvent.change(document.querySelectorAll('input.other-input')[0]!, { target: { value: '' } });
    await user.click(screen.getByLabelText('Matrices'));

    await user.click(screen.getByLabelText('glm'));
    await user.click(screen.getByLabelText('numpy'));
    await user.click(screen.getByLabelText('numpy')); // toggles off
    fireEvent.change(document.querySelectorAll('input.other-input')[1]!, { target: { value: 'Eigen' } });
    fireEvent.change(document.querySelectorAll('input.other-input')[1]!, { target: { value: '' } });
    fireEvent.change(document.querySelectorAll('input.other-input')[1]!, { target: { value: 'Eigen' } });

    await user.click(screen.getByLabelText('4 of 5'));
    await user.click(screen.getAllByLabelText("I don't know yet")[3]!); // probe: unsure
    await user.click(screen.getAllByLabelText("I don't know yet")[3]!); // and back
    await user.click(screen.getAllByLabelText("I don't know yet")[3]!);
    fireEvent.change(screen.getByLabelText('Hours?'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Hours?'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Hours?'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Long?'), { target: { value: 'details' } });
    await user.click(screen.getByRole('button', { name: 'Move "drift" up' }));
    await user.click(screen.getByRole('button', { name: 'Move "maths" down' }));
    expect(progress()).toBe('8/8 answered');
    expect(screen.queryAllByLabelText("I don't know yet")).toHaveLength(7); // "plain" disables it

    await user.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(sent!.answers).toMatchObject({
      bg: { choice: 'Matrices' },
      tools: { choices: ['glm', 'Eigen'] },
      conf: { scale: 4 },
      probe: { unsure: true },
      hours: { number: 6 },
      essay: { text: 'details' },
      plain: { skipped: true },
      rank: { order: ['drift', 'maths', 'code'] },
    });
    expect(sent!.message).toMatch(/^Answers to the form "Where you are starting from":/);
  });

  it('text answers must not be blank, and the summary shows what was sent', () => {
    const f = learnerForm.parse({ title: 'T', questions: [{ id: 'a', kind: 'text', prompt: 'A?' }, { id: 'b', kind: 'multi', prompt: 'B?', options: ['x', 'y'] }] });
    const { rerender } = render(<FormCard form={f} onSubmit={() => undefined} />);
    fireEvent.change(screen.getByLabelText('A?'), { target: { value: '   ' } });
    expect(screen.getByText(/answered/).textContent).toBe('0/2 answered');
    rerender(<FormCard form={form} onSubmit={() => undefined} submitted={{ bg: { choice: 'Never' }, conf: { scale: 3 }, probe: { unsure: true }, rank: { order: ['a', 'b'] } }} />);
    const sentCard = screen.getByRole('region', { name: 'Where you are starting from' });
    expect(sentCard).toHaveTextContent('Never');
    expect(sentCard).toHaveTextContent('3/5');
    expect(sentCard).toHaveTextContent("don't know yet");
    expect(sentCard).toHaveTextContent('a › b');
  });

  it('answerText covers every shape', () => {
    expect(answerText(undefined)).toBe('—');
    expect(answerText({ skipped: true })).toBe('—');
    expect(answerText({ choices: [] })).toBe('—');
    expect(answerText({ choices: ['a', 'b'] })).toBe('a, b');
    expect(answerText({ text: '' })).toBe('—');
    expect(answerText({ text: 'x' })).toBe('x');
    expect(answerText({ number: 2 })).toBe('2');
  });
});

describe('forms inside the conversation', () => {
  it('renders a form the tutor sent and returns the answers as the next message', async () => {
    const user = userEvent.setup();
    let n = 0;
    const r = new FakeRpc().handle('history.list', () => []).handle('ask', () => ({ askId: `a${++n}` }));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={{ question: 'Interview me', nonce: 1 }} />
      </RpcProvider>,
    );
    await screen.findByText('Interview me');
    const small = learnerForm.parse({ title: 'Quick', questions: [{ id: 'q', kind: 'single', prompt: 'Pick', options: ['one', 'two'] }] });
    act(() => r.emit('ask.event', { askId: 'a1', event: { kind: 'form', form: small } }));
    act(() => r.emit('ask.done', { askId: 'a1', stopReason: 'end_turn' }));
    await user.click(screen.getByLabelText('two'));
    await user.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(r.calls.filter((c) => c.method === 'ask').at(-1)!.params).toMatchObject({ question: expect.stringMatching(/^Answers to the form "Quick"/) });
    expect(await screen.findByText('Sent my answers to “Quick”')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
  });
});

describe('pixel lettering', () => {
  it('lays out "aporia" on a 9-row grid and refuses unknown glyphs', () => {
    const w = layout('aporia');
    expect(w.height).toBe(9);
    expect(w.width).toBe(4 + 1 + 4 + 1 + 4 + 1 + 4 + 1 + 1 + 1 + 4);
    expect(w.pixels.every((p) => p.y >= 0 && p.y < 9 && p.x >= 0 && p.x < w.width)).toBe(true);
    expect(() => layout('z')).toThrow(/no pixel glyph/);
    expect(Object.values(GLYPHS).every((g) => g.length === 9)).toBe(true);
    expect(PIXELS.every((p) => p.y >= 0)).toBe(true);
  });

  it('renders the wordmark as an image named Aporia', () => {
    const { container, rerender } = render(<Wordmark />);
    expect(screen.getByRole('img', { name: 'Aporia' })).not.toHaveClass('working');
    expect(container.querySelectorAll('rect').length).toBe(layout('aporia').pixels.length);
    rerender(<Wordmark working height={30} />);
    expect(screen.getByRole('img', { name: 'Aporia' })).toHaveClass('working');
  });
});
