import {
  EMPTY_BANK,
  instantiate,
  instantiateContext,
  isTemplate,
  reviewBank,
  type DrillItem,
  type Lesson,
  type ReviewBank,
  type ReviewQuestion,
} from '@app/catalog';
import { answeredItems, reviewQueue, skillMemories, REVIEW_CAP, type Answered, type ChangeService, type OpenProfile, type SkillMemory } from '@app/core';
import { projectLessons, reviewableItems } from './lessons.ts';
import { reviewsTarget } from './paths.ts';
import { readSkillMap } from './skills.ts';

/**
 * Where new review questions come from (the learner's setting, roadmap 1.10): a pool the tutor
 * keeps topped up in the background, questions written when skills come due, or each skill's
 * questions written once, with the app giving number templates new numbers.
 */
export type ReviewMode = 'pool' | 'when-due' | 'numbers';

/** How a bank question's answers are recorded: `~reviews/<id>`, apart from lesson items (`lesson/item`). */
export const BANK_PREFIX = '~reviews/';
/** In pool mode, the unseen questions each skill keeps ready, from its first answer on. */
export const POOL_LOW = 2;

export async function readBank(changes: ChangeService, projectId: string): Promise<ReviewBank> {
  const parsed = reviewBank.safeParse(await changes.read(reviewsTarget(projectId)));
  return parsed.success ? parsed.data : EMPTY_BANK;
}

/** Something that can be asked in a review: a bank question, or (until the bank has some) a lesson's own item. */
export type Candidate =
  | { readonly source: 'bank'; readonly id: string; readonly qid: string; readonly kcs: readonly string[]; readonly question: ReviewQuestion; readonly at: string }
  | { readonly source: 'lesson'; readonly id: string; readonly kcs: readonly string[]; readonly item: DrillItem; readonly lessonTitle: string; readonly at: string };

/** Everything that can be asked: the bank's questions that are not retired, then the lessons' items the learner did not retire. */
export function candidates(bank: ReviewBank, lessons: readonly Lesson[]): Candidate[] {
  const out: Candidate[] = [];
  for (const [qid, e] of Object.entries(bank.questions)) {
    if (!e.retired) out.push({ source: 'bank', id: `${BANK_PREFIX}${qid}`, qid, kcs: e.question.kcs, question: e.question, at: e.at });
  }
  const retired = new Set(bank.retiredItems);
  for (const [id, r] of reviewableItems(lessons)) {
    if (!retired.has(id)) out.push({ source: 'lesson', id, kcs: r.item.kcs, item: r.item, lessonTitle: r.lessonTitle, at: '' });
  }
  return out;
}

/** Whether the learner meets the question for the first time, the same template with new numbers, or a question they answered before. */
export type Seen = 'new' | 'new-numbers' | 'again';

const lastAt = (answered: ReadonlyMap<string, Answered>, c: Candidate) => answered.get(c.id)?.lastAt ?? '';
const byOldest = (answered: ReadonlyMap<string, Answered>) => (a: Candidate, b: Candidate) => lastAt(answered, a).localeCompare(lastAt(answered, b)) || a.id.localeCompare(b.id);

/**
 * The question to ask for one due skill. First one the learner has never answered: a bank
 * question before a lesson's item, from a different angle than the last one on this skill,
 * oldest first. Then a template, with new numbers. Then the question answered longest ago, and
 * never the last one when there is another. `used`: already on the page.
 */
