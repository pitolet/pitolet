import { Button } from '@pitolet/ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportDashboardProblem } from './clientProblems.js';

export class ClientErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportDashboardProblem(error, {
      component: info.componentStack ? 'dashboard-react-tree' : 'dashboard',
    });
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="ptl-dash-center">
          <div className="ptl-connection-error">
            <strong>The dashboard stopped unexpectedly</strong>
            <p>The problem was recorded. Reload the page to try again.</p>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
