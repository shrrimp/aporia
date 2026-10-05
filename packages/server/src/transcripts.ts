import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from '@app/core';
import type { TranscriptEntry } from './protocol.ts';

export type Thread = 'chat' | 'session';

export type { TranscriptEntry };

/**
 * Conversations, one append-only JSON-lines file per project and thread, inside the profile:
 * projects/<id>/conversations/<thread>.jsonl. Writes to a file are serialized; a torn last
 * line (crash mid-write) is skipped on read.
 */
export class Transcripts {
  readonly #dir: string;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(profileDir: string) {
    this.#dir = profileDir;
  }

  #file(projectId: string, thread: Thread): string {
    return resolveInside(this.#dir, 'projects', projectId, 'conversations', `${thread}.jsonl`);
  }

  append(projectId: string, thread: Thread, entries: readonly TranscriptEntry[]): Promise<void> {
    const file = this.#file(projectId, thread);
    const prev = this.#queues.get(file) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    });
    this.#queues.set(file, next.catch(() => undefined));
    return next;
  }

  async read(projectId: string, thread: Thread): Promise<TranscriptEntry[]> {
    const file = this.#file(projectId, thread);
    await this.#queues.get(file);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: TranscriptEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as TranscriptEntry);
      } catch {
        // a torn line from a crash: skip it
      }
    }
    return out;
  }

  /** Wait for pending writes (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all(this.#queues.values());
  }
}

/**
 * A short reminder of an earlier conversation, for an agent session that starts fresh (after a
 * restart): the latest exchanges, oldest first, cut to fit `maxChars`.
 */
export function recap(entries: readonly TranscriptEntry[], maxChars = 6000): string | undefined {
  const turns: { question: string; answer: string }[] = [];
  const byId = new Map<string, { question: string; answer: string }>();
  for (const e of entries) {
    if (e.t === 'ask') {
      const turn = { question: e.answersTo ? `(answered the form "${e.answersTo}") ${e.question}` : e.question, answer: '' };
      byId.set(e.askId, turn);
      turns.push(turn);
    } else if (e.t === 'event' && e.event.kind === 'text') {
      const turn = byId.get(e.askId);
      if (turn) turn.answer += e.event.text;
    } else if (e.t === 'event' && e.event.kind === 'form') {
      const turn = byId.get(e.askId);
      if (turn) turn.answer += `\n[showed the form "${e.event.form.title}"]`;
    }
  }
  if (turns.length === 0) return undefined;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const parts: string[] = [];
  let used = 0;
  for (const t of [...turns].reverse()) {
    const part = `Learner: ${clip(t.question.trim(), 1200)}\nYou: ${clip(t.answer.trim() || '(no reply)', 1200)}`;
    if (used + part.length > maxChars && parts.length > 0) break;
    parts.unshift(part);
    used += part.length;
  }
  const skipped = turns.length - parts.length;
  return [
    '<earlier-conversation>',
    'You are a fresh session, but the learner already talked with their tutor here (before a restart, or about another lesson). This is what was said, and they can still see it:',
    skipped > 0 ? `(${skipped} earlier exchange${skipped === 1 ? '' : 's'} not shown)` : '',
    parts.join('\n\n'),
    '</earlier-conversation>',
  ]
    .filter(Boolean)
    .join('\n');
}
