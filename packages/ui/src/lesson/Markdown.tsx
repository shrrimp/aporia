import { createContext, useContext, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/** Decides whether a code block may give away an open task; returns that task's title, or undefined to show it. */
export type CodeGate = (code: string) => string | undefined;

type Hast = { type: string; value?: string; children?: Hast[] };
const textOf = (n: Hast | undefined): string => (n?.value ?? '') + (n?.children ?? []).map(textOf).join('');

/** A code block held back because it looks like the answer to a task the learner is still working on. */
function GatedPre({ gate, node, children, ...rest }: ComponentProps<'pre'> & { gate: CodeGate; node?: Hast }) {
  const [shown, setShown] = useState(false);
  const task = gate(textOf(node));
  if (task === undefined || shown) return <pre {...rest}>{children as ReactNode}</pre>;
  return (
    <div className="solution-gate" role="note">
      <p>
        This code may be the answer to <strong>{task}</strong>, which you are still working on. It is hidden so you can work it out yourself.
      </p>
      <button type="button" onClick={() => setShown(true)}>
        Show anyway
      </button>
    </div>
  );
}

/**
 * Where a link to a lesson goes (`#lesson:<lessonId>` or `#lesson:<lessonId>/<anchor>`, written by
 * the tutor to send the learner back to the lesson). Absent where there is no lesson to show.
 */
export const LessonLinkContext = createContext<((lessonId: string, anchor: string | undefined) => void) | undefined>(undefined);

const LESSON_LINK = /^#lesson:([a-z0-9][a-z0-9-]{0,63})(?:\/(.+))?$/;

/** A link in lesson or tutor text. A lesson link opens that place in the lesson. */
function Link({ href, children, node: _node, ...rest }: ComponentProps<'a'> & { node?: unknown }) {
  const go = useContext(LessonLinkContext);
  const lesson = href ? LESSON_LINK.exec(href) : null;
  if (!lesson) return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
  if (!go) return <span>{children}</span>;
  return (
    <button type="button" className="text lesson-link" onClick={() => go(lesson[1]!, lesson[2])}>
      {children}
    </button>
  );
}

/**
 * Lesson and tutor text: CommonMark + TeX. react-markdown never renders raw HTML, so agent text
 * cannot inject markup. With a `gate`, code blocks that look like an open task's solution are hidden.
 */
export function Markdown({ md, inline = false, gate }: { md: string; inline?: boolean; gate?: CodeGate | undefined }) {
  const components: Components = useMemo(
    () => ({ a: Link, ...(gate ? { pre: ({ node, ...props }) => <GatedPre gate={gate} node={node as Hast} {...props} /> } : {}) }),
    [gate],
  );
  return (
    <div className={inline ? 'md md-inline' : 'md'}>
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]} skipHtml components={components}>
        {md}
      </ReactMarkdown>
    </div>
  );
}
