/**
 * Heuristic, language-agnostic check that a `stub` code block contains no implementation
 * (P1). Declarations, comments, braces and placeholders are allowed; any other statement is
 * reported. Deliberately strict: a false alarm costs the agent one rewrite, a miss shows the
 * learner an answer.
 */
const PLACEHOLDER = [
  /^(\/\/|#|--|;)/, // comment lines
  /^\/?\*/, // block comment lines
  /TODO|FIXME|your code/i,
  /^pass$/,
  /^\.\.\.$/,
  /^(throw|raise)\b/,
  /^(unimplemented|todo)!\s*\(.*\)\s*;?$/,
  /^return(\s+(0|0\.0|false|nullptr|null|None|nil|\{\}|\[\]|\{\s*\}|[A-Za-z_:<>]*\{\}|undefined))?\s*;?$/,
  /^[{}()[\];,]+$/,
];

/** Lines that only declare something: function/struct/class headers, fields, includes. */
const DECLARATION = [
  /^(#include|#pragma|import|from\s+\S+\s+import|using|package|module|export\s*\{)/,
  /^(template\s*<.*>)$/,
  /^(pub\s+)?(struct|class|enum|interface|trait|type|union|impl|namespace|mod)\b/,
  // a signature: name(...) followed by optional qualifiers and `{`, `:`, `;` or `->` …
  /^[\w:<>,*&\s[\]~]*\b\w+\s*\([^;{}]*\)\s*(const|noexcept|override|final|->\s*[\w:<>,*&\s[\]]+|:\s*[\w.[\]|]+)*\s*(\{|:|;|=\s*0\s*;|=\s*delete\s*;|=\s*default\s*;)?\s*\}?\s*$/,
  /^(def|fn|func|function|pub fn|async fn|async def)\s+\w+/,
  // field declarations: `Type name;`, `name: Type`, `int x = 0;` is NOT allowed (it's logic) unless in a struct
  /^(?!(return|throw|delete|goto|break|continue|co_return|yield|await)\b)[\w:<>,*&\s[\]]+\s+\w+\s*;$/,
  /^\w+\s*:\s*[\w.[\]|<>]+\s*;?$/,
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export interface StubFinding {
  readonly line: number;
  readonly text: string;
}

/** Join lines whose parentheses are still open, so multi-line signatures read as one line. */
function joinContinuations(lines: string[]): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buf = '';
  let start = 0;
  let depth = 0;
  lines.forEach((raw, i) => {
    if (buf === '') start = i + 1;
    buf = buf === '' ? raw.trim() : `${buf} ${raw.trim()}`;
    for (const ch of raw) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth <= 0) {
      out.push({ text: buf, line: start });
      buf = '';
      depth = 0;
    }
  });
  if (buf !== '') out.push({ text: buf, line: start });
  return out;
}

/** `sig(...) { a; b; }` on one line → the signature plus each inner statement. */
function splitInlineBody(text: string): string[] {
  const m = /^(.*\)[^{}]*)\{(.*)\}\s*;?$/.exec(text);
  if (!m) return [text];
  const inner = m[2]!.split(';').map((x) => x.trim()).filter(Boolean).map((x) => `${x};`);
  return [`${m[1]!.trim()} {`, ...inner];
}

function isAllowed(text: string): boolean {
  return PLACEHOLDER.some((r) => r.test(text)) || DECLARATION.some((r) => r.test(text));
}

export function stubFindings(source: string): StubFinding[] {
  const out: StubFinding[] = [];
  for (const { text, line } of joinContinuations(stripComments(source).split('\n'))) {
    if (text === '') continue;
    for (const part of splitInlineBody(text)) {
      if (!isAllowed(part)) out.push({ line, text: part });
    }
  }
  return out;
}
