import type { Lesson } from '@app/catalog';
import { Markdown } from './Markdown.tsx';
import { Block } from './Blocks.tsx';

const ROLE_LABEL: Record<string, string> = {
  warmup: 'Warm-up',
  hook: 'The problem',
  concept: 'Idea',
  practice: 'Practice',
  build: 'Build',
  exit: 'Check yourself',
  'open-loop': 'Next',
};

/** A whole lesson. Every block carries a data-anchor so questions can point at it. */
export function LessonView({ lesson }: { lesson: Lesson }) {
  return (
    <article className="lesson">
      <header className="lesson-head">
        <p className="eyebrow">
          {lesson.kind} · about {lesson.estimateMin} min
        </p>
        <h1>{lesson.title}</h1>
        <Markdown md={lesson.standfirst} />
        {lesson.capability && <p className="capability">After this: {lesson.capability}</p>}
      </header>
      {lesson.sections.map((s, si) => (
        <section key={s.id} className={`lesson-section role-${s.role}`} data-anchor={s.id}>
          <h2>
            <span className="num">{String(si + 1).padStart(2, '0')}</span>
            {s.title ?? ROLE_LABEL[s.role]}
          </h2>
          {s.blocks.map((b, bi) => (
            <div key={bi} className={`block type-${b.type}`} data-anchor={`${s.id}/${bi}`}>
              <Block doc={b} />
            </div>
          ))}
        </section>
      ))}
    </article>
  );
}
