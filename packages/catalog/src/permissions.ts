import { z } from 'zod';

/**
 * What the tutor may do in a project's workspace, decided by the learner when the project is
 * created and changeable at any time in its settings. The default is conservative: the tutor
 * writes tests in a folder of its own, and nothing else. Whatever is allowed, the tutor never
 * writes the code an open task asks the learner to write (P1), and every file it writes is a
 * change the learner can review and undo.
 */
const folder = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?![/\\])(?!.*(^|[/\\])\.\.?([/\\]|$))(?!.*\\)[^\0]+$/, { message: 'a folder inside the workspace, like "viewer" or "tests/aporia"' })
  .transform((f) => f.replace(/\/+$/, ''));

export const agentPermissions = z.strictObject({
  /** Write tests, in `testsDir` (outside the learner's own files). */
  tests: z.boolean().default(true),
  testsDir: folder.default('aporia-tests'),
  /** Write supporting code the learner is not here to learn (a viewer, plots, benchmarks), in `toolDirs`. */
  tools: z.boolean().default(false),
  toolDirs: z.array(folder).max(10).default([]),
  /** Run the project's tests and the commands listed here, to measure and check. */
  measure: z.boolean().default(false),
  commands: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** Propose edits to the learner's own files (e.g. adding a test target to the build). Always reviewed. */
  editMine: z.boolean().default(false),
  /** Anything else the learner wants the tutor to know about what it may and may not do. */
  notes: z.string().trim().max(2000).default(''),
});
export type AgentPermissions = z.output<typeof agentPermissions>;
export type AgentPermissionsInput = z.input<typeof agentPermissions>;

export const DEFAULT_PERMISSIONS: AgentPermissions = agentPermissions.parse({});

/** Where a file the tutor wants to write falls, and whether it may. */
export type WriteArea = 'tests' | 'tools' | 'mine';

const inside = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);

/** Folders no tool should write into, whatever the permissions. */
const NEVER = /^(\.git|\.hg|\.svn)(\/|$)|(^|\/)(\.git)(\/|$)/;

/** A workspace-relative path, normalised, or undefined when it is not one (absolute, `..`, backslashes). */
export function workspaceRelative(p: string): string | undefined {
  const t = p.trim().replace(/^\.\//, '');
  if (t === '' || t.length > 400 || t.startsWith('/') || /^[A-Za-z]:/.test(t) || t.includes('\\') || t.includes('\0')) return undefined;
  const parts = t.split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..')) return undefined;
  return parts.join('/');
}

export function classifyWrite(perms: AgentPermissions, path: string): { area: WriteArea; allowed: boolean; reason: string } | { area: undefined; allowed: false; reason: string } {
  const rel = workspaceRelative(path);
  if (rel === undefined) return { area: undefined, allowed: false, reason: `"${path}" is not a path inside the workspace` };
  if (NEVER.test(rel)) return { area: undefined, allowed: false, reason: 'version-control folders are never written' };
  if (inside(rel, perms.testsDir)) {
    return perms.tests
      ? { area: 'tests', allowed: true, reason: `in the tests folder (${perms.testsDir})` }
      : { area: 'tests', allowed: false, reason: 'the learner has not allowed you to write tests' };
  }
  const tool = perms.toolDirs.find((d) => inside(rel, d));
  if (tool !== undefined) {
    return perms.tools
      ? { area: 'tools', allowed: true, reason: `in a tool folder (${tool})` }
      : { area: 'tools', allowed: false, reason: 'the learner has not allowed you to write tools' };
  }
  return perms.editMine
    ? { area: 'mine', allowed: true, reason: "one of the learner's own files: the change waits for their review" }
    : {
        area: 'mine',
        allowed: false,
        reason: `"${rel}" is one of the learner's own files, and they have not allowed edits to them. Write tests in ${perms.testsDir}/${perms.tools && perms.toolDirs.length ? ` or tools in ${perms.toolDirs.join(', ')}` : ''}.`,
      };
}

/** The permissions in words, for the tutor's context. */
export function describePermissions(p: AgentPermissions): string {
  const lines = [
    p.tests ? `- You may write tests in \`${p.testsDir}/\` (external tests: they use the learner's code, never edit it).` : '- You may not write tests.',
    p.tools && p.toolDirs.length
      ? `- You may write supporting code (viewers, plots, benchmarks) in ${p.toolDirs.map((d) => `\`${d}/\``).join(', ')}: the learner is not here to learn that part.`
      : '- You may not write supporting code (tools, viewers).',
    p.measure
      ? `- You may run the project's tests${p.commands.length ? ` and these commands: ${p.commands.map((c) => `\`${c}\``).join(', ')}` : ''}, to measure and check.`
      : '- You may not run anything.',
    p.editMine ? "- You may propose edits to the learner's own files; each one waits for their review. Prefer the folders above." : "- You may not edit the learner's own files.",
  ];
  if (p.notes) lines.push(`- The learner adds: ${p.notes}`);
  lines.push('- Never write the code an open task asks the learner to write: the app refuses it.');
  return lines.join('\n');
}
