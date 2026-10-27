import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { isChunkLoadError } from '../utils/chunk-load-error';
import { reportBoundaryError } from '../error-reporting';

interface PanelErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * The surface's English name for analytics ("agent monitor"). Never shown, so
   * it stays English in every language.
   */
  panel?: string;
  /**
   * The failure line, translated by the caller as one whole sentence
   * ("Failed to load the agent monitor"), so no noun is spliced into another
   * language's grammar.
   */
  message?: string;
  /**
   * The older form: an English noun spliced into "Failed to load the {label}",
   * also sent to analytics. Kept for callers whose area is not yet extracted;
   * new callers pass `panel` and `message`.
   */
  label?: string;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * A SCOPED error boundary for a lazily-loaded panel. Unlike the root
 * `ErrorBoundary` (which replaces the entire app with a full-screen error page),
 * this fills only its own container, so one optional side panel failing to load
 * never unmounts the rest of the app.
 *
 * Recovery depends on the failure:
 * - A chunk-load failure (the code-split `import()` could not fetch) is cached by
 *   the browser module map for the document's lifetime, so a remount re-imports
 *   the same poisoned URL and fails again - the dead "Try again" loop this fix
 *   exists to kill. The only reliable recovery is a full window reload, which
 *   starts a fresh module map (and by then the dev server / network has usually
 *   recovered; in production a reload fetches the new index with fresh chunk
 *   URLs). So for these the action is Reload.
 * - Any other render error may be transient, so the action is Retry, which resets
 *   state and remounts the children (the module is already loaded, so no
 *   re-import is needed).
 *
 * Modeled on the root `ErrorBoundary` and the `DiffErrorBoundary` in `ChangesPanel`.
 */
export class PanelErrorBoundary extends React.Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('PanelErrorBoundary caught:', error, info.componentStack);
    // Boundary-caught errors never reach Sentry's global handlers (React
    // swallows them); see ErrorBoundary.componentDidCatch.
    reportBoundaryError(error);
    window.electronAPI?.analytics?.trackRendererError(error.message, {
      boundary: 'panel',
      panel: this.props.panel ?? this.props.label,
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const chunkLoadFailure = isChunkLoadError(this.state.error);
      const panelLabel = this.props.label;
      let failureLine: React.ReactNode;
      if (this.props.message) failureLine = this.props.message;
      else if (panelLabel) failureLine = <Trans>Failed to load the {panelLabel}</Trans>;
      else failureLine = <Trans>Failed to load the panel</Trans>;
      return (
        <div
          data-testid="panel-error-boundary"
          className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <span className="text-sm text-fg-secondary">
            {failureLine}
          </span>
          {this.state.error?.message && (
            <span className="text-xs text-fg-muted max-w-xs break-words">
              {this.state.error.message}
            </span>
          )}
          <button
            onClick={chunkLoadFailure ? this.handleReload : this.handleRetry}
            data-testid="panel-error-retry"
            className="flex items-center gap-1.5 text-xs px-3 py-1 rounded bg-surface-raised hover:bg-surface-raised/80 text-fg-secondary transition-colors"
          >
            <RefreshCw size={12} />
            {chunkLoadFailure
              ? <Trans context="Action">Reload</Trans>
              : <Trans context="Action">Retry</Trans>}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
