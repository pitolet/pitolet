import { Component, type ReactNode } from 'react';

interface Props {
  /** Panel name shown in the fallback. */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Contains a crashing panel instead of black-screening the whole editor. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error(`[pitolet] ${this.props.name} crashed:`, error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 12, fontSize: 12, color: 'var(--ptl-danger)' }}>
          {this.props.name} crashed: {this.state.error.message}
          <button
            type="button"
            style={{
              display: 'block',
              marginTop: 8,
              background: 'var(--ptl-bg-2)',
              color: 'var(--ptl-text-1)',
              border: 'none',
              borderRadius: 6,
              padding: '4px 8px',
            }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
