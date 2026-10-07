import { createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { brand } from '@app/brand';
import { catalogGuide, classifyWrite, formProblems, learnerForm, normalizeLesson, openTaskShapes, solutionFor, validateLesson, workspaceRelative, type Problem } from '@app/catalog';
import {
  HINT_LEVELS,
  checkHint,
  hintStates,
  SKILL_MAP_TARGET,
  SUITE_PLACEHOLDER,
  checkpointArgv,
  parseTestOutput,
  projectProgress,
  runCommand,
  splitCommand,
  applyPatch,
  assessmentDoc,
  assessmentTarget,
  curriculumDoc,
  curriculumTarget,
  deriveLearnerState,
  roadmapTarget,
  validateRoadmap,
  validateAssessment,
  validateCurriculum,
  validateSkillMap,
  ChangeError,
  ChangeValidationError,
  difficultyFromLevel,
  newId,
  evidenceType,
  kcId,
  patchOp,
  type ChangeService,
  type ChangeState,
  type JsonValue,
  type PatchOp,
} from '@app/core';
import { RULES, lessonTarget, teachingContext, type TeacherContext } from './context.ts';
import { lessonIds, projectLessons } from './lessons.ts';
import { MAX_AGENT_FILE_CHARS, agentFileTarget, agentFilesEffect, isAgentFileTarget, projectAccess, readDisk, validateAgentFile, workspaceFile, type AgentFileDoc } from './files.ts';
import { projectTarget } from './paths.ts';
import { readSources, sourceText, validateSources } from './sources.ts';
import { ensureRoadmap, roadmapPatches, roadmapUpdate } from './roadmap.ts';
import { describeSkillMap, ensureSkillMap, knownSkills, readSkillMap, skillMapPatch, skillMapUpdate, withPendingReferences } from './skills.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const formatProblems = (ps: readonly Problem[]) => ps.map((p) => `- ${p.path}: ${p.message}`).join('\n');

const LESSON_TARGET = /^projects\/[^/]+\/lessons\/[^/]+\.json$/;

/** Lesson documents are validated on every change, whoever makes it. */
export function registerLessonValidator(changes: ChangeService): void {
  changes.addValidator((target, doc) => {
    if (!LESSON_TARGET.test(target)) return [];
    return validateLesson(doc).errors.map((p) => `${p.path}: ${p.message}`);
  });
}

const CURRICULUM_TARGET = /^projects\/[^/]+\/curriculum\.json$/;
const ASSESSMENT_TARGET = /^projects\/[^/]+\/assessment\.json$/;
const SOURCES_TARGET = /^projects\/[^/]+\/sources\.json$/;
const ROADMAP_TARGET = /^projects\/[^/]+\/roadmap\.json$/;

/**
 * Every document the app knows is validated on every change, whoever makes it: lessons, the
 * skill map, curricula, assessments, sources, the tutor's files (which also follow into the
 * workspace).
 */
export function registerValidators(changes: ChangeService): void {
  registerLessonValidator(changes);
  changes.addValidator((target, doc) => (isAgentFileTarget(target) ? validateAgentFile(target, doc) : []));
  changes.addEffect(agentFilesEffect(changes));
  changes.addValidator((target, doc) => {
    if (target === SKILL_MAP_TARGET) return validateSkillMap(doc);
    if (CURRICULUM_TARGET.test(target)) return validateCurriculum(doc);
    if (ASSESSMENT_TARGET.test(target)) return validateAssessment(doc);
    if (SOURCES_TARGET.test(target)) return validateSources(doc);
    if (ROADMAP_TARGET.test(target)) return validateRoadmap(doc);
    return [];
  });
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ChangeValidationError) return fail(`Rejected; fix these and try again:\n${err.problems.map((p) => `- ${p}`).join('\n')}`);
    if (err instanceof ChangeError) return fail(err.message);
    if (err instanceof z.ZodError) return fail(`Invalid input: ${err.message}`);
    throw err;
  }
}

