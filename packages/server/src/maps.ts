import {
  assessmentDoc,
  assessmentTarget,
  band,
  curriculumDoc,
  curriculumTarget,
  deriveLearnerState,
  itemMemories,
  orderedMilestones,
  layers,
  MemoryModel,
  pathState,
  prerequisites,
  projectProgress,
  ratingConfidence,
  struggleReasons,
  withPrerequisites,
  type LearnerState,
  type OpenProfile,
  type SkillMap,
} from '@app/core';
import { lessonCompletion, type Lesson } from '@app/catalog';
import { projectLessons, projectReviews, readRoadmap, readSkillMap, readSources, reviewableItems } from '@app/teacher-mcp';
import type { BrainDTO, CurriculumDTO, NextStepDTO, ProjectDTO } from './protocol.ts';

/** Due items below this recall make their skills show as fading. */
const FADING = 0.7;
/** Enough due items that reviewing comes before anything new. */
const REVIEW_FIRST = 3;

const titleOf = (map: SkillMap, kc: string) => map.skills[kc]?.title ?? kc;

function levelOf(state: LearnerState, kc: string) {
  const k = state.kcs.get(kc);
  return k
    ? { mastery: k.mastery, band: band(k.rating.theta), confidence: ratingConfidence(k.rating), evidence: k.history.evidence.length }
    : { mastery: 'unseen' as const, confidence: 0, evidence: 0 };
}

/**
 * The project's path (ux §1.4): its goal skills and everything they build on, layered from
 * foundations to goals, each placed by evidence; the rolling plan; and one next step, chosen by
 * code from the plan, the lessons, and what is due.
 */
