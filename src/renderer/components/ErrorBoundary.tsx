import React from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { reportBoundaryError } from '../error-reporting';
import { syncFocusedTerminals } from '../utils/focused-terminals';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * The whole-window boundary. It wraps `<App />` and every pop-out's surface root
 * (`index.tsx`, `PopOutSurfaceRoot`), so it sits above the window's one focus
 * publisher (`useFocusedSessionsSync` in the main window, the monitor layer's
 * bridge in a detached monitor, `usePublishCommandTerminalFocus` in a detached
 * Command Terminal) and every terminal the window mounts. Do not use it below
 * either.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // First, before anything that could throw: every terminal this window held
    // is gone, but the page lives on, so its port and its focus set would stay
    // registered and the pty host would keep posting output nobody acks until
    // the agent sat paused at the backpressure high water (task #912). Main
    // gets an empty set and the registry matches it, so Try again's remount
    // publishes the way a cold boot does. The publishers have no cleanup of
    // their own on purpose: Fast Refresh re-runs every effect, so an unmount
    // cleanup would drop and restore the set on every dev save. Main's copy
    // goes first: the registry's module is part of the graph a hot update
    // may have just broken.
    void window.electronAPI?.sessions?.setFocused([]);
    syncFocusedTerminals(new Set());
    console.error('ErrorBoundary caught:', error, info.componentStack);
    // Boundary-caught errors never reach Sentry's global handlers (React
    // swallows them), so hand the real Error over explicitly; the IPC funnel
    // below keeps Aptabase's coarse app_error pulse alongside it.
    reportBoundaryError(error);
    window.electronAPI?.analytics?.trackRendererError(error.message, {
      boundary: 'root',
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  /**
   * Try again re-renders the modules already loaded, so an error a dev hot
   * update left in them (or any error that is not transient) comes straight
   * back. A reload starts a fresh module graph. The tree is already unmounted,
   * Browser pane guests with it, so a reload loses nothing more.
   */
  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-surface text-fg-tertiary gap-4 p-8">
          <h1 className="text-xl font-semibold text-fg">Something went wrong</h1>
          <p className="text-sm text-fg-muted max-w-md text-center">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={this.handleReload}
              data-testid="root-error-reload"
              className="flex items-center gap-2 px-4 py-2 bg-accent-emphasis hover:bg-accent rounded-md text-sm text-accent-on transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reload
            </button>
            <button
              onClick={this.handleRetry}
              data-testid="root-error-retry"
              className="flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-edge-input rounded-md text-sm text-fg-secondary transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
