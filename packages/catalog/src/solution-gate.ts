import type { Lesson } from './schema.ts';
import { taskKey } from './progress.ts';

/**
 * The last guard against showing a learner the answer by accident (architecture §2, layer 5):
 * a code block in the tutor's reply that *implements* a function an open task asks the learner
 * to write is hidden behind "show anyway". Heuristic and deterministic. It is the last layer,
 * not the first, so it errs towards hiding: one extra click costs less than a spoiled task.
 */
export interface TaskShape {
  readonly taskId: string;
  readonly title: string;
  /** Names the learner is asked to write (from the task's stubs, and its title when it is a name). */
  readonly names: readonly string[];
}

const NOT_A_NAME = new Set([
  'if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'decltype', 'static_assert', 'assert', 'alignof', 'typeof', 'new', 'delete',
  'main', 'void', 'int', 'double', 'float', 'auto', 'const', 'template', 'operator', 'print', 'printf', 'println',
]);

/**
 * Function definitions in the common languages. Each pattern is linear-time on any input: the
 * repeated parts are separated by characters that cannot belong to both sides.
 */
const DECLARED = [
  // Python, Rust, Go, JavaScript, Swift…: `def name(`, `fn name(`, `func name(`, `function name(`.
  /\b(?:def|fn|func|function)[ \t]+([A-Za-z_]\w*)[^\n]*/g,
  // JavaScript: `const name = (…) =>` or `const name = function`.
  /\b(?:const|let|var)[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function\b|\([^()]*\)[ \t]*=>)/g,
  // C family: `Type name(params) qualifiers {`, the name possibly `Class::name`, the return type or
  // params possibly on lines of their own.
  /^[ \t]*(?:[\w:<>,*&]+(?:[ \t]+|[ \t]*\n[ \t]*))+[*&]*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)[ \t]*\((?:[^()]|\([^()]*\))*\)[^{};\n]*\n?[ \t]*\{/gm,
];

/** Names of the functions a piece of code declares or defines (last `::` part). */
export function declaredNames(code: string): string[] {
  const out = new Set<string>();
  for (const re of DECLARED) {
    for (const m of code.matchAll(re)) {
      const name = m[1]!.split('::').at(-1)!;
      if (!NOT_A_NAME.has(name)) out.add(name);
    }
  }
  return [...out];
}

/**
 * The open tasks of a lesson and the names each asks for. A stub belongs to the open tasks of
 * its section; a task is open until the learner marks it done.
 */
export function openTaskShapes(lesson: Lesson, progress: Readonly<Record<string, unknown>>): TaskShape[] {
  const shapes: TaskShape[] = [];
  for (const section of lesson.sections) {
    const stubs = section.blocks.flatMap((b) => (b.type === 'code' && b.kind === 'stub' ? declaredNames(b.source) : []));
    for (const b of section.blocks) {
      if (b.type !== 'task') continue;
      const done = progress[taskKey(b.id)];
      if (done !== undefined && done !== null) continue;
      const titleName = /^[A-Za-z_][\w:]*$/.test(b.title.trim()) ? [b.title.trim().split('::').at(-1)!] : [];
      const names = [...new Set([...stubs, ...titleName])].filter((n) => !NOT_A_NAME.has(n));
      if (names.length > 0) shapes.push({ taskId: b.id, title: b.title, names });
    }
  }
  return shapes;
}

/** Lines that hold no logic: blank, comments, lone braces, placeholders. */
const TRIVIAL = [/^$/, /^(\/\/|#|--|;|\/?\*)/, /TODO|FIXME|your code/i, /^pass$/, /^\.\.\.$/, /^[{}()[\];,]+$/, /^(throw|raise)\b/, /^return\s*;?$/];

/** Lines of logic in code, once comments and function headers are taken out. */
export function implementationLines(code: string): number {
  let body = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const re of DECLARED) body = body.replace(re, '');
  return body.split('\n').filter((l) => !TRIVIAL.some((t) => t.test(l.trim()))).length;
}

/** Lines of logic that make code an implementation rather than a stub or a signature. */
const IMPLEMENTATION_LINES = 2;

/**
 * The open task this code would give away: it defines a function the task asks for, and has
 * real statements in it. Undefined when the code looks safe to show.
 */
export function solutionFor(code: string, shapes: readonly TaskShape[]): TaskShape | undefined {
  if (shapes.length === 0) return undefined;
  const defined = new Set(declaredNames(code));
  const hit = shapes.find((s) => s.names.some((n) => defined.has(n)));
  if (!hit) return undefined;
  return implementationLines(code) >= IMPLEMENTATION_LINES ? hit : undefined;
}
