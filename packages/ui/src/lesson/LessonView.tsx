import { useContext, useEffect, useRef } from 'react';
import { lessonCompletion, POSITION_KEY, type Lesson } from '@app/catalog';
import { Markdown } from './Markdown.tsx';
import { Block } from './Blocks.tsx';
import { AnchorContext, ProgressContext } from './progress.tsx';

const ROLE_LABEL: Record<string, string> = {
  warmup: 'Warm-up',
  hook: 'The problem',
  concept: 'Idea',
  practice: 'Practice',
  build: 'Build',
  exit: 'Check yourself',
  'open-loop': 'Next',
};

/**
 * Opens where the learner left off, then keeps note of the section being read: the one whose
 * heading most recently crossed the upper part of the screen.
 */
function useReadingPosition(article: React.RefObject<HTMLElement | null>) {
  const { saved, save } = useContext(ProgressContext);
  const start = useRef(saved[POSITION_KEY]);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const root = article.current;
    if (!root) return;
    if (typeof start.current === 'string') {
      void root.querySelector(`[data-section="${CSS.escape(start.current)}"]`)?.scrollIntoView?.({ block: 'start' });
    }
    if (typeof IntersectionObserver === 'undefined') return;
    let last = start.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset['section']!);
        const id = seen.at(-1);
        if (id === undefined || id === last) return;
        last = id;
        clearTimeout(timer);
        timer = setTimeout(() => saveRef.current(POSITION_KEY, id), 800);
      },
      { rootMargin: '0px 0px -60% 0px' },
    );
    root.querySelectorAll('[data-section]').forEach((el) => io.observe(el));
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [article]);
}

/** A whole lesson. Every block carries a data-anchor so questions can point at it. */
export function LessonView({ lesson }: { lesson: Lesson }) {
  const ref = useRef<HTMLElement>(null);
  useReadingPosition(ref);
  const { saved } = useContext(ProgressContext);
  const progress = lessonCompletion(lesson, saved);
  return (
    <article className="lesson" ref={ref}>
      <header className="lesson-head">
        <p className="meta">
          {lesson.kind.charAt(0).toUpperCase() + lesson.kind.slice(1)} · about {lesson.estimateMin} min
        </p>
        <h1>{lesson.title}</h1>
        <div className="standfirst">
          <Markdown md={lesson.standfirst} />
        </div>
        {lesson.capability && <p className="capability">After this: {lesson.capability}</p>}
        {progress.total > 0 && (
          <p className="lesson-progress" aria-label="Your progress">
            <span className="num">
              {progress.done}/{progress.total}
            </span>{' '}
            {progress.done === progress.total ? 'all done' : 'done so far'}
          </p>
        )}
      </header>
      {lesson.sections.map((s, si) => (
        <section key={s.id} className={`lesson-section role-${s.role}`} data-anchor={s.id} data-section={s.id}>
          <h2>
            <span className="num">{String(si + 1).padStart(2, '0')}</span>
            {s.title ?? ROLE_LABEL[s.role]}
          </h2>
          {s.blocks.map((b, bi) => (
            <div key={bi} className={`block type-${b.type}`} data-anchor={`${s.id}/${bi}`}>
              <AnchorContext.Provider value={`${s.id}/${bi}`}>
                <Block doc={b} />
              </AnchorContext.Provider>
            </div>
          ))}
        </section>
      ))}
    </article>
  );
}
