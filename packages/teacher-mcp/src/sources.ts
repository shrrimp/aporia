import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInside, type OpenProfile } from '@app/core';

/**
 * Files the learner imported into a project (the server adds them). Copied into the project:
 * projects/<id>/sources/<source-id>/original and text.txt, the text the tutor reads. The index is
 * a change-tracked document, so adding and removing files shows in History and is undoable.
 */
export const sourcesTarget = (projectId: string) => `projects/${projectId}/sources.json`;
export const SOURCE_ID = /^src_[0-9a-f-]+$/;

const sourceEntry = z.strictObject({
  name: z.string().min(1).max(255),
  kind: z.enum(['text', 'markdown', 'html', 'code', 'pdf', 'image', 'other']),
  size: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  addedAt: z.string(),
  chars: z.int().min(0),
  pages: z.int().min(0).optional(),
  note: z.string().max(500).optional(),
});
export const sourcesDoc = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.record(z.string().regex(SOURCE_ID), sourceEntry),
});
export type SourceEntry = z.output<typeof sourceEntry>;
export type SourcesDoc = z.output<typeof sourcesDoc>;

export function validateSources(doc: unknown): string[] {
  const parsed = sourcesDoc.safeParse(doc);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(sources)'}: ${i.message}`);
}

export async function readSources(profile: Pick<OpenProfile, 'changes'>, projectId: string): Promise<SourcesDoc['sources']> {
  const doc = sourcesDoc.safeParse(await profile.changes.read(sourcesTarget(projectId)));
  return doc.success ? doc.data.sources : {};
}

export const sourceDir = (profileDir: string, projectId: string, sourceId: string) => resolveInside(profileDir, 'projects', projectId, 'sources', sourceId);

/** Text of a source in the project ('' when it had none), or undefined when there is no such source. */
export async function sourceText(profile: Pick<OpenProfile, 'changes' | 'dir'>, projectId: string, sourceId: string): Promise<string | undefined> {
  if (!SOURCE_ID.test(sourceId) || !(sourceId in (await readSources(profile, projectId)))) return undefined;
  try {
    return await readFile(resolveInside(sourceDir(profile.dir, projectId, sourceId), 'text.txt'), 'utf8');
  } catch {
    return '';
  }
}
