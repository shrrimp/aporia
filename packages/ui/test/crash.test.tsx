// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../src/ErrorBoundary.tsx';

let broken = true;
function Fragile({ label }: { label: string }) {
  if (broken) throw new Error(`cannot draw ${label}`);
  return <p>{label} works</p>;
}

afterEach(() => {
  vi.restoreAllMocks();
  broken = true;
});

describe('ErrorBoundary', () => {
  it('keeps an error inside its part of the screen, logs it, and can try again', async () => {
    const user = userEvent.setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <>
        <p>The rest of the app</p>
        <ErrorBoundary area="the editor">
          <Fragile label="Joint.cpp" />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByText('The rest of the app')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong in the editor. Your work is saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('cannot draw Joint.cpp');
    expect(logged.mock.calls.some((c) => String(c[0]).startsWith('the editor failed: Error: cannot draw Joint.cpp'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Reload the app' })).toBeInTheDocument();

    broken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Joint.cpp works')).toBeInTheDocument();
  });

  it('clears the error when what it shows changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ui = (file: string) => (
      <ErrorBoundary area="the editor" resetKey={file}>
        <Fragile label={file} />
      </ErrorBoundary>
    );
    const { rerender } = render(ui('a.cpp'));
    expect(screen.getByRole('alert')).toHaveTextContent('cannot draw a.cpp');
    rerender(ui('a.cpp'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    broken = false;
    rerender(ui('b.cpp'));
    expect(screen.getByText('b.cpp works')).toBeInTheDocument();
  });
});
