// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { RpcProvider } from '../src/hooks.tsx';
import { Editor, setCodeView, type CodeViewProps } from '../src/editor/Editor.tsx';
import { ProjectView } from '../src/screens/ProjectView.tsx';
import { RpcFailure } from '../src/rpc.ts';
import { FakeRpc } from './fake-rpc.ts';

function TextView({ path, value, onChange, onSave, readOnly }: CodeViewProps) {
  // A controlled textarea: it always shows the parent's copy, which is enough for these tests.
  return (
    <textarea
      className="code-fallback"
      aria-label={`Editing ${path}`}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 's' && e.ctrlKey) {
          e.preventDefault();
          onSave(e.currentTarget.value);
        }
      }}
    />
  );
}

beforeAll(() => setCodeView(TextView));

const files: Record<string, string> = { 'README.md': '# Engine\n', 'src/Joint.cpp': 'void f() {}\n' };

function rpc() {
  const disk = { ...files };
  const versions: Record<string, number> = {};
  const r = new FakeRpc()
    .handle('workspace.list', ({ dir }) =>
      dir === '' ? [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }] : [{ name: 'Joint.cpp', kind: 'file' }],
    )
    .handle('workspace.read', ({ path }) => {
      if (!(path in disk)) throw new RpcFailure({ code: 'not_found', message: `no file "${path}" in the workspace` });
      return { content: disk[path], version: `v${versions[path] ?? 0}` };
    })
    .handle('workspace.write', ({ path, content, baseVersion }) => {
      const now = `v${versions[path] ?? 0}`;
      if (baseVersion !== now) throw new RpcFailure({ code: 'conflict', message: `"${path}" changed on disk since you opened it`, data: { version: now } });
      disk[path] = content;
      versions[path] = (versions[path] ?? 0) + 1;
      return { version: `v${versions[path]}` };
    });
  const drafts = new Map<string, { path: string; content: string; baseVersion?: string; at: string }>();
  r.handle('drafts.list', () => [...drafts.values()]).handle('drafts.set', ({ path, content, baseVersion }) => {
    if (content === null) drafts.delete(path);
    else drafts.set(path, { path, content, ...(baseVersion ? { baseVersion } : {}), at: '' });
    return { saved: true };
  });
  return Object.assign(r, {
    disk,
    drafts,
    touch: (path: string, content: string) => {
      disk[path] = content;
      versions[path] = (versions[path] ?? 0) + 1;
    },
  });
}

function Harness({ r }: { r: FakeRpc }) {
  return (
    <RpcProvider client={r.asClient()}>
      <Wrapper />
    </RpcProvider>
  );
}

import { useState } from 'react';
function Wrapper() {
  const [open, setOpen] = useState<string>();
  return <Editor projectId="p-1" open={open} onOpen={setOpen} />;
}

