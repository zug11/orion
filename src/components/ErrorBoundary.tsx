import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeProblems, recordProblem } from "../lib/diagnostics";

interface ErrorBoundaryProps {
  /** What failed, as it reads in "Orion couldn't show …". */
  label: string;
  /** A change here clears the failure, for example navigating to another note. */
  resetKey?: unknown;
  /**
   * `card` explains and offers a retry in place. `none` removes a failed
   * overlay so it cannot cover the work beneath it. `window` is the last
   * resort around the whole app, where only a reload can help.
   */
  fallback?: "card" | "none" | "window";
  onError?: (label: string) => void;
  children: ReactNode;
}

/**
 * Contains a rendering failure to the surface it happened in.
 *
 * Without a boundary, one exception in any view unmounts the entire window,
 * including the parts that hold unsaved work and keep saving it. With one, the
 * rest of Orion carries on and the failed surface can be retried.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)), copied: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    recordProblem("render", error, info.componentStack ?? undefined);
    this.props.onError?.(this.props.label);
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null, copied: false });
    }
  }

  private copyDetails = () => {
    void navigator.clipboard?.writeText(describeProblems())
      .then(() => this.setState({ copied: true }))
      .catch(() => undefined);
  };

  render() {
    if (!this.state.error) return this.props.children;
    const fallback = this.props.fallback ?? "card";
    if (fallback === "none") return null;
    const wholeWindow = fallback === "window";
    return (
      <div className={wholeWindow ? "error-boundary is-window" : "error-boundary"} role="alert">
        <strong>Orion couldn’t show {this.props.label}</strong>
        <p>
          {wholeWindow
            ? "Your saved library is not affected. Reload this window to carry on."
            : "The rest of Orion is still working and your library is still being saved."}
        </p>
        <div>
          <button type="button" className="button ghost" onClick={this.copyDetails}>
            {this.state.copied ? "Details copied" : "Copy details"}
          </button>
          {wholeWindow ? (
            <button type="button" className="button primary" onClick={() => window.location.reload()}>
              Reload window
            </button>
          ) : (
            <button type="button" className="button primary" onClick={() => this.setState({ error: null, copied: false })}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }
}
