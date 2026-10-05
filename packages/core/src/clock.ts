export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests and simulations. */
export class ManualClock implements Clock {
  #ms: number;
  constructor(start: Date | string) {
    this.#ms = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
}

export const DAY_MS = 86_400_000;
