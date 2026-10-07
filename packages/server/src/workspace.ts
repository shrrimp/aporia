import { createHash } from 'node:crypto';
import { chmod, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PathEscapeError, resolveInsideReal, writeFileAtomic } from '@app/core';
import { AppError } from './errors.ts';

/**
 * The learner's own files, for the embedded editor. Only the learner's interface calls this,
 * on the learner's explicit save; the tutor never can (it has no route to these methods, and its
 * own file writes are refused by the agent host). Every path stays inside the workspace,
 * symlinks included, and a save never overwrites a change made meanwhile in another editor.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 2000;
/** Folders nobody edits by hand, hidden from the file list (still reachable by path). */
const HIDDEN = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'target', '.cache']);

export interface Entry {
  readonly name: string;
  readonly kind: 'file' | 'dir';
}

/** Case-insensitive, then exact: the same order on every machine, whatever its locale. */
const byName = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

const version = (data: Buffer | string) => createHash('sha256').update(data).digest('hex').slice(0, 16);

async function resolve(workspace: string, rel: string): Promise<string> {
  if (!path.isAbsolute(workspace)) throw new AppError('conflict', 'This project has no usable workspace folder.');
  try {
    return rel === '' ? await resolveInsideReal(workspace, '.') : await resolveInsideReal(workspace, ...rel.split('/'));
  } catch (err) {
    if (err instanceof PathEscapeError) throw new AppError('invalid_params', `"${rel}" is outside the workspace`);
    throw err;
  }
}

/** Entries of one folder, folders first. */
export async function listDir(workspace: string, rel: string): Promise<Entry[]> {
  const dir = await resolve(workspace, rel);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('not_found', `no folder "${rel || '.'}" in the workspace`);
    throw err;
  }
  const out: Entry[] = [];
  // A symlink is listed as a file, whatever it points to: it is only followed (and checked) when opened.
  for (const d of dirents.sort((a, b) => byName(a.name, b.name)).slice(0, MAX_ENTRIES)) {
    if (HIDDEN.has(d.name)) continue;
    if (d.isDirectory()) out.push({ name: d.name, kind: 'dir' });
    else if (d.isFile() || d.isSymbolicLink()) out.push({ name: d.name, kind: 'file' });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1));
}

export async function readText(workspace: string, rel: string): Promise<{ content: string; version: string }> {
  const file = await resolve(workspace, rel);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new AppError('not_found', `no file "${rel}" in the workspace`);
  if (info.size > MAX_FILE_BYTES) throw new AppError('invalid_params', `"${rel}" is too large to open here (over 2 MB); use your own editor`);
  const data = await readFile(file);
  if (data.includes(0)) throw new AppError('invalid_params', `"${rel}" is not a text file`);
  return { content: data.toString('utf8'), version: version(data) };
}

/**
 * Save a file. `baseVersion` is the version the learner started editing from (absent for a new
 * file): if the file changed since, nothing is written and the conflict is reported. The file's
 * permissions (e.g. an executable script) are kept.
 */
export async function writeText(workspace: string, rel: string, content: string, baseVersion: string | undefined): Promise<{ version: string }> {
  const data = Buffer.from(content, 'utf8');
  if (data.length > MAX_FILE_BYTES) throw new AppError('invalid_params', 'the file is too large to save here (over 2 MB)');
  const file = await resolve(workspace, rel);
  const current = await stat(file).catch(() => undefined);
  if (current && !current.isFile()) throw new AppError('invalid_params', `"${rel}" is not a file`);
  if (current) {
    const now = version(await readFile(file));
    if (now !== baseVersion) throw new AppError('conflict', `"${rel}" changed on disk since you opened it (maybe in another editor). Reload it, or save again to overwrite.`, { version: now });
  } else if (baseVersion !== undefined) {
    throw new AppError('conflict', `"${rel}" was deleted on disk since you opened it.`, { version: null });
  }
  await writeFileAtomic(file, data);
  if (current) await chmod(file, current.mode & 0o7777);
  return { version: version(data) };
}

/**
 * Folders, to choose a workspace in the in-app picker (when there is no native dialog, e.g. the
 * app in a browser). Only folder names are listed, never files; hidden folders are left out.
 */
export async function listFolders(at: string): Promise<{ path: string; parent: string | undefined; folders: string[] }> {
  if (!path.isAbsolute(at)) throw new AppError('invalid_params', 'use the full path of a folder');
  const dir = path.resolve(at);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('not_found', `no folder ${dir}`);
    if (code === 'EACCES' || code === 'EPERM') throw new AppError('invalid_params', `${dir} cannot be opened (no permission)`);
    throw err;
  }
  const folders = dirents
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && !HIDDEN.has(d.name))
    .map((d) => d.name)
    .sort(byName)
    .slice(0, MAX_ENTRIES);
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? undefined : parent, folders };
}
