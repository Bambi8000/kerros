import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  /** Shown in the fallback so you know which region died. */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * One throw whites out a React app. Every major region of Kerros sits
 * inside one of these, from M0 onward.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Kerros] ${this.props.label} failed`, error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-label">{this.props.label} stopped</div>
        <pre className="crash-message">{error.message}</pre>
        <button type="button" className="btn" onClick={this.reset}>
          Retry this panel
        </button>
      </div>
    );
  }
}