export function chooseQuestion(kc: string, pool: readonly Candidate[], answered: ReadonlyMap<string, Answered>, used: ReadonlySet<string>): { candidate: Candidate; seen: Seen } | undefined {
  const onSkill = pool.filter((c) => c.kcs.includes(kc) && !used.has(c.id));
  if (onSkill.length === 0) return undefined;
  const last = onSkill.filter((c) => answered.has(c.id)).sort(byOldest(answered)).at(-1);
  const lastAngle = last?.source === 'bank' ? last.question.angle : undefined;
  const fresh = onSkill.filter((c) => !answered.has(c.id));
  if (fresh.length > 0) {
    const rank = (c: Candidate) => [c.source === 'bank' ? 0 : 1, c.source === 'bank' && c.question.angle === lastAngle ? 1 : 0] as const;
    const best = [...fresh].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))[0]!;
    return { candidate: best, seen: 'new' };
  }
  const templates = onSkill.filter((c) => c.source === 'bank' && isTemplate(c.question)).sort(byOldest(answered));
  if (templates.length > 0) return { candidate: templates[0]!, seen: 'new-numbers' };
  const others = onSkill.length > 1 ? onSkill.filter((c) => c.id !== last!.id) : onSkill;
  return { candidate: others.sort(byOldest(answered))[0]!, seen: 'again' };
}

export interface ReviewSlot {
  readonly kc: string;
  /** The skill's name, from the skill map. */
  readonly title: string;
  readonly retrievability: number;
  readonly reviews: number;
  /** Absent when there is nothing to ask on this skill yet. */
  readonly question?: {
    /** As its answer is recorded: `~reviews/<id>` or `lesson/item`. */
    readonly id: string;
    readonly kcs: readonly string[];
    readonly item: DrillItem;
    readonly context?: string;
    readonly seen: Seen;
    /** For a lesson's own item: the lesson's title. */
    readonly from?: string;
  };
}

export interface ProjectReviews {
  /** One slot per due skill, most at risk first; a skill already covered by another slot's question is left out. */
  readonly due: readonly ReviewSlot[];
  readonly dueCount: number;
  readonly nextDue?: string;
  /** Skills that need new questions written, most urgent first (what depends on the mode). */
  readonly needs: readonly string[];
}

/** The drill item for one showing of a candidate; undefined for a template that does not work out with these numbers. */
function present(c: Candidate, answered: ReadonlyMap<string, Answered>): { item: DrillItem; context?: string; from?: string } | undefined {
  if (c.source === 'lesson') return { item: c.item, from: c.lessonTitle };
  // Each showing of a template gets its own numbers, and the same ones until it is answered.
  const seed = String(answered.get(c.id)?.count ?? 0);
  try {
    const context = instantiateContext(c.qid, c.question, seed);
    return { item: instantiate(c.qid, c.question, seed), ...(context ? { context } : {}) };
  } catch {
    return undefined;
  }
}

/** Which skills need new questions written, by the learner's setting. */
export function questionsNeeded(
  mode: ReviewMode,
  memories: ReadonlyMap<string, SkillMemory>,
  slots: readonly ReviewSlot[],
  pool: readonly Candidate[],
  answered: ReadonlyMap<string, Answered>,
): string[] {
  const bankOn = (kc: string) => pool.filter((c) => c.source === 'bank' && c.kcs.includes(kc));
  if (mode === 'when-due') return slots.filter((s) => s.question?.seen !== 'new').map((s) => s.kc);
  const skills = [...memories.values()].sort((a, b) => a.card.due.getTime() - b.card.due.getTime() || a.kc.localeCompare(b.kc));
  if (mode === 'numbers') return skills.filter((m) => bankOn(m.kc).length === 0).map((m) => m.kc);
  return skills.filter((m) => bankOn(m.kc).filter((c) => !answered.has(c.id)).length < POOL_LOW).map((m) => m.kc);
}

