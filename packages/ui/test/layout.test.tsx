// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Layout } from '@app/server/protocol';
import { fit, RAIL, resized, useLingering, Workspace } from '../src/screens/Workspace.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const all = { margin: true, editor: true };

describe('fitting the panels to the window', () => {
  it('gives the learner their widths when there is room', () => {
    expect(fit({ contents: 260, margin: 400, editor: 500 }, all, 2000)).toMatchObject({ contents: 260, margin: 400, editor: 500, folded: false, overlay: false });
    // Not laid out yet: the widths as they are.
    expect(fit({ margin: 400 }, all, undefined)).toMatchObject({ contents: 240, margin: 400, editor: 560, overlay: false });
  });

  it('shares the room between the page and an editor the learner never sized', () => {
    expect(fit({}, all, 1424).editor).toBe(400); // (1424 − 240 − 384) / 2
  });

  it('shrinks the editor first, then the margin, then folds the contents, and at last lays panels over the page', () => {
    const want = { contents: 240, margin: 384, editor: 600 };
    expect(fit(want, all, 1500)).toMatchObject({ editor: 516, margin: 384, folded: false }); // 240 + 384 + 516 + 360
    expect(fit(want, all, 1200)).toMatchObject({ editor: 320, margin: 280, contents: 240, folded: false });
    const narrow = fit(want, all, 1100);
    expect(narrow).toMatchObject({ folded: true, autoFolded: true, overlay: false });
    expect(fit(want, all, 700)).toMatchObject({ folded: true, overlay: true });
    // Closed panels take no room.
    expect(fit(want, { margin: false, editor: false }, 700)).toMatchObject({ folded: false, overlay: false });
  });

  it('keeps widths within limits, and folds the contents when dragged to the rail', () => {
    expect(resized({}, 'margin', 5000, 600)).toEqual({ margin: 600 });
    expect(resized({}, 'margin', 10, 600)).toEqual({ margin: 280 });
    expect(resized({ contents: 300 }, 'contents', 90, 400)).toEqual({ contents: 300, folded: true });
    expect(resized({ folded: true }, 'contents', 200, 400)).toEqual({ contents: 200, folded: false });
  });
});

function setup(layout: Layout = {}, open = { margin: true, editor: false }) {
  const onLayout = vi.fn<(l: Layout) => void>();
  const view = (l: Layout, o = open) => (
    <Workspace
      layout={l}
      onLayout={onLayout}
      marginOpen={o.margin}
      editorOpen={o.editor}
      contents={
        <nav aria-label="Contents">
          <button type="button" data-tip="Four Numbers" data-tip-meta="Lesson 01">
            01 Four Numbers
          </button>
        </nav>
      }
      page={<div className="page">page</div>}
      editor={<section aria-label="Editor">editor</section>}
      margin={<section aria-label="Tutor">chat</section>}
    />
  );
  const r = render(view(layout));
  return { onLayout, rerender: (l: Layout, o = open) => r.rerender(view(l, o)), unmount: r.unmount, container: r.container };
}

