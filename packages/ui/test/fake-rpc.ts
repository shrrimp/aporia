import type { Method, ServerEvents } from '@app/server/protocol';
import { RpcFailure, type RpcClient, type Status } from '../src/rpc.ts';

type Handler = (params: any) => unknown;

/** In-memory stand-in for RpcClient: scripted handlers + manual event emission. */
export class FakeRpc {
  status: Status = 'open';
  readonly calls: { method: string; params: unknown }[] = [];
  readonly #handlers = new Map<string, Handler>();
  readonly #listeners = new Map<string, Set<(d: unknown) => void>>();
  readonly #status = new Set<(s: Status) => void>();

  constructor() {
    // Nothing saved yet, unless a test says otherwise.
    this.handle('progress.get', () => ({}))
      .handle('progress.set', () => ({ saved: true }))
      .handle('conversations.get', () => []);
  }

  handle(method: Method, h: Handler): this {
    this.#handlers.set(method, h);
    return this;
  }

  async call(method: string, params: unknown = {}): Promise<unknown> {
    this.calls.push({ method, params });
    const h = this.#handlers.get(method);
    if (!h) throw new RpcFailure({ code: 'unknown_method', message: method });
    return h(params);
  }

  on(event: string, l: (d: unknown) => void): () => void {
    let s = this.#listeners.get(event);
    if (!s) this.#listeners.set(event, (s = new Set()));
    s.add(l);
    return () => void s.delete(l);
  }

  emit<E extends keyof ServerEvents>(event: E, data: ServerEvents[E]): void {
    this.#listeners.get(event)?.forEach((l) => l(data));
  }

  onStatus(l: (s: Status) => void): () => void {
    this.#status.add(l);
    return () => void this.#status.delete(l);
  }

  setStatus(s: Status): void {
    this.status = s;
    this.#status.forEach((l) => l(s));
  }

  asClient(): RpcClient {
    return this as unknown as RpcClient;
  }
}
