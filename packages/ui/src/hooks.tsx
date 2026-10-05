import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Method, Params, Results, ServerEvents } from '@app/server/protocol';
import type { RpcClient, Status } from './rpc.ts';

const RpcContext = createContext<RpcClient | null>(null);

export function RpcProvider({ client, children }: { client: RpcClient; children: ReactNode }) {
  return <RpcContext.Provider value={client}>{children}</RpcContext.Provider>;
}

export function useRpc(): RpcClient {
  const c = useContext(RpcContext);
  if (!c) throw new Error('useRpc outside RpcProvider');
  return c;
}

export function useStatus(): Status {
  const rpc = useRpc();
  const [s, setS] = useState(rpc.status);
  useEffect(() => {
    setS(rpc.status); // it may have changed before we subscribed
    return rpc.onStatus(setS);
  }, [rpc]);
  return s;
}

export function useEvent<E extends keyof ServerEvents>(event: E, handler: (d: ServerEvents[E]) => void): void {
  const rpc = useRpc();
  useEffect(() => rpc.on(event, handler), [rpc, event, handler]);
}

export interface Query<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  reload(): void;
}

/** Call a method and refresh whenever the server reports a change of one of `refreshOn`. */
export function useQuery<M extends Method>(
  method: M,
  params: Params<M> | null,
  refreshOn: readonly ServerEvents['changed']['what'][] = [],
): Query<Results[M]> {
  const rpc = useRpc();
  const key = params === null ? null : JSON.stringify(params);
  const [state, setState] = useState<{ data?: Results[M]; error?: Error; loading: boolean }>({ loading: key !== null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    (rpc.call as (m: M, p: unknown) => Promise<Results[M]>)(method, JSON.parse(key)).then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [rpc, method, key, tick]);
  const refresh = useCallback((d: ServerEvents['changed']) => {
    if (refreshOn.includes(d.what)) reload();
    // refreshOn is a constant list at each call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, refreshOn.join()]);
  useEvent('changed', refresh);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