describe('the workspace', () => {
  it('hides closed panels from assistive tech while they slide shut', () => {
    const { rerender } = setup();
    expect(screen.getByRole('region', { name: 'Tutor' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Editor' })).toBeNull();
    rerender({}, { margin: false, editor: true });
    expect(screen.queryByRole('region', { name: 'Tutor' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Editor' })).toBeInTheDocument();
  });

  it('resizes a panel from the keyboard, and resets it on Enter', () => {
    const { onLayout } = setup({ margin: 400 });
    const line = screen.getByRole('separator', { name: 'Resize the side panel' });
    expect(line).toHaveAttribute('aria-valuenow', '400');
    fireEvent.keyDown(line, { key: 'ArrowLeft' }); // the line moves left: the margin widens
    expect(onLayout).toHaveBeenLastCalledWith({ margin: 416 });
    fireEvent.keyDown(line, { key: 'ArrowRight', shiftKey: true });
    expect(onLayout).toHaveBeenLastCalledWith({ margin: 336 });
    fireEvent.keyDown(line, { key: 'Enter' });
    expect(onLayout).toHaveBeenLastCalledWith({});
  });

  it('resizes a panel by dragging its edge, saving once at the end', () => {
    const { onLayout } = setup({ contents: 240 });
    const line = screen.getByRole('separator', { name: 'Resize the contents' });
    fireEvent.pointerDown(line, { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 300, pointerId: 1 });
    expect(line).toHaveAttribute('aria-valuenow', '300');
    expect(onLayout).not.toHaveBeenCalled();
    fireEvent.pointerUp(line, { clientX: 300, pointerId: 1 });
    expect(onLayout).toHaveBeenCalledWith({ contents: 300, folded: false });
  });

  it('folds the contents to a rail, with names beside it on hover', async () => {
    const user = userEvent.setup();
    const { onLayout, rerender } = setup();
    await user.click(screen.getByRole('button', { name: 'Collapse contents' }));
    expect(onLayout).toHaveBeenLastCalledWith({ folded: true });
    rerender({ folded: true });
    expect(screen.getByRole('separator', { name: 'Resize the contents' })).toHaveAttribute('aria-valuenow', String(RAIL));
    // Unfolded, no tooltip; folded, the lesson's name and number.
    await user.hover(screen.getByRole('button', { name: /Four Numbers/ }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Lesson 01Four Numbers');
    await user.unhover(screen.getByRole('button', { name: /Four Numbers/ }));
    await user.click(screen.getByRole('button', { name: 'Expand contents' }));
    expect(onLayout).toHaveBeenLastCalledWith({ folded: false });
  });

  it('ignores other buttons and stray moves, resets on double-click, and goes to the ends with Home and End', () => {
    const { onLayout } = setup({ contents: 300, margin: 500 });
    const contents = screen.getByRole('separator', { name: 'Resize the contents' });
    fireEvent.pointerDown(contents, { button: 2, clientX: 300 });
    fireEvent.pointerMove(contents, { clientX: 400 });
    fireEvent.pointerUp(contents, { clientX: 400 });
    fireEvent.pointerCancel(contents);
    fireEvent.keyDown(contents, { key: 'a' });
    expect(onLayout).not.toHaveBeenCalled();
    fireEvent.doubleClick(contents);
    expect(onLayout).toHaveBeenLastCalledWith({ margin: 500, folded: false });
    fireEvent.keyDown(contents, { key: 'Home' });
    expect(onLayout).toHaveBeenLastCalledWith({ contents: 300, margin: 500, folded: true });
    const margin = screen.getByRole('separator', { name: 'Resize the side panel' });
    fireEvent.keyDown(margin, { key: 'End' });
    expect(onLayout).toHaveBeenLastCalledWith({ contents: 300, margin: 760 });
    fireEvent.doubleClick(margin);
    expect(onLayout).toHaveBeenLastCalledWith({ contents: 300 });
  });

  it('fits the panels again when the window is resized, without sliding them there', () => {
    vi.useFakeTimers();
    let resize: (entries: { contentRect: { width: number } }[]) => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: typeof resize) {
          resize = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const { container, unmount } = setup({}, { margin: true, editor: true });
    const ws = container.querySelector('.workspace')!;
    act(() => vi.advanceTimersByTime(60));
    expect(ws).not.toHaveClass('still');
    act(() => resize([{ contentRect: { width: 700 } }]));
    expect(ws).toHaveClass('folded', 'overlay', 'still');
    act(() => resize([{ contentRect: { width: 700 } }])); // the same width: nothing to do
    act(() => vi.advanceTimersByTime(200));
    expect(ws).not.toHaveClass('still');
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('hides the rail’s tooltip when the contents scroll', async () => {
    const user = userEvent.setup();
    const { container } = setup({ folded: true });
    await user.hover(screen.getByRole('button', { name: /Four Numbers/ }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(container.querySelector('.panel.contents')!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Focus shows it too, for the keyboard.
    act(() => screen.getByRole('button', { name: /Four Numbers/ }).focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Four Numbers');
    act(() => screen.getByRole('button', { name: /Four Numbers/ }).blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('a closing panel', () => {
  function Probe({ value }: { value: string | undefined }) {
    return <p>{useLingering(value, 100) ?? 'gone'}</p>;
  }
  it('keeps showing what it showed while it closes', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Probe value="history" />);
    rerender(<Probe value={undefined} />);
    expect(screen.getByText('history')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByText('gone')).toBeInTheDocument();
  });
});