describe('Editor', () => {
  it('browses the workspace, opens files, keeps unsaved edits per file, and saves', async () => {
    const user = userEvent.setup();
    const r = rpc();
    render(<Harness r={r} />);
    expect(screen.getByText(/Open a file from the list/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    const area = await screen.findByLabelText('Editing README.md');
    expect(area).toHaveValue('# Engine\n');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(area, 'More.');
    expect(screen.getByText('unsaved')).toBeInTheDocument();
    expect(screen.getByLabelText('unsaved')).toBeInTheDocument();

    // Into a folder and back; the unsaved README is still there.
    await user.click(screen.getByRole('button', { name: 'src/' }));
    await user.click(await screen.findByRole('button', { name: 'Joint.cpp' }));
    expect(await screen.findByLabelText('Editing src/Joint.cpp')).toHaveValue('void f() {}\n');
    await user.click(screen.getByRole('button', { name: '← up' }));
    await user.click(await screen.findByRole('button', { name: /README\.md/ }));
    expect(screen.getByLabelText('Editing README.md')).toHaveValue('# Engine\nMore.');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(r.disk['README.md']).toBe('# Engine\nMore.'));
    expect(screen.queryByText('unsaved')).toBeNull();
    // Ctrl+S from the code view saves too, with the view's own text (even a keystroke React has not rendered yet).
    await user.type(screen.getByLabelText('Editing README.md'), '!');
    const area2 = screen.getByLabelText('Editing README.md') as HTMLTextAreaElement;
    area2.value = '# Engine\nMore.!?'; // typed, not rendered yet
    fireEvent.keyDown(area2, { key: 's', ctrlKey: true });
    await waitFor(() => expect(r.disk['README.md']).toBe('# Engine\nMore.!?'));
    expect(screen.queryByText('unsaved')).toBeNull();
  });

  it('never overwrites a change made elsewhere without asking', async () => {
    const user = userEvent.setup();
    const r = rpc();
    render(<Harness r={r} />);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    await user.type(await screen.findByLabelText('Editing README.md'), 'Mine.');
    r.touch('README.md', '# Changed in vim\n');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('changed on disk since you opened it');
    expect(r.disk['README.md']).toBe('# Changed in vim\n');

    await user.click(within(alert).getByRole('button', { name: 'Keep mine (overwrite)' }));
    await waitFor(() => expect(r.disk['README.md']).toBe('# Engine\nMine.'));
    expect(screen.queryByRole('alert')).toBeNull();

    // Or take the disk's version instead.
    r.touch('README.md', '# Theirs\n');
    await user.type(screen.getByLabelText('Editing README.md'), '?');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Reload from disk' }));
    await waitFor(() => expect(screen.getByLabelText('Editing README.md')).toHaveValue('# Theirs\n'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('recreates a file deleted elsewhere on purpose, and reports other errors', async () => {
    const user = userEvent.setup();
    const r = rpc();
    r.handle('workspace.write', () => {
      throw new RpcFailure({ code: 'conflict', message: '"README.md" was deleted on disk', data: { version: null } });
    });
    render(<Harness r={r} />);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    await user.type(await screen.findByLabelText('Editing README.md'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    let sent: unknown;
    r.handle('workspace.write', (p) => {
      sent = p;
      return { version: 'v9' };
    });
    await user.click(await screen.findByRole('button', { name: 'Keep mine (overwrite)' }));
    await waitFor(() => expect(sent).toEqual({ projectId: 'p-1', path: 'README.md', content: '# Engine\nx' }));

    r.handle('workspace.write', () => {
      throw new RpcFailure({ code: 'invalid_params', message: 'too large' });
    });
    await user.type(screen.getByLabelText('Editing README.md'), 'y');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('too large');
  });

  it('says why a file or folder cannot be shown', async () => {
    const r = rpc().handle('workspace.list', () => {
      throw new RpcFailure({ code: 'conflict', message: 'This project has no workspace folder.' });
    });
    render(
      <RpcProvider client={r.asClient()}>
        <Editor projectId="p-1" open="missing.cpp" onOpen={() => undefined} />
      </RpcProvider>,
    );
    expect(await screen.findByText('This project has no workspace folder.')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('no file "missing.cpp" in the workspace');
  });
});

describe('unsaved edits across restarts', () => {
  it('are kept as a draft while typing, and forgotten once saved', async () => {
    const user = userEvent.setup();
    const r = rpc();
    render(<Harness r={r} />);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    await user.type(await screen.findByLabelText('Editing README.md'), 'Draft.');
    await waitFor(() => expect(r.drafts.get('README.md')).toEqual({ path: 'README.md', content: '# Engine\nDraft.', baseVersion: 'v0', at: '' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(r.drafts.has('README.md')).toBe(false));
    // Typing back to what is on disk forgets the draft too.
    await user.type(screen.getByLabelText('Editing README.md'), '!');
    await waitFor(() => expect(r.drafts.has('README.md')).toBe(true));
    await user.type(screen.getByLabelText('Editing README.md'), '{Backspace}');
    await waitFor(() => expect(r.drafts.has('README.md')).toBe(false));
  });

  it('are written at once when the editor closes', async () => {
    const user = userEvent.setup();
    const r = rpc();
    const view = render(<Harness r={r} />);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    await user.type(await screen.findByLabelText('Editing README.md'), 'x');
    view.unmount();
    expect(r.drafts.get('README.md')?.content).toBe('# Engine\nx');
  });

  it('come back when the file is opened again, and saving asks first if the file changed meanwhile', async () => {
    const user = userEvent.setup();
    const r = rpc();
    r.drafts.set('README.md', { path: 'README.md', content: '# Engine\nKept.', baseVersion: 'v0', at: '' });
    r.drafts.set('src/Joint.cpp', { path: 'src/Joint.cpp', content: 'void f() {}\n', baseVersion: 'v0', at: '' });
    render(<Harness r={r} />);
    // Marked in the list before it is opened.
    expect(await screen.findByLabelText('unsaved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /README\.md/ }));
    expect(await screen.findByLabelText('Editing README.md')).toHaveValue('# Engine\nKept.');
    expect(screen.getByText('unsaved (kept from your last session)')).toBeInTheDocument();

    // A draft identical to the disk is just forgotten.
    await user.click(screen.getByRole('button', { name: 'src/' }));
    await user.click(await screen.findByRole('button', { name: /^Joint\.cpp/ }));
    await screen.findByLabelText('Editing src/Joint.cpp');
    await waitFor(() => expect(r.drafts.has('src/Joint.cpp')).toBe(false));
    await user.click(screen.getByRole('button', { name: '← up' }));
    await user.click(await screen.findByRole('button', { name: /README\.md/ }));

    // Changed in another editor since the draft was made: nothing is overwritten without asking.
    r.touch('README.md', '# Edited in vim\n');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Reload from disk' }));
    await waitFor(() => expect(screen.getByLabelText('Editing README.md')).toHaveValue('# Edited in vim\n'));
    expect(r.drafts.has('README.md')).toBe(false);
    expect(r.disk['README.md']).toBe('# Edited in vim\n');
  });

  it('are optional: the editor works when they cannot be read', async () => {
    const user = userEvent.setup();
    const r = rpc()
      .handle('drafts.list', () => {
        throw new RpcFailure({ code: 'internal', message: 'disk' });
      })
      .handle('drafts.set', () => {
        throw new RpcFailure({ code: 'internal', message: 'disk full' });
      });
    const view = render(<Harness r={r} />);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    expect(await screen.findByLabelText('Editing README.md')).toHaveValue('# Engine\n');
    await user.type(screen.getByLabelText('Editing README.md'), 'still typing');
    view.unmount();
    await waitFor(() => expect(r.calls.some((c) => c.method === 'drafts.set')).toBe(true));
  });
});

describe('the editor in a project', () => {
  it('opens next to the lesson, and task files open in it', async () => {
    const user = userEvent.setup();
    const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } };
    const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', workspace: '/w', createdAt: '2026-10-05T10:00:00.000Z' };
    const r = rpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
      .handle('lessons.get', () => fourNumbers)
      .handle('history.list', () => []);
    r.disk['physics/joints/Joint.cpp'] = '// joints\n';
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: fourNumbers.title });
    await user.click(screen.getByRole('button', { name: 'physics/joints/Joint.cpp' }));
    expect(await screen.findByLabelText('Editing physics/joints/Joint.cpp')).toHaveValue('// joints\n');
    expect(screen.getByRole('button', { name: 'Editor' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Editor' }));
    expect(screen.queryByRole('region', { name: 'Editor' })).toBeNull();
    act(() => undefined);
  });

  it('shows file names as text where there is no workspace', async () => {
    const profile: ProfileDTO = { id: 'prof_1', displayName: 'J', createdAt: '2026-10-05T10:00:00.000Z', settings: { changeMode: 'review', sessionMode: 'lesson', encrypted: false, reviewQuestions: 'pool' } };
    const project: ProjectDTO = { id: 'p-1', title: 'P', goal: 'g', why: '', createdAt: '2026-10-05T10:00:00.000Z' };
    const r = new FakeRpc()
      .handle('projects.list', () => [project])
      .handle('lessons.list', () => [{ id: fourNumbers.id, title: fourNumbers.title, kind: 'build', estimateMin: 120, progress: { done: 0, total: 9 } }])
      .handle('lessons.get', () => fourNumbers)
      .handle('history.list', () => []);
    render(
      <RpcProvider client={r.asClient()}>
        <ProjectView project={project} profile={profile} onProfile={() => undefined} onBack={() => undefined} />
      </RpcProvider>,
    );
    expect(await screen.findByText('physics/joints/Joint.cpp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'physics/joints/Joint.cpp' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editor' })).toBeNull();
  });
});
