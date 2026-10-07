import { useMemo, useState } from 'react';
import type { JsonValue, ReviewItemDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';
import { Item } from '../lesson/Drill.tsx';
import { LessonActionsContext, type LessonActions } from '../lesson/actions.tsx';
import { ProgressContext, type LessonProgress } from '../lesson/progress.tsx';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/**
 * One review item. Its answer is recorded as evidence on the original item (so it reschedules),
 * and kept only in memory for the page: the lesson's own saved answer is left as it was.
 */
function ReviewCard({ projectId, entry, onAnswered }: { projectId: string; entry: ReviewItemDTO; onAnswered: () => void }) {
  const rpc = useRpc();
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const progress: LessonProgress = useMemo(() => ({ saved: values, save: (key, value) => setValues((v) => ({ ...v, [key]: value })) }), [values]);
  const actions: LessonActions = useMemo(
    () => ({
      recordAnswer: (a) => {
        onAnswered();
        void rpc.call('answers.record', {
          projectId,
          lessonId: entry.lessonId,
          itemId: a.itemId,
          kcs: [...a.kcs],
          difficulty: a.difficulty,
          evidenceType: a.evidenceType,
          outcome: a.outcome,
          transfer: a.transfer,
          ...(a.confidence ? { confidence: a.confidence } : {}),
        });
      },
      // Review only has items the app scores itself, so nothing here asks the tutor.
      /* v8 ignore next */
      ask: () => undefined,
    }),
    [rpc, projectId, entry.lessonId, onAnswered],
  );
  return (
    <LessonActionsContext.Provider value={actions}>
      <ProgressContext.Provider value={progress}>
        <p className="review-from">From {entry.lessonTitle}</p>
        <ol className="review-item">
          <Item item={entry.item} confidence purpose="review" />
        </ol>
      </ProgressContext.Provider>
    </LessonActionsContext.Provider>
  );
}

/**
 * Spaced review (pedagogy-model §7): the items the scheduler says are due, most at risk first,
 * at most the daily cap. Retrieval, not rereading: only the question is shown, never the lesson.
 */
export function Review({ projectId }: { projectId: string }) {
  // Loaded once per round, so answered items stay on the page with their feedback.
  const queue = useQuery('reviews.queue', { projectId });
  const [answered, setAnswered] = useState(new Set<string>());
  const d = queue.data;
  const left = d ? d.items.filter((i) => !answered.has(i.itemId)).length : 0;
  const another = () => {
    setAnswered(new Set());
    queue.reload();
  };
  return (
    <section className="review" aria-label="Review">
      <p className="meta">Review</p>
      <h1>What you learned, from memory</h1>
      <p className="standfirst-plain">
        Recalling something just as you start to forget it is what makes it stay. Answer without looking back at the lesson; a miss only brings the item back
        sooner.
      </p>
      {d && d.items.length === 0 && (
        <p className="quiet">Nothing is due. {d.nextDue ? `The next item comes back on ${day(d.nextDue)}.` : 'Items appear here once you have answered them in a lesson.'}</p>
      )}
      {d && d.items.length > 0 && (
        <>
          <p className="review-count" role="status">
            <span className="num">{left}</span> of {d.items.length} left{d.dueCount > d.items.length ? ` (${d.dueCount} due in all: the most at risk first)` : ''}
          </p>
          <div className="review-items">
            {d.items.map((entry) => (
              <ReviewCard key={entry.itemId} projectId={projectId} entry={entry} onAnswered={() => setAnswered((s) => new Set(s).add(entry.itemId))} />
            ))}
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
