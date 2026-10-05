/** Serialises async critical sections inside one process (the core is the single writer). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
