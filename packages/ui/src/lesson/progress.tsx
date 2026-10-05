import { createContext, useContext } from 'react';
import type { JsonValue } from '@app/server/protocol';

/**
 * What the learner already did in this lesson, and how to save more. Blocks read their saved
 * value once, when they mount (the lesson is only shown once progress has loaded), and save at
 * the moments that matter: checking, revealing, sending, marking done. Never per keystroke.
 */
export interface LessonProgress {
  readonly saved: Readonly<Record<string, JsonValue>>;
  save(key: string, value: JsonValue): void;
}

export const ProgressContext = createContext<LessonProgress>({ saved: {}, save: () => undefined });

/** Where a block sits in the lesson ("section-id/3"), for blocks whose key is their place. */
export const AnchorContext = createContext('');

/** The saved value under `key` (if any), and a function to replace it. */
export function useSaved<T extends JsonValue>(key: string): [T | undefined, (value: T | null) => void] {
  const { saved, save } = useContext(ProgressContext);
  const value = saved[key];
  return [value === null ? undefined : (value as T | undefined), (v) => save(key, v)];
}

export const useAnchor = () => useContext(AnchorContext);
