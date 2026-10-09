import { createContext, useContext } from 'react';
import type { AskShown } from '@app/server/protocol';

export interface LessonActions {
  recordAnswer(a: {
    itemId: string;
    reviewOf?: string;
    kcs: readonly string[];
    difficulty: number;
    evidenceType: 'production' | 'prediction' | 'recognition';
    outcome: number;
    confidence?: 'sure' | 'think' | 'guess';
    transfer: boolean;
  }): void;
  /** Ask the tutor in the margin; `shown` is the card the learner sees when the app wrote the question. */
  ask(question: string, opts?: { selection?: string; anchor?: string; shown?: AskShown }): void;
  /** Open one of the learner's files in the embedded editor (only when the project has a workspace). */
  openFile?(path: string): void;
}

const noop: LessonActions = { recordAnswer: () => undefined, ask: () => undefined };
export const LessonActionsContext = createContext<LessonActions>(noop);
export const useLessonActions = () => useContext(LessonActionsContext);
