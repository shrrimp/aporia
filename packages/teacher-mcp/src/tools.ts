import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { brand } from '@app/brand';
import { catalogGuide, formProblems, learnerForm, validateLesson, type Problem } from '@app/catalog';
import {
  ChangeError,
  ChangeValidationError,
  difficultyFromLevel,
  newId,
  evidenceType,
  kcId,
  patchOp,
  type ChangeService,
  type JsonValue,
  type PatchOp,
} from '@app/core';
import { RULES, lessonTarget, lessonsDir, teachingContext, type TeacherContext } from './context.ts';

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
      inputSchema: { form: learnerForm },
    },
    async ({ form }) =>
      guard(async () => {
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
        hintLevel: z.int().min(0).max(5).default(0),
        confidence: z.enum(['sure', 'think', 'guess']).optional(),
        transfer: z.boolean().default(false).describe('The item applied the idea to a new situation'),
        agreement: z.number().min(0).max(1).optional().describe('For your own judgements (explain-back): agreement between two independent scorings'),
        note: z.string().max(2000).optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const { difficulty, ...rest } = args;
        const e = await observations.recordEvidence({ ...stripUndefined(rest), author: ctx.agent, difficulty: difficultyFromLevel(difficulty) });
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
          { author: ctx.agent, target, reason, patch: [{ op: exists ? 'replace' : 'add', path: '', value: lesson as JsonValue }] },
          ctx.changeMode(),
        );
        return ok(
          `Lesson "${r.lesson.id}" ${change.status === 'applied' ? 'saved' : 'proposed for the learner\'s review'} (change ${change.changeId}).` +
            (r.warnings.length ? `\nComposition advice:\n${formatProblems(r.warnings)}` : ''),
        );
      }),
  );

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
        const target = lessonTarget(ctx.projectId, lessonId);
        if ((await changes.read(target)) === null) return fail(`No lesson "${lessonId}".`);
        const change = await changes.propose({ author: ctx.agent, target, reason, patch }, ctx.changeMode());
        return ok(`Revision ${change.status === 'applied' ? 'applied' : 'proposed for review'} (change ${change.changeId}).`);
      }),
  );

  server.registerTool(
    'get_lesson',
    { description: 'Read a lesson document.', inputSchema: { lessonId: z.string().max(64) }, annotations: { readOnlyHint: true } },
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
      const prefix = `${lessonsDir(ctx.projectId)}/`;
      const ids = [...new Set(changes.list({ status: 'applied' }).map((c) => c.target))]
        .filter((t) => t.startsWith(prefix))
        .map((t) => t.slice(prefix.length, -'.json'.length))
        .sort();
      return ok(ids.length ? ids.join('\n') : 'No lessons yet.');
    },
  );

  return server;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

