import { shell } from 'electron';

export const OPEN_PATH_TIMEOUT_MS = 5000;

export interface OpenPathBoundedOptions {
  /** Defaults to OPEN_PATH_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Called with openPath's real outcome when the timer won the race. The
   * invoke has already been answered '' by then, so this is a
   * main-process-side fallback only, never a report back to the renderer.
   */
  onLateOutcome?: (errorMessage: string) => void;
}

/**
 * Open a path with the OS default handler, and guarantee this promise settles
 * so an IPC invoke awaiting it is always answered.
 *
 * shell.openPath() never rejects - it always resolves, with '' on success or
 * a non-empty error string on failure (Electron's
 * shell/common/api/electron_api_shell.cc). Nothing bounds how long that can
 * take: on Linux, OpenPath shells out to xdg-open, which can wait on
 * whatever viewer it launches. If that promise never settles, it can outlive
 * the renderer's ipcRenderer.invoke() call, and the reply channel gets torn
 * down without ever sending a reply - surfacing as "reply was never sent"
 * (Electron's ReplyChannel::EnsureReplySent pre-finalizer). Racing openPath
 * against a timeout does not un-stick that hang; it only guarantees this
 * function's own promise settles, so the invoke is always answered.
 *
 * Resolves the string the renderer contract expects: '' on success AND on
 * timeout, otherwise Electron's error string.
 *
 * This is the only place in the main process that may call shell.openPath.
 * tests/unit/open-path-bounded-boundary.test.ts fails CI on any other call
 * site, because an unbounded one re-opens the bug above.
 */
export function openPathBounded(targetPath: string, options?: OpenPathBoundedOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? OPEN_PATH_TIMEOUT_MS;
  const openPromise = shell.openPath(targetPath);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // The invoke is answered now. Hand the eventual real outcome to the
      // caller's fallback, which can still act in the main process.
      void openPromise.then(
        (lateError) => options?.onLateOutcome?.(lateError),
        () => {
          // Nothing left to report: the invoke was answered at the timeout.
        },
      );
      resolve('');
    }, timeoutMs);

    // The race proper. If the timer already fired, both branches below are
    // late: clearTimeout is a no-op and resolve() cannot change a promise the
    // timer already settled, so the timeout path's answer stands.
    void openPromise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        // openPath is documented never to reject, but this function exists to
        // guarantee the invoke is answered - so it cannot depend on an
        // upstream contract holding. Report a rejection as the failure it is
        // instead of stalling until the timer and then claiming success.
        clearTimeout(timer);
        const message = error instanceof Error ? error.message : String(error);
        // Never resolve '' here: '' is this function's success value.
        resolve(message || 'The file could not be opened.');
      },
    );
  });
}
