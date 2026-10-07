import { useCallback, useEffect, useState } from 'react';
import type { AgentStatusDTO } from '@app/server/protocol';
import { useEvent, useRpc } from '../hooks.tsx';
import { Markdown } from '../lesson/Markdown.tsx';

const LABEL: Record<AgentStatusDTO['state'], string> = {
  unknown: 'not started',
  starting: 'starting…',
  ready: 'ready',
  login: 'not logged in',
  missing: 'not found',
  stopped: 'stopped',
  error: 'having trouble',
};

/** The tutor cannot work in these states; the learner needs to do something. */
export const needsAction = (s: AgentStatusDTO | undefined) => s !== undefined && (s.state === 'login' || s.state === 'missing' || s.state === 'stopped' || s.state === 'error');

/**
 * The learner's own agent: is it installed, running and logged in? Checked once when a project
 * opens (starting the agent early also makes the first answer faster), then kept up to date by
 * the server.
 */
export function useAgentStatus(): { status: AgentStatusDTO | undefined; check: () => void } {
  const rpc = useRpc();
  const [status, setStatus] = useState<AgentStatusDTO>();
  const check = useCallback(() => {
    void rpc.call('agent.check', {}).then(setStatus, () => undefined);
  }, [rpc]);
  useEffect(() => {
    let live = true;
    rpc.call('agent.status', {}).then(
      (s) => {
        if (!live) return;
        setStatus(s);
        if (s.state === 'unknown') check();
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, check]);
  useEvent('agent.status', setStatus);
  return { status, check };
}

export function AgentBadge({ status }: { status: AgentStatusDTO | undefined }) {
  if (!status) return null;
  return (
    <span className={`agent-badge state-${status.state}`} role="status" title={status.message}>
      <span className="dot" aria-hidden />
      {status.agent} · {LABEL[status.state]}
      {status.account && status.state === 'ready' ? ` · ${status.account}` : ''}
    </span>
  );
}

/** What to do when the tutor cannot work. The app never logs in for the learner (architecture §1). */
export function AgentNotice({ status, onCheck }: { status: AgentStatusDTO | undefined; onCheck: () => void }) {
  if (!needsAction(status)) return null;
  const title = { login: 'Your tutor needs you to log in', missing: 'Your tutor could not be started', stopped: 'Your tutor stopped', error: 'Your tutor is having trouble' }[
    status!.state as 'login' | 'missing' | 'stopped' | 'error'
  ];
  return (
    <aside className="agent-notice" role="alert">
      <p className="agent-notice-title">{title}</p>
      {status!.message && <Markdown md={status!.message} />}
      {status!.state === 'missing' && (
        <p className="quiet">The tutor is {status!.agent}, running on your own account. Install it, then check again.</p>
      )}
      <button type="button" onClick={onCheck}>
        Check again
      </button>
    </aside>
  );
}
