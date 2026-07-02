import React from 'react';
import { RefreshCw } from 'lucide-react';
import { isChunkLoadError } from '../utils/chunk-load-error';

interface PanelErrorBoundaryProps {
  children: React.ReactNode;
  /** Names the surface in the message: "Failed to load the {label}". Default "panel". */
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
    window.electronAPI?.analytics?.trackRendererError(error.message);
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
      return (
        <div
          data-testid="panel-error-boundary"
          className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <span className="text-sm text-fg-secondary">
            Failed to load the {this.props.label ?? 'panel'}
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
            {chunkLoadFailure ? 'Reload' : 'Retry'}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
