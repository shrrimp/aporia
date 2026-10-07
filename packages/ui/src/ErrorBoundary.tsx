import { Component, type ReactNode } from 'react';

// A real page reload: tests (jsdom) cannot do one.
/* v8 ignore next 3 */
function reload(): void {
  window.location.reload();
}

interface Props {
  /** What broke, in the learner's words ("the editor", "this lesson"). */
  readonly area: string;
  readonly children: ReactNode;
  /** Changing it clears the error (e.g. another lesson or file is opened). */
  readonly resetKey?: unknown;
}

interface State {
  readonly error: Error | undefined;
  readonly resetKey: unknown;
}

/**
 * A rendering error stays in the part of the screen it happened in. Without this, one exception
 * unmounts the whole app and leaves a blank window. Nothing is lost: everything is saved as the
 * learner goes, so "try again" or a reload picks up where they were. The error is logged (the
 * desktop app writes page errors to its log file).
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: undefined, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error(`${this.props.area} failed: ${error.stack ?? error.message}${info.componentStack ?? ''}`);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crashed" role="alert">
        <p>
          Something went wrong in {this.props.area}. Your work is saved.
        </p>
        <p className="quiet">{error.message}</p>
        <p className="crashed-actions">
          <button type="button" onClick={() => this.setState({ error: undefined })}>
            Try again
          </button>
          <button type="button" className="text" onClick={reload}>
            Reload the app
          </button>
        </p>
      </div>
    );
  }
}
