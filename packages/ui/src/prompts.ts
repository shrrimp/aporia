import type { AskShown } from '@app/server/protocol';

/**
 * A message the app writes for the learner. The tutor gets the whole prompt; the learner sees a
 * card with their own words (`shown`), not the instructions the app wrapped around them.
 */
export interface Prompt {
  readonly question: string;
  readonly shown: AskShown;
}

export const INTERVIEW: Prompt = {
  question: 'Interview me briefly to find out what I already know for this project, then draft the first lesson.',
  shown: { kind: 'interview' },
};

/** For a project with work already done: start from it, and verify before believing it (P4). */
export const EXISTING_WORK: Prompt = {
  question:
    'I already have work for this project: my workspace and the files I added. Start from it. Explore it and read the files, ' +
    'then tell me which skills they suggest I have, and record them as claims in my skill map. A claim is not proof: check each one ' +
    'with short probes (questions about my own code are best) before anything counts. Then propose a roadmap for the rest of the ' +
    'project, and the first lesson from where I really am.',
  shown: { kind: 'existing-work' },
};

export const PLAN_NEXT: Prompt = {
  question: 'Based on my progress so far, what should I learn next? Propose the next lesson and draft it.',
  shown: { kind: 'plan' },
};

export const PLAN_MORE: Prompt = {
  question: 'Everything planned is done. Based on my progress, propose what to learn next, update the plan, and draft the next lesson.',
  shown: { kind: 'plan' },
};

/** Sent by "Continue" after a turn was cut off; the core tells the tutor what it had done. */
export const CONTINUE: Prompt = { question: 'Please continue where you left off.', shown: { kind: 'continue' } };

export function draftLesson(title: string, planId: string): Prompt {
  return {
    question: `Draft the next lesson of the plan: "${title}" (plan item ${planId}). Set its lessonId on the plan once it is drafted.`,
    shown: { kind: 'draft-lesson', about: title },
  };
}

/** "I'm stuck" on a task: the lowest hint that helps, with what the learner tried, if anything. */
export function hintRequest(task: string, tried: string): Prompt {
  const said = tried ? ` What I tried: ${tried}${/[.!?]$/.test(tried) ? '' : '.'}` : '';
  return {
    question: `I'm stuck on task "${task}".${said} Give me the lowest hint level that helps.`,
    shown: { kind: 'hint', about: task, ...(tried ? { text: tried } : {}) },
  };
}

/** A short answer to a drill item, for the tutor to judge against the reference. */
export function checkAnswer(item: { id: string; kcs: readonly string[]; prompt: string; answer: string; difficulty: number }, text: string): Prompt {
  return {
    question:
      `Judge my answer to drill item "${item.id}" (KCs ${item.kcs.join(', ')}). Question: ${item.prompt}\nMy answer: ${text}\n` +
      `Reference: ${item.answer}\nScore it 0–5 against the reference twice independently, record the evidence (production, difficulty ${item.difficulty}), ` +
      'give me feedback without lecturing, then send me back to the lesson.',
    shown: { kind: 'check-answer', about: item.prompt, text },
  };
}

/** An explain-back, for the tutor to score against the rubric. */
export function explainBack(doc: { kcs: readonly string[]; prompt: string; rubric: readonly string[] }, text: string): Prompt {
  return {
    question:
      `Explain-back on ${doc.kcs.join(', ')}. Prompt: ${doc.prompt}\nMy explanation: ${text}\nRubric: ${doc.rubric.join('; ')}\n` +
      'Score it 0–5 twice independently against the rubric, record the evidence (explain-back, with agreement), then tell me what I got right and the one thing to fix, ' +
      'and send me back to the lesson.',
    shown: { kind: 'explain-back', about: doc.prompt, text },
  };
}

/** The note `withFiles` adds to a message, and the file names in it. */
const FILES_NOTE = /(?:^|\n\n)I added (?:a file|\d+ files) to the project: ((?:"[^"]*" \([^)]*\)(?:, )?)+)\.(?: Have a look\.)?$/;

const EXACT = new Map([INTERVIEW, EXISTING_WORK, PLAN_NEXT, PLAN_MORE, CONTINUE].map((p) => [p.question, p.shown]));
const PATTERNS: readonly [RegExp, (m: RegExpExecArray) => AskShown][] = [
  [
    /^I'm stuck on task "([\s\S]*)"\.(?: What I tried: ([\s\S]*?))? Give me the lowest hint level that helps\.$/,
    (m) => ({ kind: 'hint', about: m[1]!, ...(m[2] ? { text: m[2] } : {}) }),
  ],
  [/^Judge my answer to drill item "[^"]*" \(KCs [^)]*\)\. Question: ([\s\S]*?)\nMy answer: ([\s\S]*?)\nReference: /, (m) => ({ kind: 'check-answer', about: m[1]!, text: m[2]! })],
  [/^Explain-back on [\s\S]*?\. Prompt: ([\s\S]*?)\nMy explanation: ([\s\S]*?)\nRubric: /, (m) => ({ kind: 'explain-back', about: m[1]!, text: m[2]! })],
  [/^Draft the next lesson of the plan: "([\s\S]*)" \(plan item [^)]*\)\./, (m) => ({ kind: 'draft-lesson', about: m[1]! })],
];

/**
 * The card for a message saved before cards were (its prompt is all there is): recognised from
 * the prompts above, or undefined for the learner's own words.
 */
export function shownFor(question: string): AskShown | undefined {
  const exact = EXACT.get(question);
  if (exact) return exact;
  for (const [re, shown] of PATTERNS) {
    const m = re.exec(question);
    if (m) return shown(m);
  }
  const files = FILES_NOTE.exec(question);
  if (files) {
    const text = question.slice(0, files.index).trim();
    return { kind: 'message', ...(text ? { text } : {}), files: [...files[1]!.matchAll(/"([^"]*)" \(/g)].map((f) => f[1]!) };
  }
  return undefined;
}
