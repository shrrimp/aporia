import { createHash } from 'node:crypto';
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { agentPermissions, workspaceRelative, type AgentPermissions } from '@app/catalog';
import { ChangeConflictError, PathEscapeError, resolveInsideReal, writeFileAtomic, type ChangeService, type DocumentEffect, type JsonValue } from '@app/core';
import { projectTarget } from './paths.ts';

/**
 * Files the tutor writes in the learner's workspace (tests, tools), when the learner allows it.
 * Each file is a change-tracked document, projects/<id>/agent-files/<key>.json, holding the path,
 * the content, and what the file held before the tutor's first change: so every write can be
 * reviewed, rejected, undone and redone like any other change, and undoing the first one
 * restores the file as it was (or removes it). A change made meanwhile by the learner is never
 * overwritten: it is reported as a conflict instead.
 */
export const MAX_AGENT_FILE_CHARS = 512 * 1024;

export const agentFileTarget = (projectId: string, file: string) =>
  `projects/${projectId}/agent-files/${createHash('sha256').update(file).digest('hex').slice(0, 24)}.json`;
const AGENT_FILE_TARGET = /^projects\/([^/]+)\/agent-files\/[0-9a-f]{24}\.json$/;

export const agentFileDoc = z.strictObject({
  schemaVersion: z.literal(1),
  path: z.string().refine((p) => workspaceRelative(p) === p, { message: 'a relative path inside the workspace' }),
  content: z.string().max(MAX_AGENT_FILE_CHARS),
  /** The file before the tutor first wrote it; null when it did not exist. */
  original: z.string().nullable(),
});
export type AgentFileDoc = z.output<typeof agentFileDoc>;

export function isAgentFileTarget(target: string): boolean {
  return AGENT_FILE_TARGET.test(target);
}

export function validateAgentFile(target: string, doc: unknown): string[] {
  const parsed = agentFileDoc.safeParse(doc);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`);
  const project = AGENT_FILE_TARGET.exec(target)![1]!;
  return target === agentFileTarget(project, parsed.data.path) ? [] : ['the file record is stored under the wrong key'];
}

/** The project's workspace and the learner's permissions, as they are now. */
export async function projectAccess(changes: ChangeService, projectId: string): Promise<{ workspace: string | undefined; permissions: AgentPermissions; testCommand: string | undefined }> {
  const doc = (await changes.read(projectTarget(projectId))) as { workspace?: unknown; testCommand?: unknown; agent?: unknown } | null;
  const parsed = agentPermissions.safeParse(doc?.agent ?? {});
  return {
    workspace: typeof doc?.workspace === 'string' && path.isAbsolute(doc.workspace) ? doc.workspace : undefined,
    permissions: parsed.success ? parsed.data : agentPermissions.parse({}),
    testCommand: typeof doc?.testCommand === 'string' ? doc.testCommand : undefined,
  };
}

/** A file in the workspace (symlinks inside it followed, escapes refused). */
export async function workspaceFile(workspace: string, rel: string): Promise<string> {
  return resolveInsideReal(workspace, ...rel.split('/'));
}

/** What is on disk now; null when there is no such file. */
export async function readDisk(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The effect that keeps the workspace in step with the file records. Registered for the open
 * profile; `check` runs before a change is recorded, so a refusal leaves no trace.
 */
export function agentFilesEffect(changes: ChangeService): DocumentEffect {
  const locate = async (target: string, doc: AgentFileDoc) => {
    const projectId = AGENT_FILE_TARGET.exec(target)![1]!;
    const { workspace } = await projectAccess(changes, projectId);
    if (!workspace) throw new ChangeConflictError('this project has no workspace folder any more');
    try {
      return await workspaceFile(workspace, doc.path);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new ChangeConflictError(`"${doc.path}" is no longer inside the workspace`);
      throw err;
    }
  };
  const parse = (doc: JsonValue) => (doc === null ? null : agentFileDoc.parse(doc));
  return {
    matches: isAgentFileTarget,
    async check(target, beforeJson, afterJson) {
      const before = parse(beforeJson);
      const after = parse(afterJson);
      const doc = (after ?? before)!;
      const disk = await readDisk(await locate(target, doc));
      // What the file must hold now for this change to apply cleanly.
      const expected = before ? before.content : after!.original;
      if (disk !== expected) {
        throw new ChangeConflictError(
          `"${doc.path}" changed in the workspace since (perhaps you edited it). Nothing was written; look at the file, then try again.`,
        );
      }
    },
    async apply(target, beforeJson, afterJson) {
      const before = parse(beforeJson);
      const after = parse(afterJson);
      const file = await locate(target, (after ?? before)!);
      const content = after ? after.content : before!.original;
      if (content === null) {
        await rm(file, { force: true });
        return;
      }
      const mode = (await stat(file).catch(() => undefined))?.mode;
      await writeFileAtomic(file, content);
      if (mode !== undefined) await chmod(file, mode & 0o7777);
    },
  };
}
