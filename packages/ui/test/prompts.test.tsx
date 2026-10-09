// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { TranscriptEntry } from '@app/server/protocol';
import { checkAnswer, CONTINUE, draftLesson, EXISTING_WORK, explainBack, hintRequest, INTERVIEW, PLAN_MORE, PLAN_NEXT, shownFor } from '../src/prompts.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { Conversation } from '../src/screens/Conversation.tsx';
import { FakeRpc } from './fake-rpc.ts';

describe('the prompts the app writes', () => {
  const item = { id: 's', kcs: ['spatial.force'], prompt: 'What happens to $f$?', answer: 'It rotates.', difficulty: 2 };
  it.each([
    ['interview', INTERVIEW],
    ['existing work', EXISTING_WORK],
    ['plan next', PLAN_NEXT],
    ['plan more', PLAN_MORE],
    ['continue', CONTINUE],
    ['draft', draftLesson('Closing the loop', 'next')],
    ['hint, nothing tried', hintRequest('integratePosition', '')],
    ['hint, tried', hintRequest('integratePosition', 'I multiplied on the left.')],
    ['answer', checkAnswer(item, 'It rotates, and the moment picks up r × f')],
    ['explain-back', explainBack({ kcs: ['a.b', 'c'], prompt: 'Why rotate?', rubric: ['frame', 'midpoint'] }, 'Into the parent frame.\nAt the midpoint.')],
  ])('recognises a saved %s prompt as its card', (_, p) => {
    expect(shownFor(p.question)).toEqual(p.shown);
  });

  it('keeps only the learner’s words of a hint request', () => {
    const p = hintRequest('integratePosition', 'I multiplied on the left');
    expect(p.question).toBe('I\'m stuck on task "integratePosition". What I tried: I multiplied on the left. Give me the lowest hint level that helps.');
    expect(p.shown).toEqual({ kind: 'hint', about: 'integratePosition', text: 'I multiplied on the left' });
  });

  it('recognises the note about added files, and leaves the learner’s own messages alone', () => {
    expect(shownFor('Look at these\n\nI added 2 files to the project: "a.pdf" (src_9), "b.md" (src_8).')).toEqual({ kind: 'message', text: 'Look at these', files: ['a.pdf', 'b.md'] });
    expect(shownFor('I added a file to the project: "x.html" (src_1). Have a look.')).toEqual({ kind: 'message', files: ['x.html'] });
    expect(shownFor('Why does the moment get nothing?')).toBeUndefined();
    expect(shownFor("I'm stuck on task \"x\" and I don't know why")).toBeUndefined();
  });
});

describe('what the learner sees of their requests', () => {
  it('shows a card with the learner’s words instead of the prompt, for saved and new requests', async () => {
    const saved: TranscriptEntry[] = [
      // Saved before cards: recognised from its prompt.
      { t: 'ask', askId: 'a1', at: '', question: hintRequest('integratePosition', 'I multiplied on the left').question },
      { t: 'end', askId: 'a1', state: 'done' },
      { t: 'ask', askId: 'a2', at: '', question: INTERVIEW.question, shown: INTERVIEW.shown },
      { t: 'end', askId: 'a2', state: 'done' },
      { t: 'ask', askId: 'a3', at: '', question: 'Plain question' },
      { t: 'end', askId: 'a3', state: 'done' },
      { t: 'ask', askId: 'a4', at: '', ...checkAnswer({ id: 's', kcs: ['k'], prompt: 'What is *f*?', answer: 'x', difficulty: 2 }, 'A force') },
      { t: 'end', askId: 'a4', state: 'done' },
    ];
    const r = new FakeRpc().handle('history.list', () => []).handle('conversations.get', () => saved);
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={undefined} />
      </RpcProvider>,
    );
    const hint = await screen.findByRole('group', { name: 'Hint request' });
    expect(hint).toHaveTextContent('integratePosition');
    // The old prompt ended what the learner wrote with a full stop: it cannot be told apart now.
    expect(within(hint).getByText('I multiplied on the left.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Interview' })).toHaveTextContent('Find out what I already know');
    expect(screen.getByText('Plain question')).toBeInTheDocument();
    // The question is lesson text: rendered, not shown raw.
    const answer = screen.getByRole('group', { name: 'Answer to check' });
    expect(within(answer).getByText('f').tagName).toBe('EM');
    expect(answer).toHaveTextContent('A force');
    expect(screen.queryByText(/lowest hint level|Interview me briefly/)).toBeNull();
  });
});
