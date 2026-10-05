/**
 * What the tutor is doing, in words. Agents report raw tool names
 * ("mcp__aporia__record_evidence", "Read /home/…/Joint.cpp"); the learner sees a short label
 * and the detail that matters.
 */
export type ActivityKind = 'context' | 'note' | 'lesson' | 'code' | 'other';

export interface Activity {
  readonly label: string;
  readonly kind: ActivityKind;
  readonly detail?: string;
}

const TEACHING: Readonly<Record<string, Activity>> = {
  get_teaching_context: { label: 'Reading your learner profile', kind: 'context' },
  get_component_catalog: { label: 'Checking the lesson toolkit', kind: 'context' },
  record_evidence: { label: 'Noting what you showed', kind: 'note' },
  record_instruction: { label: 'Marking what was taught', kind: 'note' },
  record_insight: { label: 'Noting how you learn', kind: 'note' },
  draft_lesson: { label: 'Writing a lesson', kind: 'lesson' },
  revise_lesson: { label: 'Revising the lesson', kind: 'lesson' },
  get_lesson: { label: 'Rereading the lesson', kind: 'lesson' },
  list_lessons: { label: 'Looking over your lessons', kind: 'lesson' },
};

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

export function describeTool(title: string | undefined): Activity {
  const t = (title ?? '').trim();
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__([a-z_]+)/.exec(t);
  if (mcp) return TEACHING[mcp[2]!] ?? { label: 'Using an app tool', kind: 'other', detail: mcp[2]!.replaceAll('_', ' ') };
  if (TEACHING[t]) return TEACHING[t]!;
  const [verb, ...rest] = t.split(' ');
  const arg = rest.join(' ').replaceAll('`', '');
  switch (verb) {
    case 'Read':
      return { label: 'Reading your code', kind: 'code', ...(arg ? { detail: base(arg) } : {}) };
    case 'Grep':
    case 'grep':
      return { label: 'Searching your code', kind: 'code', ...(arg ? { detail: arg } : {}) };
    case 'Glob':
    case 'Find':
    case 'List':
      return { label: 'Looking through your files', kind: 'code', ...(arg ? { detail: arg } : {}) };
    default:
      return { label: t === '' ? 'Working' : 'Working', kind: 'other', ...(t ? { detail: t } : {}) };
  }
}
