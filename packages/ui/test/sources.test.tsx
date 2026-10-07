// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectDTO, SourceDTO } from '@app/server/protocol';
import { RpcProvider } from '../src/hooks.tsx';
import { CHUNK_BYTES, FileDrop, formatSize, uploadFile } from '../src/sources.tsx';
import { Conversation, withFiles } from '../src/screens/Conversation.tsx';
import { ProjectSettings } from '../src/screens/ProjectSettings.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { FakeRpc } from './fake-rpc.ts';

const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', workspace: '/w', createdAt: '2026-10-07T10:00:00.000Z' };

/** A fake app that assembles uploads like the real one. */
function uploads(r: FakeRpc = new FakeRpc()) {
  const open = new Map<string, { name: string; size: number; parts: string[] }>();
  const stored: SourceDTO[] = [];
  let n = 0;
  r.handle('sources.begin', ({ name, size }) => {
    const uploadId = `u${++n}`;
    open.set(uploadId, { name, size, parts: [] });
    return { uploadId };
  })
    .handle('sources.chunk', ({ uploadId, data }) => {
      open.get(uploadId)!.parts.push(atob(data));
      return { received: open.get(uploadId)!.parts.join('').length };
    })
    .handle('sources.finish', ({ uploadId }) => {
      const u = open.get(uploadId)!;
      const source: SourceDTO = { id: `src_${n}`, name: u.name, kind: 'text', size: u.parts.join('').length, chars: u.size, addedAt: '2026-10-07T10:00:00.000Z' };
      stored.push(source);
      return { ...source, existed: false };
    })
    .handle('sources.list', () => stored);
  return Object.assign(r, { stored, open });
}

const file = (name: string, content: string | Uint8Array<ArrayBuffer>) => new File([content], name);

describe('uploading', () => {
  it('sends a file in chunks and reports progress', async () => {
    const r = uploads();
    const big = new Uint8Array(CHUNK_BYTES + 10).fill(65);
    const progress: number[] = [];
    const s = await uploadFile(r.asClient(), 'p-1', file('big.txt', big), (n) => progress.push(n));
    expect(s).toMatchObject({ name: 'big.txt', size: big.length });
    expect(r.calls.filter((c) => c.method === 'sources.chunk')).toHaveLength(2);
    expect(progress).toEqual([CHUNK_BYTES, big.length]);
    await uploadFile(r.asClient(), 'p-1', file('empty.txt', ''));
    expect(r.calls.filter((c) => c.method === 'sources.chunk')).toHaveLength(3); // even an empty file sends one chunk
    const huge = { name: 'huge.bin', size: 60 * 1024 * 1024 } as File;
    await expect(uploadFile(r.asClient(), 'p-1', huge)).rejects.toThrow(/larger than 50 MB/);
    expect([formatSize(10), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(['10 B', '2 KB', '3.0 MB']);
  });

  it('takes dropped files, and only files', () => {
    const onFiles = vi.fn();
    const { container } = render(<FileDrop onFiles={onFiles}>zone</FileDrop>);
    const zone = container.querySelector('.file-drop')!;
    const f = file('notes.md', '# hi');
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files: [f] } });
    expect(zone).toHaveClass('over');
    expect(screen.getByText('Drop to add to this project')).toBeInTheDocument();
    fireEvent.dragLeave(zone, { relatedTarget: null });
    expect(zone).not.toHaveClass('over');
    fireEvent.dragOver(zone, { dataTransfer: { types: ['text/plain'] } });
    expect(zone).not.toHaveClass('over');
    fireEvent.drop(zone, { dataTransfer: { types: ['text/plain'], files: [] } });
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
  });
});