/** One MCP server instance bound to one agent session's context. */
export function buildTeacherServer(ctx: TeacherContext): McpServer {
  const server = new McpServer({ name: brand.id, version: '0.1.0' });
  const { observations, changes } = ctx.profile;

  server.registerTool(
    'get_teaching_context',
    {
      description: 'Read this first. The teaching rules, the project, and the learner summary computed by the app (skills, difficulty, insights).',
      annotations: { readOnlyHint: true },
    },
    async () => ok(`${RULES.constitution}\n\n${await teachingContext(ctx)}`),
  );

  server.registerTool(
    'get_component_catalog',
    { description: 'Reference for writing lessons: every component, its fields, and the expression language.', annotations: { readOnlyHint: true } },
    async () => ok(`${RULES.lessonAuthoring}\n\n${catalogGuide()}`),
  );

  server.registerTool(
    'ask_learner',
    {
      description:
        'Show the learner a form instead of asking in prose, whenever you need several answers or an answer with a shape ' +
        '(choices, numbers, a 1–5 scale, a ranking, short answers). Use it for the interview and for diagnostic probes. ' +
        'Keep each form short (3–6 questions). After calling it, end your turn: the answers arrive as the next message.',
      // Flat on purpose: deeply nested tool input with long text is where models emit broken JSON.
      inputSchema: learnerForm.shape,
    },
    async (fields) =>
      guard(async () => {
        const form = learnerForm.parse(fields);
        const problems = formProblems(form);
        if (problems.length) return fail(`Fix the form:\n${problems.map((p) => `- ${p}`).join('\n')}`);
        if (!ctx.present) return fail('No learner interface is attached; ask in plain text instead.');
        ctx.present(form);
        return ok(`The form "${form.title}" is now in front of the learner. End your turn now; their answers will arrive as the next message.`);
      }),
  );

  server.registerTool(
    'record_evidence',
    {
      description:
        'Record what you observed the learner do on one item (drill answer, prediction, explanation, checkpoint, probe). ' +
        'Be honest: failures and hint use make the learner model accurate. The app computes skill ratings from these.',
      inputSchema: {
        itemId: z.string().min(1).max(120).describe('Stable id of the question/task'),
        kcs: z.array(z.object({ kc: kcId, weight: z.number().positive().max(1).default(1) })).min(1).max(8),
        difficulty: z.int().min(1).max(5).describe('1 easy … 3 standard … 5 hard'),
        evidenceType,
        outcome: z.number().min(0).max(1).describe('0 failure … 1 full success'),
        hintLevel: z.int().min(0).max(5).default(0).describe('The highest hint level given on this item (for a task, the app uses the hints it recorded)'),
        confidence: z.enum(['sure', 'think', 'guess']).optional(),
        transfer: z.boolean().default(false).describe('The item applied the idea to a new situation'),
        agreement: z.number().min(0).max(1).optional().describe('For your own judgements (explain-back): agreement between two independent scorings'),
        note: z.string().max(2000).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const { difficulty, ...rest } = args;
        // Evidence on a task counts the hints given on it, whatever level was reported (W4).
        const hinted = [...hintStates(ctx.profile.journal.events, ctx.projectId).entries()].find(([key, h]) => rest.itemId === key || rest.itemId === h.taskId);
        const hintLevel = Math.max(rest.hintLevel, hinted?.[1].max ?? 0);
        const e = await observations.recordEvidence({ ...stripUndefined(rest), hintLevel, author: ctx.agent, difficulty: difficultyFromLevel(difficulty) });
        return ok(`Recorded ${e.id}.`);
      }),
  );

  server.registerTool(
    'record_instruction',
    {
      description: 'Record that the learner was just taught these KCs (needed to judge later retention).',
      inputSchema: { kcs: z.array(kcId).min(1).max(32), lessonId: z.string().max(120).optional() },
    },
    async (args) =>
      guard(async () => {
        const e = await observations.recordInstruction({ ...stripUndefined(args), author: ctx.agent });
        return ok(`Recorded ${e.id}.`);
      }),
  );

  server.registerTool(
    'record_insight',
    {
      description:
        'Record a hypothesis about how this learner learns ("propose"), or support/contradict an existing one by id. ' +
        'Trust is computed by the app from repetition; you cannot set it.',
      inputSchema: {
        stance: z.enum(['propose', 'support', 'contradict']),
        insightId: z.string().max(80).optional().describe('Required for support/contradict'),
        text: z.string().min(1).max(500).optional().describe('Required for propose'),
        scope: z.string().max(140).optional().describe('"global", "project:<id>" or "kc:<id>"'),
        evidence: z.array(z.string().max(80)).max(20).default([]),
        note: z.string().max(1000).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        if (args.stance === 'propose' && !args.text) return fail('"text" is required to propose an insight.');
        if (args.stance !== 'propose' && !args.insightId) return fail('"insightId" is required to support or contradict.');
        const insightId = args.stance === 'propose' ? newId('ins') : args.insightId!;
        const e = await observations.recordInsight({ ...stripUndefined({ ...args, insightId }), author: ctx.agent });
        return ok(`Recorded ${e.id} for insight ${insightId}.`);
      }),
  );

  server.registerTool(
    'draft_lesson',
    {
      description:
        'Create or replace a lesson. The document must follow the component catalog (see get_component_catalog). ' +
        'It is validated; errors are returned for you to fix. Depending on the learner setting it applies now or waits for review.',
      inputSchema: { lesson: z.record(z.string(), z.unknown()), reason: z.string().max(1000).default('new lesson') },
    },
    async ({ lesson, reason }) =>
      guard(async () => {
        const r = validateLesson(lesson);
        if (!r.lesson) return fail(`Rejected; fix these and try again:\n${formatProblems(r.errors)}`);
        const target = lessonTarget(ctx.projectId, r.lesson.id);
        const exists = (await changes.read(target)) !== null;
        const change = await changes.propose(
          { author: ctx.agent, target, reason, patch: [{ op: exists ? 'replace' : 'add', path: '', value: normalizeLesson(lesson) as JsonValue }] },
          ctx.changeMode(),
        );
        return ok(
          `Lesson "${r.lesson.id}" ${change.status === 'applied' ? 'saved' : 'proposed for the learner\'s review'} (change ${change.changeId}).` +
            (r.warnings.length ? `\nComposition advice:\n${formatProblems(r.warnings)}` : ''),
        );
      }),
  );

  /** The lesson as it stands: applied, or the draft still waiting for review (undefined: none). */
  const currentLesson = async (lessonId: string): Promise<{ doc: JsonValue; pending?: ChangeState } | undefined> => {
    const target = lessonTarget(ctx.projectId, lessonId);
    const applied = await changes.read(target);
    if (applied !== null) return { doc: applied };
    const pending = changes.list({ status: 'proposed', target }).at(-1);
    return pending ? { doc: applyPatch(null, pending.patch).doc, pending } : undefined;
  };

  /** Apply a revision; a draft waiting for review absorbs it, so the learner still approves one lesson. */
  const reviseLesson = async (lessonId: string, patch: readonly PatchOp[], reason: string): Promise<{ text: string; applied: boolean } | { error: string }> => {
    const target = lessonTarget(ctx.projectId, lessonId);
    const now = await currentLesson(lessonId);
    if (!now) return { error: `No lesson "${lessonId}".` };
    if (now.pending) {
      let revised: JsonValue;
      try {
        revised = applyPatch(now.doc, patch).doc;
      } catch (err) {
        return { error: `cannot apply to the draft: ${(err as Error).message}` };
      }
      const change = await changes.propose(
        { author: ctx.agent, target, reason: `${now.pending.reason}; ${reason}`, patch: [{ op: 'add', path: '', value: normalizeLesson(revised) as JsonValue }] },
        ctx.changeMode(),
      );
      await changes.reject(now.pending.changeId, ctx.agent, `superseded by ${change.changeId}`);
      return { text: `The draft waiting for review now includes this revision (change ${change.changeId} replaces ${now.pending.changeId}).`, applied: false };
    }
    const change = await changes.propose({ author: ctx.agent, target, reason, patch: [...patch] }, ctx.changeMode());
    const applied = change.status === 'applied';
    return { text: `Revision ${applied ? 'applied' : 'proposed for review'} (change ${change.changeId}).`, applied };
  };

  server.registerTool(
    'revise_lesson',
    {
      description: 'Change part of an existing lesson with a JSON Patch (RFC 6902: add, remove, replace, test). The result is validated.',
      inputSchema: {
        lessonId: z.string().max(64),
        patch: z.array(patchOp as z.ZodType<PatchOp>).min(1).max(100),
        reason: z.string().min(1).max(1000),
      },
    },
    async ({ lessonId, patch, reason }) =>
      guard(async () => {
        const r = await reviseLesson(lessonId, patch, reason);
        return 'error' in r ? fail(r.error) : ok(r.text);
      }),
  );

  server.registerTool(
    'add_to_lesson',
    {
      description:
        'Add practice to a lesson instead of setting exercises in the chat: one to three blocks (a drill, a task, a predict…, as in the component catalog) ' +
        'inserted into a section, at the end or before the block at `before`. Returns the link that sends the learner to it.',
      inputSchema: {
        lessonId: z.string().max(64),
        sectionId: z.string().max(64),
        blocks: z.array(z.record(z.string(), z.unknown())).min(1).max(3),
        before: z.number().int().min(0).optional(),
        reason: z.string().min(1).max(1000),
      },
    },
    async ({ lessonId, sectionId, blocks, before, reason }) =>
      guard(async () => {
        const now = await currentLesson(lessonId);
        if (!now) return fail(`No lesson "${lessonId}".`);
        const sections = (now.doc as { sections?: { id?: unknown; blocks?: unknown[] }[] }).sections ?? [];
        const si = sections.findIndex((x) => x.id === sectionId);
        if (si < 0) return fail(`No section "${sectionId}" in "${lessonId}". Its sections: ${sections.map((x) => x.id).join(', ')}.`);
        const count = sections[si]!.blocks?.length ?? 0;
        const at = before === undefined ? count : Math.min(before, count);
        const patch: PatchOp[] = blocks.map((b, i) => ({ op: 'add', path: `/sections/${si}/blocks/${at + i}`, value: b as JsonValue }));
        const r = await reviseLesson(lessonId, patch, reason);
        if ('error' in r) return fail(r.error);
        const link = `#lesson:${lessonId}/${sectionId}/${at}`;
        return ok(
          `${r.text}
Send the learner to it with a Markdown link to \`${link}\`, e.g. [Try it in the lesson](${link}).` +
            (r.applied ? '' : ' It waits for their review: tell them to accept it first (it shows in the chat), then follow the link.'),
        );
      }),
  );

  server.registerTool(
    'record_hint',
    {
      description:
        'Call this BEFORE giving a hint on a lesson task, with the ladder level you mean to use (0 reflect, 1 point, 2 Socratic question, ' +
        '3 analogous worked example, 4 structure of their function with the key part blank, 5 principle stated plainly). The app checks ' +
        'the ladder: start at L0 or L1, one level up at a time, L4+ only after a new attempt. If it refuses, give the level it allows.',
      inputSchema: {
        lessonId: z.string().max(64),
        taskId: z.string().max(64),
        level: z.int().min(0).max(5),
        summary: z.string().trim().max(300).optional().describe('What the hint is about, in a few words (shown to the learner)'),
      },
    },
    async ({ lessonId, taskId, level, summary }) =>
      guard(async () => {
        const now = await currentLesson(lessonId);
        if (!now) return fail(`No lesson "${lessonId}".`);
        const tasks = ((normalizeLesson(now.doc) as { sections?: { blocks?: { type?: unknown; id?: unknown; title?: unknown; files?: unknown }[] }[] }).sections ?? []).flatMap(
          (x) => (x.blocks ?? []).filter((b) => b.type === 'task'),
        );
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return fail(`No task "${taskId}" in "${lessonId}". Its tasks: ${tasks.map((t) => t.id).join(', ') || 'none'}.`);
        const files = await taskFiles(ctx, Array.isArray(task.files) ? task.files.filter((f): f is string => typeof f === 'string') : []);
        const state = hintStates(ctx.profile.journal.events, ctx.projectId, lessonId).get(`${lessonId}/${taskId}`);
        const changed = state !== undefined && files.some((f) => {
          const before = state.files.find((b) => b.path === f.path);
          return before !== undefined && before.sha !== f.sha;
        });
        const check = checkHint(state, level, changed);
        if (!check.ok) {
          const a = HINT_LEVELS[check.allowed]!;
          return fail(`Not at L${level}. ${check.reason} Give an L${check.allowed} hint instead (${a.name}: ${a.does}), and tell the learner what unlocks the next level.`);
        }
        await ctx.profile.hints.record(ctx.agent, { projectId: ctx.projectId, lessonId, taskId, level, ...(summary ? { summary } : {}), files });
        const l = HINT_LEVELS[level]!;
        return ok(`L${level} (${l.name}) recorded for "${typeof task.title === 'string' ? task.title : taskId}": ${l.does}. Never the solution. When you record evidence on this task, its hint level counts.`);
      }),
  );

  server.registerTool(
    'get_skill_map',
    {
      description:
        "Read the learner's skill map: every skill across all their projects, its group, its links, and where the learner stands on it (computed by the app).",
      annotations: { readOnlyHint: true },
    },
    async () => ok(describeSkillMap(await readSkillMap(changes), deriveLearnerState(ctx.profile.journal.events, ctx.profile.journal.now()))),
  );

  server.registerTool(
    'update_skill_map',
    {
      description:
        "Describe the learner's skill map (shared by all their projects): add or change skills and nested groups (a group's parent is the broader one), link them " +
        '(prereq / confusable / related), and suggest undiscovered skills they could learn next ("suggested": true, with "why"). ' +
        'Reuse existing ids (call get_skill_map first). Send new skills together with the links that use them. ' +
        'You describe the map; the app computes every level from evidence, so never put a level in a title or summary.',
      inputSchema: skillMapUpdate,
    },
    async (args) =>
      guard(async () => {
        const map = await ensureSkillMap(changes);
        const u = withPendingReferences(map, z.object(skillMapUpdate).parse(args), changes);
        const { patch, problems } = skillMapPatch(map, u);
        if (problems.length) return fail(`Nothing changed; fix these and try again:\n${problems.map((p) => `- ${p}`).join('\n')}`);
        if (patch.length === 0) return fail('Nothing to change.');
        const change = await changes.propose({ author: ctx.agent, target: SKILL_MAP_TARGET, patch, reason: u.reason }, ctx.changeMode());
        return ok(`Skill map ${change.status === 'applied' ? 'updated' : "change proposed for the learner's review"} (change ${change.changeId}).`);
      }),
  );

  server.registerTool(
    'set_curriculum',
    {
      description:
        "Set this project's curriculum: the goal skills, and a rolling plan of lessons (detail only the next 2–3; refine later ones as evidence arrives). " +
        'Every skill must be in the skill map (update_skill_map first). Set lessonId on a plan item once its lesson is drafted. Replaces the previous curriculum.',
      inputSchema: {
        goals: z.array(kcId).min(1).max(30).describe('The skills this project is for'),
        plan: curriculumDoc.shape.plan,
        reason: z.string().trim().min(1).max(1000),
      },
    },
    async ({ goals, plan, reason }) =>
      guard(async () => {
        const doc = { schemaVersion: 1 as const, goals, plan };
        const problems = validateCurriculum(doc);
        const known = await knownSkills(changes);
        const unknown = [...new Set([...goals, ...plan.flatMap((p) => p.kcs)])].filter((k) => !known.has(k));
        if (unknown.length) problems.push(`not in the skill map yet (add them with update_skill_map): ${unknown.join(', ')}`);
        if (problems.length) return fail(`Rejected; fix these and try again:\n${problems.map((p) => `- ${p}`).join('\n')}`);
        const change = await proposeWhole(ctx, curriculumTarget(ctx.projectId), doc, reason);
        return ok(`Curriculum ${change.status === 'applied' ? 'saved' : "proposed for the learner's review"} (change ${change.changeId}).`);
      }),
  );

  server.registerTool(
    'update_roadmap',
    {
      description:
        "Propose changes to the project's roadmap: the milestones of the learner's real project, in order (e.g. the stages of their engine). " +
        'Each milestone you add, change or remove is its own change, which the learner can accept, reject or undo on its own. ' +
        'Fields you leave out keep their value. Base the roadmap on their goal, their repo and the files they imported.',
      inputSchema: roadmapUpdate,
    },
    async (args) =>
      guard(async () => {
        const roadmap = await ensureRoadmap(changes, ctx.projectId);
        const { patches, problems } = roadmapPatches(roadmap, z.object(roadmapUpdate).parse(args));
        if (problems.length) return fail(`Nothing changed; fix these and try again:\n${problems.map((p) => `- ${p}`).join('\n')}`);
        if (patches.length === 0) return fail('Nothing to change.');
        const done: string[] = [];
        for (const { id, patch } of patches) {
          const change = await changes.propose({ author: ctx.agent, target: roadmapTarget(ctx.projectId), patch, reason: `roadmap, ${id}: ${args.reason}` }, ctx.changeMode());
          done.push(`${id} (${change.status === 'applied' ? 'applied' : 'waiting for review'})`);
        }
        return ok(`Roadmap changes: ${done.join(', ')}.`);
      }),
  );

  server.registerTool(
    'save_assessment',
    {
      description:
        'After the first interview: save what you found, as you played it back to the learner. Levels come from the probe evidence you recorded, ' +
        'so describe findings in words. Replaces the previous assessment; the learner can read and correct it.',
      inputSchema: {
        summary: z.string().trim().min(1).max(2000).describe('The playback: strong on X, shaky on Y, misconception Z, bridge via W'),
        strengths: assessmentDoc.shape.strengths,
        gaps: assessmentDoc.shape.gaps,
        misconceptions: assessmentDoc.shape.misconceptions,
        bridges: assessmentDoc.shape.bridges,
        preferences: assessmentDoc.shape.preferences,
        reason: z.string().trim().min(1).max(1000).default('first interview'),
      },
    },
    async ({ reason, ...fields }) =>
      guard(async () => {
        const doc = assessmentDoc.parse({ schemaVersion: 1, ...fields });
        const change = await proposeWhole(ctx, assessmentTarget(ctx.projectId), doc, reason);
        return ok(`Assessment ${change.status === 'applied' ? 'saved' : "proposed for the learner's review"} (change ${change.changeId}).`);
      }),
  );

  server.registerTool(
    'write_file',
    {
      description:
        "Write a file in the learner's workspace, if they allowed it (see the permissions in get_teaching_context): tests in the tests folder " +
        "(prefer tests that use the learner's code from outside it), supporting code (viewers, plots, benchmarks) in the tool folders, or, " +
        "only if allowed, a proposed edit to one of the learner's files (always reviewed by them). The whole new content is sent. Never the " +
        'code an open task asks the learner to write: that is refused. Every write can be undone by the learner.',
      inputSchema: {
        path: z.string().min(1).max(400).describe('Relative to the workspace, forward slashes'),
        content: z.string().max(MAX_AGENT_FILE_CHARS),
        reason: z.string().trim().min(1).max(1000).describe('What this file is for, in a sentence the learner will read'),
      },
    },
    async ({ path: file, content, reason }) =>
      guard(async () => {
        const access = await projectAccess(changes, ctx.projectId);
        if (!access.workspace) return fail('This project has no workspace folder, so there is nowhere to write.');
        const where = classifyWrite(access.permissions, file);
        if (!where.allowed) return fail(`Not written: ${where.reason}.`);
        const rel = workspaceRelative(file)!;
        // P1: a test or a tool must never contain the code an open task asks for.
        const progress = projectProgress(ctx.profile.journal.events, ctx.projectId);
        for (const l of await projectLessons(ctx.profile, ctx.projectId)) {
          const hit = solutionFor(content, openTaskShapes(l, progress[l.id] ?? {}));
          if (hit) return fail(`Not written: this implements "${hit.title}", which the learner is writing themselves (lesson ${l.id}). Test it from outside, or stub it.`);
        }
        let disk: string | null;
        try {
          disk = await readDisk(await workspaceFile(access.workspace, rel));
        } catch {
          return fail(`"${rel}" is outside the workspace.`);
        }
        const target = agentFileTarget(ctx.projectId, rel);
        const current = (await changes.read(target)) as AgentFileDoc | null;
        if ((current?.content ?? disk) === content) return ok(`"${rel}" already has this content.`);
        const patch: PatchOp[] = current
          ? [{ op: 'replace', path: '/content', value: content }]
          : [{ op: 'add', path: '', value: { schemaVersion: 1, path: rel, content, original: disk } }];
        // The learner's own files always wait for their review, whatever their setting.
        const mode = where.area === 'mine' ? 'review' : ctx.changeMode();
        const change = await changes.propose({ author: ctx.agent, target, patch, reason: `${rel}: ${reason}` }, mode);
        return ok(`"${rel}" ${change.status === 'applied' ? 'written' : "proposed for the learner's review"} (change ${change.changeId}, ${where.reason}).`);
      }),
  );

  server.registerTool(
    'run_tests',
    {
      description:
        "Run the learner's own test command in their workspace, if they allowed you to measure, and get the pass counts and the end of the output. " +
        'Use it to check tests you wrote, or to see where the learner stands. It records nothing about the learner.',
      inputSchema: { suite: z.string().max(200).optional().describe('A test name or filter, used where the command has {suite}') },
    },
    async ({ suite }) =>
      guard(async () => {
        const access = await projectAccess(changes, ctx.projectId);
        if (!access.permissions.measure) return fail('The learner has not allowed you to run anything.');
        if (!access.workspace || !access.testCommand) return fail('This project has no workspace folder or no test command.');
        if (changes.list({ target: projectTarget(ctx.projectId) }).some((c) => c.status === 'applied' && c.author.kind === 'agent')) {
          return fail('The project settings were changed by a tutor, so its test command is not run.');
        }
        if (suite === undefined && access.testCommand.includes(SUITE_PLACEHOLDER)) {
          return fail(`The test command is "${access.testCommand}": give the suite (a test name or filter) to put in {suite}.`);
        }
        let argv: string[];
        try {
          argv = checkpointArgv(access.testCommand, suite ?? '');
        } catch (err) {
          return fail((err as Error).message);
        }
        return ok(await measure(argv, access.workspace));
      }),
  );

  server.registerTool(
    'run_command',
    {
      description: 'Run one of the commands the learner listed for you (to take measurements: a benchmark, a simulation run), in their workspace. Only those exact commands.',
      inputSchema: { command: z.string().trim().min(1).max(300) },
    },
    async ({ command }) =>
      guard(async () => {
        const access = await projectAccess(changes, ctx.projectId);
        if (!access.permissions.measure) return fail('The learner has not allowed you to run anything.');
        if (!access.permissions.commands.includes(command)) {
          return fail(`Only the commands the learner listed can run: ${access.permissions.commands.map((c) => `"${c}"`).join(', ') || 'none yet'}.`);
        }
        if (!access.workspace) return fail('This project has no workspace folder.');
        let argv: string[];
        try {
          argv = splitCommand(command);
        } catch (err) {
          return fail((err as Error).message);
        }
        return ok(await measure(argv, access.workspace));
      }),
  );

  server.registerTool(
    'list_sources',
    {
      description:
        'List the files the learner imported into this project (papers, notes, past lessons, code from elsewhere). Read one with read_source, or search them all with search_sources.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const sources = Object.entries(await readSources(ctx.profile, ctx.projectId)).sort(([, a], [, b]) => a.addedAt.localeCompare(b.addedAt));
      if (sources.length === 0) return ok('No imported files yet.');
      return ok(
        sources
          .map(([id, s]) => `- ${id}: "${s.name}" (${s.kind}${s.pages ? `, ${s.pages} pages` : ''}, ${s.chars} characters of text, added ${s.addedAt.slice(0, 10)})${s.note ? ` ${s.note}` : ''}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'read_source',
    {
      description: 'Read the text of an imported file, a page of characters at a time (PDFs carry [page N] markers). Cite where an idea comes from when you use it.',
      inputSchema: {
        sourceId: z.string().max(80),
        offset: z.int().min(0).default(0).describe('Character to start at'),
        length: z.int().min(100).max(40_000).default(20_000),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sourceId, offset, length }) => {
      const text = await sourceText(ctx.profile, ctx.projectId, sourceId);
      if (text === undefined) return fail(`No imported file "${sourceId}" in this project (see list_sources).`);
      if (text === '') return ok('This file has no text (an image or a binary file).');
      const part = text.slice(offset, offset + length);
      const end = offset + part.length;
      return ok(`${part}\n\n[characters ${offset}–${end} of ${text.length}${end < text.length ? `; continue with offset ${end}` : '; end of file'}]`);
    },
  );

  server.registerTool(
    'search_sources',
    {
      description: 'Find a word or phrase in every imported file (case-insensitive). Returns short passages with where they are.',
      inputSchema: { query: z.string().trim().min(2).max(200), maxResults: z.int().min(1).max(50).default(15) },
      annotations: { readOnlyHint: true },
    },
    async ({ query, maxResults }) => {
      const needle = query.toLowerCase();
      const hits: string[] = [];
      for (const [id, s] of Object.entries(await readSources(ctx.profile, ctx.projectId))) {
        const text = (await sourceText(ctx.profile, ctx.projectId, id)) ?? '';
        const lower = text.toLowerCase();
        for (let at = lower.indexOf(needle); at !== -1 && hits.length < maxResults; at = lower.indexOf(needle, at + needle.length)) {
          const page = text.slice(0, at).match(/\[page (\d+)\]/g)?.at(-1);
          const snippet = text.slice(Math.max(0, at - 120), at + needle.length + 120).replace(/\s+/g, ' ');
          hits.push(`- ${id} "${s.name}" at ${at}${page ? ` (${page.slice(1, -1)})` : ''}: …${snippet}…`);
        }
        if (hits.length >= maxResults) break;
      }
      return ok(hits.length ? hits.join('\n') : `"${query}" does not appear in the imported files.`);
    },
  );

  server.registerTool(
    'get_lesson',
    {
      description: 'Read a lesson document. Link the learner to a part of it as #lesson:<lessonId>/<sectionId>, or …/<sectionId>/<n> for its n-th block (from 0).',
      inputSchema: { lessonId: z.string().max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ lessonId }) =>
      guard(async () => {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(lessonId)) return fail('Invalid lesson id.');
        const doc = await changes.read(lessonTarget(ctx.projectId, lessonId));
        return doc === null ? fail(`No lesson "${lessonId}".`) : ok(JSON.stringify(doc));
      }),
  );

  server.registerTool(
    'list_lessons',
    { description: 'List the lessons of this project.', annotations: { readOnlyHint: true } },
    async () => {
      const ids = lessonIds(changes, ctx.projectId);
      return ok(ids.length ? ids.join('\n') : 'No lessons yet.');
    },
  );

  return server;
}

/** Run a command for the tutor: bounded in time and output, never through a shell. */
async function measure(argv: readonly string[], cwd: string): Promise<string> {
  let r;
  try {
    r = await runCommand({ argv, cwd, timeoutMs: 5 * 60_000, maxOutput: 1024 * 1024 });
  } catch (err) {
    return `Could not run it: ${(err as Error).message}`;
  }
  const counts = parseTestOutput(r.output);
  const head = [
    r.timedOut ? 'Stopped after 5 minutes.' : `Exit code ${r.exitCode}, ${r.durationMs} ms.`,
    counts ? `Tests: ${counts.passed} passed, ${counts.failed} failed${counts.failures.length ? ` (failing: ${counts.failures.slice(0, 10).join(', ')})` : ''}.` : '',
  ].filter(Boolean);
  const tail = r.output.slice(-16_000);
  return `${head.join(' ')}\n\nOutput${tail.length < r.output.length || r.truncated ? ' (the end of it)' : ''}:\n${tail}`;
}

/**
 * Propose a whole document. An earlier proposal for it that still waits for review is superseded,
 * so the learner only ever reviews the latest version.
 */
async function proposeWhole(ctx: TeacherContext, target: string, doc: unknown, reason: string) {
  const { changes } = ctx.profile;
  const exists = (await changes.read(target)) !== null;
  const change = await changes.propose({ author: ctx.agent, target, reason, patch: [{ op: exists ? 'replace' : 'add', path: '', value: doc as JsonValue }] }, ctx.changeMode());
  for (const p of changes.list({ status: 'proposed', target })) {
    if (p.changeId !== change.changeId) await changes.reject(p.changeId, ctx.agent, `superseded by ${change.changeId}`);
  }
  return change;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** A task's files as they are now (content hashes), to tell later whether the learner changed them. */
async function taskFiles(ctx: TeacherContext, files: readonly string[]): Promise<{ path: string; sha: string | null }[]> {
  const { workspace } = await projectAccess(ctx.profile.changes, ctx.projectId);
  if (!workspace) return [];
  const out: { path: string; sha: string | null }[] = [];
  for (const f of files.slice(0, 20)) {
    const rel = workspaceRelative(f);
    if (!rel) continue;
    let text: string | null = null;
    try {
      text = await readDisk(await workspaceFile(workspace, rel));
    } catch {
      // outside the workspace, or unreadable: not a file to watch
      continue;
    }
    out.push({ path: f, sha: text === null ? null : createHash('sha256').update(text).digest('hex').slice(0, 32) });
  }
  return out;
}
