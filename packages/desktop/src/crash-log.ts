import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/** Kept small: the last few crashes are what matter, not a history. */
const MAX_BYTES = 1024 * 1024;

/**
 * The app's own log, `logs/app.log` in the data folder: page errors, crashed or hung processes,
 * and what the app did about them. A blank window must leave a trace somewhere the learner (and
 * we) can read; the terminal is not always there. Written synchronously, so a line logged just
 * before a crash is on disk. One older file is kept (`app.log.1`).
 */
export function crashLog(dataRoot: string): (message: string) => void {
  const dir = path.join(dataRoot, 'logs');
  const file = path.join(dir, 'app.log');
  return (message) => {
    try {
      mkdirSync(dir, { recursive: true });
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${new Date().toISOString()} ${message.replace(/\n/g, '\n    ')}\n`, 'utf8');
    } catch {
      // Logging must never be what breaks the app.
    }
    console.error(message);
  };
}
