import React from 'react';
import { RefreshCw } from 'lucide-react';
import { reportBoundaryError } from '../error-reporting';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info.componentStack);
    // Boundary-caught errors never reach Sentry's global handlers (React
    // swallows them), so hand the real Error over explicitly; the IPC funnel
    // below keeps Aptabase's coarse app_error pulse alongside it.
    reportBoundaryError(error);
    window.electronAPI?.analytics?.trackRendererError(error.message, {
      boundary: 'root',
      componentStack: info.componentStack ?? undefined,
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-surface text-fg-tertiary gap-4 p-8">
          <h1 className="text-xl font-semibold text-fg">Something went wrong</h1>
          <p className="text-sm text-fg-muted max-w-md text-center">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-edge-input rounded-md text-sm text-fg-secondary transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
