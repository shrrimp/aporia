import type { Author, EvidenceEvent, InsightObservation, InstructionEvent, LogEvent } from './schemas.ts';
import type { z } from 'zod';
import type { evidenceEvent, insightObservation, instructionEvent } from './schemas.ts';
import { matchesFilter, type HistoryFilter, type Journal } from './journal.ts';

export type Observation = EvidenceEvent | InstructionEvent | InsightObservation;

type In<T extends z.ZodType> = Omit<z.input<T>, 'id' | 'at' | 'type'>;

const OBSERVATION_TYPES = new Set(['evidence', 'instruction', 'insight']);

export function isObservation(e: LogEvent): e is Observation {
  return OBSERVATION_TYPES.has(e.type);
}

/** Observations minus revoked ones; revoke/restore events are applied in log order. */
export function activeObservations(events: readonly LogEvent[]): Observation[] {
  const revoked = new Set<string>();
  for (const e of events) {
    if (e.type === 'revoke') e.targets.forEach((t) => revoked.add(t));
    else if (e.type === 'restore') e.targets.forEach((t) => revoked.delete(t));
  }
  return events.filter((e): e is Observation => isObservation(e) && !revoked.has(e.id));
}

export class UnknownEventError extends Error {
  override readonly name = 'UnknownEventError';
}

/** Recording and undoing what the system observed about the learner. */
export class Observations {
  readonly journal: Journal;
  constructor(journal: Journal) {
    this.journal = journal;
  }

  recordEvidence(input: In<typeof evidenceEvent>): Promise<EvidenceEvent> {
    return this.#record({ ...input, type: 'evidence' }) as Promise<EvidenceEvent>;
  }

  recordInstruction(input: In<typeof instructionEvent>): Promise<InstructionEvent> {
    return this.#record({ ...input, type: 'instruction' }) as Promise<InstructionEvent>;
  }

  recordInsight(input: In<typeof insightObservation>): Promise<InsightObservation> {
    return this.#record({ ...input, type: 'insight' }) as Promise<InsightObservation>;
  }

  revoke(targets: string[], author: Author, reason?: string): Promise<void> {
    return this.#toggle('revoke', targets, author, reason);
  }

  restore(targets: string[], author: Author, reason?: string): Promise<void> {
    return this.#toggle('restore', targets, author, reason);
  }

  /** Bulk undo, e.g. everything one model observed during one session. Returns revoked ids. */
  async revokeWhere(filter: HistoryFilter, author: Author, reason?: string): Promise<string[]> {
    const ids = activeObservations(this.journal.events)
      .filter((e) => matchesFilter(e, filter))
      .map((e) => e.id);
    if (ids.length > 0) await this.revoke(ids, author, reason);
    return ids;
  }

  #record(input: Parameters<Journal['append']>[0]): Promise<LogEvent> {
    return this.journal.exclusive(() => this.journal.append(input));
  }

  #toggle(type: 'revoke' | 'restore', targets: string[], author: Author, reason?: string): Promise<void> {
    return this.journal.exclusive(async () => {
      const known = new Set(this.journal.events.filter(isObservation).map((e) => e.id));
      const missing = targets.filter((t) => !known.has(t));
      if (missing.length > 0) throw new UnknownEventError(`not an observation: ${missing.join(', ')}`);
      await this.journal.append({ type, targets, author, ...(reason === undefined ? {} : { reason }) });
    });
  }
}
