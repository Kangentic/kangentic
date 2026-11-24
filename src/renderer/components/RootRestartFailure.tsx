import { describeIpcError, asSentence } from '../lib/ipc-error';

/**
 * Why Restart did not go through, shown under the whole-window boundary's buttons.
 *
 * It is a component of its own so that `ErrorBoundary.tsx` does not import
 * `lib/ipc-error.ts`. The boundary is a class, Fast Refresh remounts a class
 * whenever its module is re-evaluated, and the boundary wraps the whole window.
 * While it imported ipc-error.ts, every edit to that file remounted the app and
 * destroyed every live Browser pane guest (measured with
 * scripts/hmr-guest-probe.mjs). A function component's module takes that update
 * itself, and the boundary's module stays as it was.
 */
export function RootRestartFailure({ error }: { error: unknown }) {
  return (
    <p className="text-sm text-fg-muted max-w-md text-center" data-testid="root-error-restart-failure">
      {asSentence(describeIpcError(error))}
    </p>
  );
}