export async function projectCurriculum(profile: OpenProfile, project: ProjectDTO): Promise<CurriculumDTO> {
  const now = profile.journal.now();
  const state = deriveLearnerState(profile.journal.events, now);
  const map = await readSkillMap(profile.changes);
  const curriculum = curriculumDoc.safeParse(await profile.changes.read(curriculumTarget(project.id)));
  const assessment = assessmentDoc.safeParse(await profile.changes.read(assessmentTarget(project.id)));
  const lessons = await projectLessons(profile, project.id);
  const progress = projectProgress(profile.journal.events, project.id);
  const reviews = await projectReviews(profile, project.id, now, 0);
  const roadmap = await readRoadmap(profile.changes, project.id);
  // Work already exists: a workspace, or files the learner imported. Then the interview starts from it.
  const existing = project.workspace !== undefined || Object.keys(await readSources(profile, project.id)).length > 0;

  const goals = curriculum.success ? curriculum.data.goals : [];
  const plan = curriculum.success ? curriculum.data.plan : [];
  const lessonKcs = lessons.flatMap((l) => l.kcs);
  const nodes = [...withPrerequisites(map, [...goals, ...plan.flatMap((p) => p.kcs), ...lessonKcs])];
  const pre = prerequisites(map);
  const inPath = new Set(nodes);
  const edges = Object.values(map.edges)
    .filter((e) => e.kind === 'prereq' && inPath.has(e.from) && inPath.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
  const layer = layers(nodes, edges.map((e) => [e.from, e.to] as const));
  const masteryOf = (kc: string) => state.kcs.get(kc)?.mastery;
  const goalSet = new Set(goals);

  const completion = (l: Lesson) => lessonCompletion(l, progress[l.id] ?? {});
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const planDTO = plan.map((p) => {
    const lesson = p.lessonId === undefined ? undefined : byId.get(p.lessonId);
    const c = lesson ? completion(lesson) : undefined;
    const status = !c ? 'planned' : c.total > 0 && c.done === c.total ? 'done' : c.done > 0 ? 'in-progress' : 'written';
    return { ...p, kcs: [...p.kcs], status, ...(c ? { progress: c } : {}) } as CurriculumDTO['plan'][number];
  });

  return {
    goals: [...goals],
    nodes: nodes
      .map((kc) => {
        const placed = pathState(masteryOf(kc), pre.get(kc) ?? [], masteryOf);
        const s = map.skills[kc];
        return {
          id: kc,
          title: titleOf(map, kc),
          ...(s?.group ? { group: s.group } : {}),
          ...(s?.summary ? { summary: s.summary } : {}),
          layer: layer.get(kc)!,
          state: placed.state,
          needs: placed.needs.map((n) => titleOf(map, n)),
          goal: goalSet.has(kc),
          ...(s?.claim ? { claim: s.claim } : {}),
          ...levelOf(state, kc),
        };
      })
      .sort((a, b) => a.layer - b.layer || a.title.localeCompare(b.title)),
    edges,
    plan: planDTO,
    next: nextStep(planDTO, lessons, completion, reviews.dueCount, assessment.success, curriculum.success, existing),
    roadmap: orderedMilestones(roadmap).map(({ capability, ...m }) => ({ ...m, kcs: [...m.kcs], ...(capability ? { capability } : {}) })),
    ...(assessment.success ? { assessment: assessment.data } : {}),
  };
}

export function nextStep(
  plan: CurriculumDTO['plan'],
  lessons: readonly Lesson[],
  completion: (l: Lesson) => { done: number; total: number },
  due: number,
  interviewed: boolean,
  planned: boolean,
  existing = false,
): NextStepDTO {
  if (lessons.length === 0 && !interviewed && !planned) {
    return existing
      ? { kind: 'interview', existing: true, text: 'Start from what you already did: your tutor looks at your work and your files, then checks with you what you really master.' }
      : { kind: 'interview', existing: false, text: 'Start with a short interview, so the first lesson begins at the right level.' };
  }
  if (due >= REVIEW_FIRST) return { kind: 'review', due, text: `Review ${due} items first: they are about to slip.` };
  const unfinished = [...plan.filter((p) => p.lessonId).map((p) => lessons.find((l) => l.id === p.lessonId)), ...lessons].find(
    (l) => l !== undefined && completion(l).done < completion(l).total,
  );
  if (unfinished) return { kind: 'lesson', lessonId: unfinished.id, title: unfinished.title, text: `Continue "${unfinished.title}".` };
  const draft = plan.find((p) => p.status === 'planned');
  if (draft) return { kind: 'draft', planId: draft.id, title: draft.title, text: `Next on the plan: "${draft.title}". Your tutor can write it now.` };
  return { kind: 'plan', text: due > 0 ? `Everything planned is done. Review ${due} item(s), or plan what comes next.` : 'Everything planned is done. Plan what comes next with your tutor.' };
}

/**
 * The brain view (roadmap 2.8): every skill of the profile, its group and links, where the
 * learner stands (from evidence), what is slipping, and the tutor's suggestions not yet met.
 */
export async function brain(profile: OpenProfile, projects: readonly ProjectDTO[]): Promise<BrainDTO> {
  const now = profile.journal.now();
  const state = deriveLearnerState(profile.journal.events, now);
  const map = await readSkillMap(profile.changes);
  const memory = new MemoryModel();

  const usedBy = new Map<string, Set<string>>();
  const fading = new Map<string, number>();
  for (const p of projects) {
    const lessons = await projectLessons(profile, p.id);
    const curriculum = curriculumDoc.safeParse(await profile.changes.read(curriculumTarget(p.id)));
    const kcs = [...lessons.flatMap((l) => l.kcs), ...(curriculum.success ? [...curriculum.data.goals, ...curriculum.data.plan.flatMap((x) => x.kcs)] : [])];
    for (const kc of kcs) usedBy.set(kc, (usedBy.get(kc) ?? new Set()).add(p.id));
    const items = reviewableItems(lessons);
    for (const [itemId, m] of itemMemories(profile.journal.events, p.id)) {
      const item = items.get(itemId);
      if (!item || m.card.due.getTime() > now.getTime() || memory.retrievability(m.card, now) >= FADING) continue;
      for (const kc of item.item.kcs) fading.set(kc, (fading.get(kc) ?? 0) + 1);
    }
  }

  // Every skill the app knows of: described in the map, met in evidence, or used by a lesson or plan.
  const ids = new Set([...Object.keys(map.skills), ...state.kcs.keys(), ...usedBy.keys()]);
  const nodes = [...ids].sort().map((kc) => {
    const s = map.skills[kc];
    const k = state.kcs.get(kc);
    const struggling = struggleReasons(k);
    const fadingItems = fading.get(kc) ?? 0;
    if (fadingItems > 0) struggling.push(`${fadingItems} review item${fadingItems === 1 ? '' : 's'} fading`);
    return {
      id: kc,
      title: s?.title ?? kc,
      ...(s?.group ? { group: s.group } : {}),
      ...(s?.summary ? { summary: s.summary } : {}),
      suggested: s?.suggested === true,
      ...(s?.claim ? { claim: s.claim } : {}),
      ...(s?.why ? { why: s.why } : {}),
      discovered: k !== undefined,
      ...levelOf(state, kc),
      struggling,
      projects: [...(usedBy.get(kc) ?? [])].sort(),
    };
  });
  return {
    groups: Object.entries(map.groups).map(([id, g]) => ({ id, title: g.title, ...(g.summary ? { summary: g.summary } : {}), ...(g.parent ? { parent: g.parent } : {}) })),
    nodes,
    edges: Object.values(map.edges).map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
  };
}
