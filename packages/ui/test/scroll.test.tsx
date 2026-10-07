// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RpcProvider } from '../src/hooks.tsx';
import { Conversation, scrollerOf } from '../src/screens/Conversation.tsx';
import { FakeRpc } from './fake-rpc.ts';

afterEach(() => vi.restoreAllMocks());

/** jsdom does no layout: give the scroll area its sizes, and say whether the conversation is shown. */
function layout(shown: { value: boolean }) {
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => (shown.value ? [{}] : []) as unknown as DOMRectList);
  const box = { height: 2000 };
  return {
    box,
    attach(el: HTMLElement) {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 });
    },
  };
}

describe('scrolling the conversation', () => {
  it('keeps the distance from the bottom the learner chose, and follows when at the bottom', async () => {
    const user = userEvent.setup();
    const shown = { value: true };
    const { box, attach } = layout(shown);
    const r = new FakeRpc().handle('history.list', () => []).handle('ask', () => ({ askId: 'a1' }));
    const { container } = render(
      <RpcProvider client={r.asClient()}>
        <div className="page" style={{ overflowY: 'auto' }}>
          <Conversation projectId="p" lessonId={undefined} request={{ question: 'Interview me', nonce: 1 }} />
        </div>
      </RpcProvider>,
    );
    const page = container.querySelector<HTMLElement>('.page')!;
    attach(page);
    await screen.findByText('Interview me');
    const step = (id: string) => act(() => r.emit('ask.event', { askId: 'a1', event: { kind: 'tool', id, title: 'mcp__aporia__get_skill_map', status: 'pending' } }));

    // At the bottom: each new step keeps the view at the bottom.
    step('t1');
    expect(page.scrollTop).toBe(1500);
    box.height = 2100;
    step('t2');
    expect(page.scrollTop).toBe(1600);

    // Scrolled up to read: new steps arrive below without moving what the learner reads.
    page.scrollTop = 1000;
    fireEvent.scroll(page);
    box.height = 2300;
    step('t3');
    expect(page.scrollTop).toBe(1200); // still 600 from the bottom

    // Hidden (a lesson is shown in the same page): its scrolling is neither recorded nor touched.
    shown.value = false;
    page.scrollTop = 0;
    fireEvent.scroll(page);
    box.height = 2400;
    step('t4');
    expect(page.scrollTop).toBe(0);
    shown.value = true;
    box.height = 2500;
    step('t5');
    expect(page.scrollTop).toBe(1400); // back where the learner left the conversation

    // Sending a message goes back to the bottom, to follow the answer.
    act(() => r.emit('ask.done', { askId: 'a1', stopReason: 'end_turn' }));
    await user.type(screen.getByLabelText('Your message'), 'next');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('next');
    expect(page.scrollTop).toBe(2000);
  });

  it('finds no scroll area when nothing scrolls', () => {
    const { container } = render(<div><p>x</p></div>);
    expect(scrollerOf(container.querySelector('p'))).toBeUndefined();
    expect(scrollerOf(null)).toBeUndefined();
  });
});