/** What is due for review in a project now (pedagogy-model §7, roadmap 1.10): a question for each due skill. */
export async function projectReviews(
  profile: Pick<OpenProfile, 'changes' | 'journal'>,
  projectId: string,
  now: Date,
  cap = REVIEW_CAP,
  mode: ReviewMode = 'pool',
): Promise<ProjectReviews> {
  const events = profile.journal.events;
  const memories = skillMemories(events, projectId);
  const queue = reviewQueue(memories, now, cap);
  const answered = answeredItems(events, projectId);
  const pool = candidates(await readBank(profile.changes, projectId), await projectLessons(profile, projectId));
  const map = await readSkillMap(profile.changes);
  const used = new Set<string>();
  const covered = new Set<string>();
  const due: ReviewSlot[] = [];
  for (const d of queue.due) {
    if (covered.has(d.kc)) continue;
    const slot = { kc: d.kc, title: map.skills[d.kc]?.title ?? d.kc, retrievability: d.retrievability, reviews: d.reviews };
    let question: ReviewSlot['question'];
    for (let choice = chooseQuestion(d.kc, pool, answered, used); choice && !question; choice = chooseQuestion(d.kc, pool, answered, used)) {
      used.add(choice.candidate.id);
      const shown = present(choice.candidate, answered);
      if (!shown) continue;
      question = { id: choice.candidate.id, kcs: choice.candidate.kcs, seen: choice.seen, ...shown };
      for (const kc of choice.candidate.kcs) covered.add(kc);
    }
    due.push({ ...slot, ...(question ? { question } : {}) });
  }
  return {
    due,
    dueCount: queue.dueCount,
    ...(queue.nextDue ? { nextDue: queue.nextDue } : {}),
    needs: questionsNeeded(mode, memories, due, pool, answered),
  };
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/**
 * The tutor's brief for writing review questions on `kcs`: what each skill is, how it was
 * taught, what was already asked (never to be repeated), and the rules a review question
 * follows. The app runs it in the background, in its own session.
 */
export async function reviewQuestionsBrief(profile: Pick<OpenProfile, 'changes' | 'journal'>, projectId: string, kcs: readonly string[], mode: ReviewMode, perSkill = 3): Promise<string> {
  const map = await readSkillMap(profile.changes);
  const bank = await readBank(profile.changes, projectId);
  const pool = candidates(bank, await projectLessons(profile, projectId));
  const memories = skillMemories(profile.journal.events, projectId);
  const skills = kcs.map((kc) => {
    const s = map.skills[kc];
    const on = pool.filter((c) => c.kcs.includes(kc));
    const taught = on.flatMap((c) => (c.source === 'lesson' ? [`- ${oneLine(c.item.prompt, 200)}`] : []));
    const asked = on.flatMap((c) => (c.source === 'bank' ? [`- (${c.question.angle}) ${oneLine(c.question.prompt, 200)}`] : []));
    const flagged = Object.values(bank.questions).flatMap((e) => (e.retired && e.question.kcs.includes(kc) ? [`- ${oneLine(e.question.prompt, 200)}`] : []));
    const m = memories.get(kc);
    return [
      `## ${kc}: ${s?.title ?? kc}`,
      s?.summary ? `What it is: ${oneLine(s.summary, 400)}` : '',
      m ? `Answered ${m.reviews} time(s) so far.` : '',
      taught.length ? `How the lesson tested it:\n${taught.slice(0, 6).join('\n')}` : '',
      asked.length ? `Review questions already written (never repeat or reword these):\n${asked.slice(-12).join('\n')}` : '',
      flagged.length ? `The learner said these made no sense without the lesson (ask the idea again, with the context it needs):\n${flagged.slice(-6).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    '<review-questions>',
    `Write ${perSkill} new review questions for each skill below, with write_review_questions. Nothing else: do not talk to the learner, do not change lessons.`,
    'They are asked on the Review page, days after the lesson, with the lesson closed. So:',
    '- Each question stands on its own. Put the definitions, code or numbers it needs in `context`. Never point back at a lesson, a section, a figure, or "as we saw".',
    '- Test the skill, not the memory of a question. Vary the angle (apply, explain, predict, spot-the-error, compare, recall; prefer apply and predict), the situation and the numbers. Never reword a question listed below.',
    '- Use kinds the app scores itself: mcq (with a `reason` tier when a misconception is likely), numeric, order.',
    mode === 'numbers'
      ? '- These questions are written once and come back for as long as the skill is reviewed: where the skill involves numbers, make each a template, with `vars` ranges, {{ expressions }} in the text, the answer as an {{ expression }}, and a tolerance that fits.'
      : '- Where the skill involves numbers, a template (`vars` ranges, {{ expressions }} in the text and the answer) comes back with new numbers each time.',
    '',
    ...skills.flatMap((s) => [s, '']),
    '</review-questions>',
  ].join('\n');
}
