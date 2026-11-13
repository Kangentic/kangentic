import React from 'react';
import { Power, RefreshCw, RotateCcw } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import type { BoundaryReportTags } from '../error-reporting';
import { syncFocusedTerminals } from '../utils/focused-terminals';
import { describeIpcError, asSentence } from '../lib/ipc-error';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** Why Restart did not go through, shown under the buttons. */
  restartError: string | null;
}

/**
 * Restart shows only in a dev build, and only where the running preload has the
 * call. Under `npm start` main and preload are built once at boot, so renderer
 * code merged later can call a preload method the running preload lacks, throw,
 * and land here. Reload runs the same renderer against the same old preload and
 * comes straight back. Restart rebuilds main and preload first
 * (scripts/dev.js restartElectron), which is the one way out. A packaged build
 * ships its renderer and preload together, so it never needs it.
 */
function canRestartApp(): boolean {
  return __KANGENTIC_DEV__ && typeof window.electronAPI?.app?.restart === 'function';
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
    this.state = { hasError: false, error: null, restartError: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error, restartError: null };
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
    // swallows them). The root's onCaughtError (index.tsx) reports every
    // boundary's catch with its tags and component stack, so it is not reported
    // here too; the IPC funnel below keeps Aptabase's coarse app_error pulse.
    window.electronAPI?.analytics?.trackRendererError(error.message, {
      boundary: 'root',
    });
  }

  /** Read by the root's `onCaughtError` (`reportCaughtRenderError`). */
  boundaryReportTags(): BoundaryReportTags {
    return { boundary: 'root' };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, restartError: null });
  };

  /** Restart Kangentic. The tree is already gone, so there is nothing to confirm
   *  against; agents suspend and resume as on any restart. */
  handleRestart = async () => {
    this.setState({ restartError: null });
    try {
      await window.electronAPI.app.restart();
    } catch (error) {
      this.setState({ restartError: asSentence(describeIpcError(error)) });
    }
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
          <h1 className="text-xl font-semibold text-fg"><Trans>Something went wrong</Trans></h1>
          <p className="text-sm text-fg-muted max-w-md text-center">
            {this.state.error?.message || <Trans>An unexpected error occurred.</Trans>}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={this.handleReload}
              data-testid="root-error-reload"
              className="flex items-center gap-2 px-4 py-2 bg-accent-emphasis hover:bg-accent rounded-md text-sm text-accent-on transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              <Trans context="Action">Reload</Trans>
            </button>
            <button
              onClick={this.handleRetry}
              data-testid="root-error-retry"
              className="flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-edge-input rounded-md text-sm text-fg-secondary transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              <Trans>Try again</Trans>
            </button>
            {canRestartApp() && (
              <button
                onClick={() => void this.handleRestart()}
                data-testid="root-error-restart"
                className="flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-edge-input rounded-md text-sm text-fg-secondary transition-colors"
              >
                <Power className="w-4 h-4" />
                <Trans context="Action">Restart</Trans>
              </button>
            )}
          </div>
          {this.state.restartError !== null && (
            <p className="text-sm text-fg-muted max-w-md text-center" data-testid="root-error-restart-failure">
              {this.state.restartError}
            </p>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