describe('files in the tutor chat', () => {
  it('adds files right away and tells the tutor with the next message', async () => {
    const user = userEvent.setup();
    const r = uploads(new FakeRpc().handle('history.list', () => []).handle('ask', () => ({ askId: 'a1' })));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p-1" lessonId={undefined} request={undefined} />
      </RpcProvider>,
    );
    await user.upload(screen.getByLabelText('Add files'), [file('lesson-03.html', '<h1>x</h1>'), file('notes.md', 'n')]);
    const chips = await screen.findByRole('list', { name: 'Added files' });
    await waitFor(() => expect(within(chips).getAllByText(/1 B|10 B/)).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Do not mention notes.md' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(r.calls.find((c) => c.method === 'ask')!.params).toMatchObject({
      question: 'I added a file to the project: "lesson-03.html" (src_1). Have a look.',
    });
    expect(screen.queryByRole('list', { name: 'Added files' })).toBeNull();
    act(() => r.emit('ask.done', { askId: 'a1', stopReason: 'end_turn' }));

    // A file that cannot be added says why, and is not mentioned.
    r.handle('sources.begin', () => {
      throw new RpcFailure({ code: 'invalid_params', message: 'too big' });
    });
    await user.upload(screen.getByLabelText('Add files'), file('x.bin', 'x'));
    expect(await screen.findByText(/too big/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    // Dropping on the conversation works too.
    const zone = document.querySelector('.conversation-drop')!;
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file('y.txt', 'y')] } });
    await act(async () => undefined);
    expect(withFiles('Look', [])).toBe('Look');
    expect(withFiles('Look at these', [{ key: 'k', name: 'a.pdf', state: 'done', source: { id: 'src_9' } as SourceDTO }, { key: 'l', name: 'b.md', state: 'done', source: { id: 'src_8' } as SourceDTO }])).toBe(
      'Look at these\n\nI added 2 files to the project: "a.pdf" (src_9), "b.md" (src_8).',
    );
  });

  it('waits for files still on their way before sending', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const r = uploads(new FakeRpc().handle('history.list', () => []).handle('ask', () => ({ askId: 'a1' })));
    r.handle('sources.chunk', () => new Promise((res) => (release = () => res({ received: 1 }))));
    render(
      <RpcProvider client={r.asClient()}>
        <Conversation projectId="p-1" lessonId={undefined} request={undefined} />
      </RpcProvider>,
    );
    await user.type(screen.getByLabelText('Your message'), 'hello');
    await user.upload(screen.getByLabelText('Add files'), file('slow.txt', 's'));
    expect(await screen.findByText(/adding…/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Your message'), { key: 'Enter', ctrlKey: true });
    expect(r.calls.some((c) => c.method === 'ask')).toBe(false);
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  });
});

describe('imported files in the project settings', () => {
  it('lists them, shows what the tutor reads, adds and removes', async () => {
    const user = userEvent.setup();
    const r = uploads();
    r.stored.push({ id: 'src_a', name: 'paper.pdf', kind: 'pdf', size: 2048, chars: 20, pages: 3, addedAt: '', note: 'a note' });
    r.handle('sources.text', ({ sourceId }) => (sourceId === 'src_a' ? { text: '[page 1]\nIntro', truncated: true } : { text: '', truncated: false }))
      .handle('sources.remove', () => {
        throw new RpcFailure({ code: 'not_found', message: 'gone already' });
      })
      .handle('projects.update', (p) => ({ ...project, ...p }));
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectSettings project={{ ...project, workspace: undefined as never }} />
      </RpcProvider>,
    );
    const imported = await screen.findByRole('region', { name: 'Imported files' });
    expect(await within(imported).findByText(/pdf, 3 pages, 2 KB · a note/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /What your tutor may do/ })).toBeNull(); // no workspace: nothing to allow
    await user.click(within(imported).getByRole('button', { name: 'paper.pdf' }));
    const preview = screen.getByRole('region', { name: 'Text of paper.pdf' });
    expect(preview).toHaveTextContent('(the beginning of it)');
    expect(preview).toHaveTextContent('[page 1] Intro');
    await user.click(within(preview).getByRole('button', { name: 'close' }));
    await user.click(within(imported).getByRole('button', { name: 'Remove paper.pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('gone already');
    // The button opens the system's picker (the hidden input); dropping works too.
    const picker = within(imported).getByLabelText('Add files') as HTMLInputElement;
    const click = vi.spyOn(picker, 'click');
    await user.click(within(imported).getByRole('button', { name: 'Add files' }));
    expect(click).toHaveBeenCalled();
    fireEvent.drop(imported.querySelector('.file-drop')!, { dataTransfer: { types: ['Files'], files: [file('dropped.md', 'd')] } });
    await waitFor(() => expect(r.stored.map((x) => x.name)).toContain('dropped.md'));
    await user.upload(picker, file('more.md', 'm'));
    await waitFor(() => expect(r.stored).toHaveLength(3));
    r.handle('sources.text', () => {
      throw new RpcFailure({ code: 'not_found', message: 'no source' });
    });
    await user.click(within(imported).getByRole('button', { name: 'paper.pdf' }));
    expect(await screen.findByText('no source')).toBeInTheDocument();
  });

  it('says when there are none, and the workspace can be typed', async () => {
    const user = userEvent.setup();
    render(
      <RpcProvider client={uploads().asClient()}>
        <ProjectSettings project={project} />
      </RpcProvider>,
    );
    expect(await screen.findByText(/None yet\. Drop files here/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Workspace folder'));
    expect(screen.queryByRole('group', { name: /What your tutor may do/ })).toBeNull();
    await user.type(screen.getByLabelText('Workspace folder'), '/other');
    expect(screen.getByRole('group', { name: /What your tutor may do/ })).toBeInTheDocument();
  });

  it('shows a file without text', async () => {
    const user = userEvent.setup();
    const r = uploads().handle('sources.text', () => ({ text: '', truncated: false }));
    r.stored.push({ id: 'src_b', name: 'photo.png', kind: 'image', size: 10, chars: 0, addedAt: '' });
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectSettings project={project} />
      </RpcProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'photo.png' }));
    expect(screen.getByText('(no text)')).toBeInTheDocument();
  });
});

