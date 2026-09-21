import React from 'react';
import { RefreshCw } from 'lucide-react';
import { reportBoundaryError } from '../../../../error-reporting';

/** Scoped error boundary prevents Monaco failures from crashing the entire app. */
export class DiffErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('DiffViewer error:', error, info.componentStack);
    // Boundary-caught errors never reach Sentry's global handlers (React
    // swallows them); see ErrorBoundary.componentDidCatch. This boundary was
    // the only one in the tree not forwarding them, so a diff-viewer render
    // crash reached the console and nothing else.
    //
    // It still catches only RENDER-phase throws. The diff subsystem's known
    // crash class (Sentry DESKTOP-19) is thrown asynchronously from inside
    // Monaco, so it bypasses React entirely and reaches Sentry through the
    // global handlers instead. Do not read this boundary as covering it.
    reportBoundaryError(error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
          <span className="text-xs text-red-400">
            {this.state.error?.message || 'Failed to load diff viewer'}
          </span>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="flex items-center gap-1.5 text-xs px-3 py-1 rounded bg-surface-raised hover:bg-surface-raised/80 text-fg-secondary transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
