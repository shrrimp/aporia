import type { AskShown } from '@app/server/protocol';
import { Markdown } from '../lesson/Markdown.tsx';
import type { Turn } from './turns.ts';

type CardKind = Exclude<AskShown['kind'], 'message'> | 'answers';

/** Each kind of request the app writes: its name, and in plain words what it asks, where the learner wrote nothing. */
const CARDS: Record<CardKind, { label: string; line?: string }> = {
  hint: { label: 'Hint request' },
  'check-answer': { label: 'Answer to check' },
  'explain-back': { label: 'Explanation to check' },
  interview: { label: 'Interview', line: 'Find out what I already know, then write the first lesson.' },
  'existing-work': { label: 'Start from my work', line: 'Look at what I have done, check the skills it suggests, then plan from where I really am.' },
  plan: { label: 'Plan what’s next', line: 'Propose what to learn next from my progress, and draft that lesson.' },
  'draft-lesson': { label: 'Write the next lesson' },
  continue: { label: 'Continue', line: 'Pick up where you left off.' },
  answers: { label: 'Answers sent' },
};

function Files({ names }: { names: readonly string[] | undefined }) {
  if (!names?.length) return null;
  return (
    <ul className="request-files" aria-label="Files added">
      {names.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}

/**
 * What the learner sent, as they would put it. Their own message is shown as written; a request
 * the app wrote for them (a hint, an answer to check, the interview) is a card with their words,
 * never the prompt the tutor got.
 */
export function YouSaid({ turn }: { turn: Turn }) {
  const shown = turn.shown;
  const quote = turn.selection && <blockquote className="quote">{turn.selection}</blockquote>;
  if (!turn.answersTo && (!shown || shown.kind === 'message')) {
    const text = shown ? shown.text : turn.question;
    return (
      <>
        {quote}
        {text && <p className="question">{text}</p>}
        <Files names={shown?.files} />
      </>
    );
  }
  const kind: CardKind = turn.answersTo ? 'answers' : (shown!.kind as CardKind);
  const card = CARDS[kind];
  const about = turn.answersTo ?? shown?.about;
  return (
    <>
      {quote}
      <div className={`request kind-${kind}`} role="group" aria-label={card.label}>
        <p className="request-head">
          <span className="request-mark" aria-hidden />
          {card.label}
        </p>
        {about &&
          (kind === 'check-answer' || kind === 'explain-back' ? (
            <div className="request-about">
              <Markdown md={about} inline />
            </div>
          ) : (
            <p className="request-about">{about}</p>
          ))}
        {card.line && !shown?.text && <p className="request-line">{card.line}</p>}
        {shown?.text && <p className="request-text">{shown.text}</p>}
        <Files names={shown?.files} />
      </div>
    </>
  );
}
