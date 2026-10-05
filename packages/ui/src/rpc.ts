import type { Method, Params, Results, RpcError, ServerEvents, ServerMessage } from '@app/server/protocol';

export class RpcFailure extends Error {
  readonly code: RpcError['code'];
  readonly data: unknown;
  constructor(e: RpcError) {
    super(e.message);
    this.code = e.code;
    this.data = e.data;
  }
}

type Listener<E extends keyof ServerEvents> = (data: ServerEvents[E]) => void;
export type Status = 'connecting' | 'open' | 'closed';

/** Minimal socket interface so tests can inject a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** Talks to the app service. Reconnects with backoff; calls made while offline wait. */
export class RpcClient {
  readonly #url: string;
  readonly #factory: SocketFactory;
  #ws: SocketLike | undefined;
  #next = 1;
  #retry = 0;
  #closed = false;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  readonly #queue: string[] = [];
  readonly #listeners = new Map<string, Set<(d: unknown) => void>>();
  readonly #statusListeners = new Set<(s: Status) => void>();
  status: Status = 'connecting';

  constructor(url: string, factory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike) {
    this.#url = url;
    this.#factory = factory;
    this.#connect();
  }

  #setStatus(s: Status): void {
    this.status = s;
    this.#statusListeners.forEach((l) => l(s));
  }

  #connect(): void {
    const ws = this.#factory(this.#url);
    this.#ws = ws;
    this.#setStatus('connecting');
    ws.onopen = () => {
      this.#retry = 0;
      this.#setStatus('open');
      for (const m of this.#queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if ('event' in m) {
        this.#listeners.get(m.event)?.forEach((l) => l(m.data));
        return;
      }
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if ('error' in m) p.reject(new RpcFailure(m.error));
      else p.resolve(m.result);
    };
    ws.onclose = () => {
      this.#setStatus('closed');
      for (const p of this.#pending.values()) p.reject(new RpcFailure({ code: 'internal', message: 'connection lost' }));
      this.#pending.clear();
      if (this.#closed) return;
      const delay = Math.min(10_000, 250 * 2 ** this.#retry++);
      setTimeout(() => this.#connect(), delay);
    };
  }

  call<M extends Method>(method: M, ...[params]: Params<M> extends Record<string, never> ? [Params<M>?] : [Params<M>]): Promise<Results[M]> {
    const id = this.#next++;
    const msg = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (this.#ws?.readyState === 1) this.#ws.send(msg);
      else this.#queue.push(msg);
    });
  }

  on<E extends keyof ServerEvents>(event: E, listener: Listener<E>): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as (d: unknown) => void);
    return () => void set.delete(listener as (d: unknown) => void);
  }

  onStatus(l: (s: Status) => void): () => void {
    this.#statusListeners.add(l);
    return () => void this.#statusListeners.delete(l);
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
  }
}

/** Where to connect: Electron preload global, or `#token=` in the URL (headless mode). */
export function connectionFromLocation(loc: Location, injected?: { url: string; token: string }): string | undefined {
  if (injected) return `${injected.url.replace(/^http/, 'ws')}/rpc?token=${encodeURIComponent(injected.token)}`;
  const token = new URLSearchParams(loc.hash.slice(1)).get('token');
  if (!token) return undefined;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/rpc?token=${encodeURIComponent(token)}`;
}
