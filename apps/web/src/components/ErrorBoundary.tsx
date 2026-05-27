import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. Without it, a render error anywhere in the tree unmounts
 * the whole app and leaves a blank/black screen (exactly what a Rules-of-Hooks slip in
 * a modal did). This catches the error and shows a recoverable fallback instead — the
 * conversation is safe (it's persisted server-side), so a reload continues where you
 * left off. Error boundaries must be class components; hooks can't catch render errors.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry pipeline here; surface it in the console for debugging.
    console.error("Ortha UI error boundary caught:", error, info.componentStack);
  }

  private readonly reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="crash">
        <div className="crash__card">
          <h1 className="crash__title">Something went wrong</h1>
          <p className="crash__sub">
            Ortha hit an unexpected error and stopped rendering. Your conversations are saved — reload to pick up
            where you left off.
          </p>
          <div className="crash__actions">
            <button className="btn-sm btn-sm--accent" onClick={() => window.location.reload()}>Reload</button>
            <button className="btn-sm" onClick={this.reset}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
}
