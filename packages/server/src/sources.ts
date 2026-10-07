import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { formatPointer, newId, resolveInside, writeFileAtomic, type Author, type JsonValue, type OpenProfile } from '@app/core';
import { readSources, sourceDir, sourcesTarget, type SourceEntry } from '@app/teacher-mcp';
import { AppError } from './errors.ts';
import { extract } from './extract.ts';

/**
 * Adding files to a project (teaching-engine §6): copied in, so where a file came from never
 * matters again. The index and the reading side live in @app/teacher-mcp (sources.ts).
 */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Decoded bytes per upload chunk (base64 over the socket stays well under its 4 MB limit). */
export const MAX_CHUNK_BYTES = 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60_000;

/** A file name as the learner sees it: no folders, no control characters, bounded. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'file').slice(0, 255);
}

/** Store a file as a source of the project. The same content imported twice is kept once. */
export async function addSource(profile: OpenProfile, projectId: string, name: string, data: Uint8Array, author: Author): Promise<{ id: string; entry: SourceEntry; existed: boolean }> {
  if (data.length > MAX_SOURCE_BYTES) throw new AppError('invalid_params', `"${name}" is larger than 50 MB`);
  const clean = cleanName(name);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const current = await readSources(profile, projectId);
  const same = Object.entries(current).find(([, s]) => s.sha256 === sha256);
  if (same) return { id: same[0], entry: same[1], existed: true };

  const id = newId('src');
  const extracted = await extract(clean, data);
  const dir = sourceDir(profile.dir, projectId, id);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(resolveInside(dir, 'original'), data);
  await writeFileAtomic(resolveInside(dir, 'text.txt'), extracted.text);
  const entry: SourceEntry = {
    name: clean,
    kind: extracted.kind,
    size: data.length,
    sha256,
    addedAt: profile.journal.now().toISOString(),
    chars: extracted.text.length,
    ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
    ...(extracted.note ? { note: extracted.note } : {}),
  };
  const exists = (await profile.changes.read(sourcesTarget(projectId))) !== null;
  const patch = exists
    ? [{ op: 'add' as const, path: formatPointer(['sources', id]), value: entry as unknown as JsonValue }]
    : [{ op: 'add' as const, path: '', value: { schemaVersion: 1, sources: { [id]: entry } } as unknown as JsonValue }];
  await profile.changes.propose({ author, target: sourcesTarget(projectId), patch, reason: `added the file "${clean}"` }, 'auto');
  return { id, entry, existed: false };
}

/** Take a source out of the project (undoable from History: the files stay until then). */
export async function removeSource(profile: OpenProfile, projectId: string, sourceId: string, author: Author): Promise<void> {
  const current = await readSources(profile, projectId);
  const entry = current[sourceId];
  if (!entry) throw new AppError('not_found', `no source ${sourceId}`);
  await profile.changes.propose(
    { author, target: sourcesTarget(projectId), patch: [{ op: 'remove', path: formatPointer(['sources', sourceId]) }], reason: `removed the file "${entry.name}"` },
    'auto',
  );
}

interface Upload {
  readonly projectId: string;
  readonly name: string;
  readonly size: number;
  readonly chunks: Buffer[];
  received: number;
  expires: number;
}

/**
 * Files arrive in chunks: a whole file can exceed what one socket message may carry. Uploads are
 * bounded in size and count, and forgotten after a while if never finished.
 */
export class Uploads {
  readonly #open = new Map<string, Upload>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  begin(projectId: string, name: string, size: number): string {
    this.#sweep();
    if (size > MAX_SOURCE_BYTES) throw new AppError('invalid_params', `"${cleanName(name)}" is larger than 50 MB`);
    if (this.#open.size >= 16) throw new AppError('conflict', 'Too many files are being added at once; wait for some to finish.');
    const id = randomUUID();
    this.#open.set(id, { projectId, name, size, chunks: [], received: 0, expires: this.#now() + UPLOAD_TTL_MS });
    return id;
  }

  chunk(uploadId: string, index: number, base64: string): number {
    const u = this.#get(uploadId);
    if (index !== u.chunks.length) throw new AppError('invalid_params', `expected chunk ${u.chunks.length}, got ${index}`);
    const data = Buffer.from(base64, 'base64');
    if (data.length > MAX_CHUNK_BYTES) throw new AppError('invalid_params', 'chunk too large');
    if (u.received + data.length > u.size) {
      this.#open.delete(uploadId);
      throw new AppError('invalid_params', 'the file is larger than announced');
    }
    u.chunks.push(data);
    u.received += data.length;
    u.expires = this.#now() + UPLOAD_TTL_MS;
    return u.received;
  }

  /** The finished file; the upload is forgotten either way. */
  finish(uploadId: string): { projectId: string; name: string; data: Buffer } {
    const u = this.#get(uploadId);
    this.#open.delete(uploadId);
    if (u.received !== u.size) throw new AppError('invalid_params', `the file is incomplete (${u.received} of ${u.size} bytes)`);
    return { projectId: u.projectId, name: u.name, data: Buffer.concat(u.chunks) };
  }

  #get(uploadId: string): Upload {
    this.#sweep();
    const u = this.#open.get(uploadId);
    if (!u) throw new AppError('not_found', 'this upload is unknown or expired; add the file again');
    return u;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, u] of this.#open) if (u.expires < now) this.#open.delete(id);
  }
}
