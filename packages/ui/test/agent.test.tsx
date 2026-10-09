// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentStatusDTO, ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { RpcProvider } from '../src/hooks.tsx';
import { AgentBadge, AgentNotice, needsAction } from '../src/screens/AgentStatus.tsx';
import { Conversation } from '../src/screens/Conversation.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { FakeRpc } from './fake-rpc.ts';

const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } };
const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };
const status = (state: AgentStatusDTO['state'], extra: Partial<AgentStatusDTO> = {}): AgentStatusDTO => ({ agent: 'Claude Code', state, ...extra });

describe('agent status', () => {
  it('shows each state in the badge', () => {
    const { rerender } = render(<AgentBadge status={status('ready', { account: 'Claude Pro' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Claude Code · ready · Claude Pro');
    rerender(<AgentBadge status={status('login', { account: 'ignored' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Claude Code · not logged in');
    expect(screen.getByRole('status')).toHaveClass('state-login');
    rerender(<AgentBadge status={undefined} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    ['login', 'Your tutor needs you to log in'],
    ['missing', 'Your tutor could not be started'],
    ['stopped', 'Your tutor stopped'],
    ['error', 'Your tutor is having trouble'],
  ] as const)('explains %s and offers to check again', async (state, title) => {
    const user = userEvent.setup();
    const onCheck = vi.fn();
    render(<AgentNotice status={status(state, { message: 'Run `claude`, then `/login`.' })} onCheck={onCheck} />);
    expect(screen.getByRole('alert')).toHaveTextContent(title);
    expect(screen.getByText('claude')).toBeInTheDocument(); // rendered as code
    expect(screen.queryByText(/Install it, then check again/) !== null).toBe(state === 'missing');
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onCheck).toHaveBeenCalled();
  });

  it('says nothing while the tutor can work', () => {
    for (const s of ['unknown', 'starting', 'ready'] as const) expect(needsAction(status(s))).toBe(false);
    expect(needsAction(undefined)).toBe(false);
    render(<AgentNotice status={status('error')} onCheck={() => undefined} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('undefined');
  });

  it('checks the agent when a project opens, and follows what the server reports', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [])
      .handle('history.list', () => [])
      .handle('agent.status', () => status('unknown'))
      .handle('agent.check', () => status('login', { message: 'Log in first.' }));
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    expect((await screen.findAllByText('Your tutor needs you to log in')).length).toBeGreaterThan(0);
    expect(r.calls.filter((c) => c.method === 'agent.check')).toHaveLength(1);
    await user.click(screen.getAllByRole('button', { name: 'Check again' })[0]!);
    expect(r.calls.filter((c) => c.method === 'agent.check')).toHaveLength(2);
    act(() => r.emit('agent.status', status('ready')));
    await waitFor(() => expect(screen.queryByText('Your tutor needs you to log in')).toBeNull());
    expect(screen.getByText(/Claude Code · ready/)).toBeInTheDocument();
  });

  it('does not check again when the status is already known, and survives a failed call', async () => {
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [])
      .handle('history.list', () => [])
      .handle('agent.status', () => status('ready'));
    const { unmount } = render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    expect(await screen.findByText(/Claude Code · ready/)).toBeInTheDocument();
    expect(r.calls.some((c) => c.method === 'agent.check')).toBe(false);
    unmount();
    // No handler: the status call fails, and nothing is shown.
    const bare = new FakeRpc().handle('projects.list', () => [project]).handle('lessons.list', () => []).handle('history.list', () => []);
    render(
      <RpcProvider client={bare.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.queryByText(/Claude Code ·/)).toBeNull();
  });
});

describe('streaming', () => {
  it('gathers text chunks into one update per frame, keeping the order with other events', async () => {
    const r = new FakeRpc().handle('history.list', () => []).handle('ask', () => ({ askId: 'a1' }));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p" lessonId={undefined} request={{ question: 'Explain', nonce: 1 }} />
      </RpcProvider>,
    );
    await screen.findByText('Explain');
    act(() => {
      r.emit('ask.event', { askId: 'a1', event: { kind: 'text', text: 'Rotations ' } });
      r.emit('ask.event', { askId: 'a1', event: { kind: 'text', text: 'compose.' } });
    });
    expect(screen.queryByText('Rotations compose.')).toBeNull(); // not yet: waiting for the frame
    expect(await screen.findByText('Rotations compose.')).toBeInTheDocument();
    act(() => {
      r.emit('ask.event', { askId: 'a1', event: { kind: 'text', text: ' Then' } });
      r.emit('ask.done', { askId: 'a1', stopReason: 'end_turn' });
    });
    // The end of the turn applies the waiting text first.
    expect(screen.getByText('Rotations compose. Then')).toBeInTheDocument();
  });

  it('works without animation frames too', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    try {
      const r = new FakeRpc().handle('history.list', () => []).handle('ask', () => ({ askId: 'a1' }));
      const { unmount } = render(
        <RpcProvider client={r.asClient()}>
          <Conversation projectId="p" lessonId={undefined} request={{ question: 'Explain', nonce: 1 }} />
        </RpcProvider>,
      );
      await screen.findByText('Explain');
      act(() => r.emit('ask.event', { askId: 'a1', event: { kind: 'text', text: 'Later.' } }));
      expect(await screen.findByText('Later.')).toBeInTheDocument();
      act(() => r.emit('ask.event', { askId: 'a1', event: { kind: 'text', text: ' Lost' } }));
      unmount(); // the waiting chunk is dropped with the page (it is saved on the server)
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('a failed check', () => {
  it('leaves the status as it was', async () => {
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [])
      .handle('history.list', () => [])
      .handle('agent.status', () => status('unknown'))
      .handle('agent.check', () => {
        throw new Error('connection lost');
      });
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    expect(await screen.findByText(/Claude Code · not started/)).toBeInTheDocument();
    await waitFor(() => expect(r.calls.some((c) => c.method === 'agent.check')).toBe(true));
  });
});
