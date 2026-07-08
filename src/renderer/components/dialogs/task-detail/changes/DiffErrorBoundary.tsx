import React from 'react';
import { RefreshCw } from 'lucide-react';

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
