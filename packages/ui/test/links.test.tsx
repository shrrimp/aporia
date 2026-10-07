// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileDTO, ProjectDTO, TranscriptEntry } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { LessonLinkContext, Markdown } from '../src/lesson/Markdown.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { RpcProvider } from '../src/hooks.tsx';
import { FakeRpc } from './fake-rpc.ts';

describe('links in lesson and tutor text', () => {
  it('open a place in the lesson, or another page outside the app', async () => {
    const user = userEvent.setup();
    const go = vi.fn();
    render(
      <LessonLinkContext.Provider value={go}>
        <Markdown md="[Try it](#lesson:l1/side/2), [the lesson](#lesson:l1) or [the docs](https://example.org)." />
      </LessonLinkContext.Provider>,
    );
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    expect(go).toHaveBeenLastCalledWith('l1', 'side/2');
    await user.click(screen.getByRole('button', { name: 'the lesson' }));
    expect(go).toHaveBeenLastCalledWith('l1', undefined);
    expect(screen.getByRole('link', { name: 'the docs' })).toHaveAttribute('target', '_blank');
  });

  it('are plain text where no lesson can be shown', () => {
    render(<Markdown md="[Try it](#lesson:l1/side/2)" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Try it')).toBeInTheDocument();
  });
});

describe('the tutor sending the learner back to the lesson', () => {
  const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false } };
  const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };
  const chat: TranscriptEntry[] = [
    { t: 'ask', askId: 'a1', at: '', question: 'Judge my answer', lessonId: fourNumbers.id },
    {
      t: 'event',
      askId: 'a1',
      event: { kind: 'text', text: `Right. I added two more items: [try them](#lesson:${fourNumbers.id}/side/1). Then [the next lesson](#lesson:not-accepted-yet).` },
    },
    { t: 'end', askId: 'a1', state: 'done' },
  ];

  it('opens the lesson at the linked place, and History for a lesson still waiting for review', async () => {
    const user = userEvent.setup();
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
      .handle('lessons.get', () => fourNumbers)
      .handle('history.list', () => [])
      .handle('conversations.get', (p: { thread: string }) => (p.thread === 'chat' ? chat : []));
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: fourNumbers.title });
    // On another page, with the chat open beside it.
    await user.click(screen.getByRole('button', { name: /Sessions|Interview/ }));
    await user.click(screen.getByRole('button', { name: 'Tutor' }));
    await user.click(await screen.findByRole('button', { name: 'try them' }));
    await waitFor(() => expect(document.querySelector('[data-anchor="side/1"]')).toHaveClass('jumped'));
    expect(screen.getByRole('heading', { level: 1, name: fourNumbers.title })).toBeVisible();
    // The highlight is only for a moment.
    await waitFor(() => expect(document.querySelector('[data-anchor="side/1"]')).not.toHaveClass('jumped'), { timeout: 3000 });

    await user.click(screen.getByRole('button', { name: 'the next lesson' }));
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
  });
});
