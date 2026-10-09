import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue, ReviewSlotDTO, ServerEvents } from '@app/server/protocol';
import { useEvent, useQuery, useRpc } from '../hooks.tsx';
import { Item } from '../lesson/Drill.tsx';
import { Markdown } from '../lesson/Markdown.tsx';
import { LessonActionsContext, type LessonActions } from '../lesson/actions.tsx';
import { ProgressContext, type LessonProgress } from '../lesson/progress.tsx';
import { PixelMark } from '../PixelMark.tsx';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

type Question = NonNullable<ReviewSlotDTO['question']>;

/**
 * One due skill and the question chosen for it. The answer is recorded on the question, which
 * reviews every skill it tests, and kept only in memory for the page. A question that makes no
 * sense without its lesson can be flagged: it is never asked again, and an answer already given
 * to it no longer counts.
 */
function ReviewCard({ projectId, skill, q, onDone }: { projectId: string; skill: string; q: Question; onDone: () => void }) {
  const rpc = useRpc();
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [evidence, setEvidence] = useState<Promise<string | undefined>>();
  const [flagged, setFlagged] = useState<'sending' | 'done' | 'failed'>();
  const progress: LessonProgress = useMemo(() => ({ saved: values, save: (key, value) => setValues((v) => ({ ...v, [key]: value })) }), [values]);
  const actions: LessonActions = useMemo(
    () => ({
      recordAnswer: (a) => {
        onDone();
        const evidenceType = a.evidenceType === 'recognition' ? 'recognition' : 'production';
        setEvidence(
          rpc.call('reviews.answer', { projectId, questionId: q.id, evidenceType, outcome: a.outcome, ...(a.confidence ? { confidence: a.confidence } : {}) }).then(
            (r) => r.id,
            () => undefined,
          ),
        );
      },
      // Review only has questions the app scores itself, so nothing here asks the tutor.
      /* v8 ignore next */
      ask: () => undefined,
    }),
    [rpc, projectId, q.id, onDone],
  );
  const flag = async () => {
    setFlagged('sending');
    const evidenceId = await evidence;
    try {
      await rpc.call('reviews.flag', { projectId, questionId: q.id, ...(evidenceId ? { evidenceId } : {}) });
      setFlagged('done');
      if (!evidence) onDone();
    } catch {
      setFlagged('failed');
    }
  };
  // Ids from different lessons can meet on one page: the question's own id keeps the inputs apart.
  const item = useMemo(() => ({ ...q.item, id: q.id.replace(/[^A-Za-z0-9-]/g, '-') }), [q]);
  return (
    <article className={`review-card ${flagged === 'done' ? 'flagged' : ''}`} aria-label={skill}>
      <p className="review-from">
        <span className="review-skill">{skill}</span>
        {q.seen !== 'new' && <span className="review-seen">{q.seen === 'new-numbers' ? 'New numbers' : 'Seen before'}</span>}
        {q.from && <span>From {q.from}</span>}
      </p>
      {flagged === 'done' ? (
        <p className="quiet">Thanks. It won't be asked again{evidence ? ', and your answer to it does not count' : ''}; your tutor will write a better one.</p>
      ) : (
        <LessonActionsContext.Provider value={actions}>
          <ProgressContext.Provider value={progress}>
            {q.context && (
              <div className="review-context">
                <Markdown md={q.context} />
              </div>
            )}
            <ol className="review-item">
              <Item item={item} confidence purpose="review" />
            </ol>
            <p className="review-flag">
              <button type="button" className="text" disabled={flagged === 'sending'} onClick={() => void flag()}>
                Doesn't make sense without the lesson
              </button>
              {flagged === 'failed' && <span className="error"> That did not go through; try again.</span>}
            </p>
          </ProgressContext.Provider>
        </LessonActionsContext.Provider>
      )}
    </article>
  );
}

/**
 * Spaced review (pedagogy-model §7, roadmap 1.10): the skills the scheduler says are due, most
 * at risk first, at most the daily cap, each with a question the learner has not met yet. It
 * tests the skill, not the memory of a question. Retrieval, not rereading: never the lesson.
 */
export function Review({ projectId }: { projectId: string }) {
  // Loaded once per round, so answered questions stay on the page with their feedback.
  const queue = useQuery('reviews.queue', { projectId });
  const d = queue.data;
  const [slots, setSlots] = useState<readonly ReviewSlotDTO[]>();
  const [done, setDone] = useState(new Set<string>());
  // A new round replaces the page; questions the tutor just wrote only fill the skills still waiting.
  const replace = useRef(true);
  useEffect(() => {
    if (!d) return;
    if (replace.current) setSlots(d.slots);
    else setSlots((prev) => prev!.map((s) => (s.question ? s : (d.slots.find((n) => n.kc === s.kc) ?? s))));
    replace.current = false;
  }, [d]);
  const writing = d?.writing === true;
  const { reload } = queue;
  useEvent(
    'changed',
    useCallback(
      (e: ServerEvents['changed']) => {
        if (e.what === 'reviews' && writing) reload();
      },
      [writing, reload],
    ),
  );
  const asked = slots?.filter((s) => s.question) ?? [];
  const left = asked.filter((s) => !done.has(s.kc)).length;
  const another = () => {
    setDone(new Set());
    replace.current = true;
    reload();
  };
  return (
    <section className="review" aria-label="Review">
      <p className="meta">Review</p>
      <h1>What you learned, from memory</h1>
      <p className="standfirst-plain">
        Recalling something just as you start to forget it is what makes it stay. Each skill comes back with a question you have not seen: answer from what you understand,
        without looking back at the lesson. A miss only brings it back sooner.
      </p>
      {d && slots && slots.length === 0 && (
        <p className="quiet">Nothing is due. {d.nextDue ? `The next skill comes back on ${day(d.nextDue)}.` : 'Skills appear here once you have answered questions on them in a lesson.'}</p>
      )}
      {d && slots && slots.length > 0 && (
        <>
          <p className="review-count" role="status">
            <span className="num">{left}</span> of {asked.length} left{d.dueCount > slots.length ? ` (${d.dueCount} skills due in all: the most at risk first)` : ''}
          </p>
          {writing && (
            <p className="review-writing">
              <PixelMark working size={14} /> Your tutor is writing new questions…
            </p>
          )}
          <div className="review-items">
            {slots.map((s) =>
              s.question ? (
                <ReviewCard key={`${s.kc} ${s.question.id}`} projectId={projectId} skill={s.skill} q={s.question} onDone={() => setDone((x) => new Set(x).add(s.kc))} />
              ) : (
                <article key={s.kc} className="review-card waiting" aria-label={s.skill}>
                  <p className="review-from">
                    <span className="review-skill">{s.skill}</span>
                  </p>
                  <p className="quiet">{writing ? 'A question on this skill is being written.' : 'No question on this skill yet.'}</p>
                </article>
              ),
            )}
          </div>
          {left === 0 && (
            <p>
              Done for now.{' '}
              <button type="button" className="text" onClick={another}>
                Check for more
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
