import { createContext, useContext } from 'react';

export interface LessonActions {
  recordAnswer(a: {
    itemId: string;
    kcs: readonly string[];
    difficulty: number;
    evidenceType: 'production' | 'prediction' | 'recognition';
    outcome: number;
    confidence?: 'sure' | 'think' | 'guess';
    transfer: boolean;
  }): void;
  ask(question: string, opts?: { selection?: string; anchor?: string }): void;
}

const noop: LessonActions = { recordAnswer: () => undefined, ask: () => undefined };
export const LessonActionsContext = createContext<LessonActions>(noop);
export const useLessonActions = () => useContext(LessonActionsContext);
