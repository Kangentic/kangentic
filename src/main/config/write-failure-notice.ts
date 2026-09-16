import { reportHandledError } from '../analytics/error-reporting';

/**
 * Called once per newly-failing write SOURCE (see below), with the message to show
 * the user. Injected rather than imported, mirroring `setGlobalDbFailureNotifier`
 * (`src/main/db/soft-db.ts`): the low-level write helper (`safe-write.ts`) that
 * calls into this module has no `BrowserWindow` to push through, and the real
 * notifier (wired in `index.ts`) needs to read the live `mainWindow` at call time,
 * not at registration time. Left unset, a failure still reports to Sentry and still
 * logs; it just has no way to tell the user.
 */
export type SyncWriteFailureNotifier = (message: string) => void;

let notifier: SyncWriteFailureNotifier | null = null;

export function setSyncWriteFailureNotifier(notify: SyncWriteFailureNotifier): void {
  notifier = notify;
}

/**
 * Sources currently in a reported failure state, keyed by the caller-supplied
 * `source` tag rather than one global flag. A single latch would clear too eagerly:
 * if the global config directory is healthy but a project's `.kangentic/` (or the
 * Browser pane's URL store) sits on the dead volume, the healthy source's next
 * successful write would clear the latch while the unhealthy one keeps failing,
 * re-toasting on every one of ITS failures. Keying by source keeps the
 * all-volumes-dead case to a single toast per source and stops that interleaving.
 */
const failingSources = new Set<string>();

const USER_MESSAGE =
  "Kangentic could not write to its data folder. Changes apply to this session but will not persist.";

/**
 * Report a sync write that failed for `source`. Reports to Sentry and notifies the
 * user once per source, then stays silent until `noteSyncWriteSuccess(source)`
 * re-arms it - a window drag or a settings change during an outage must not spam
 * either channel.
 */
export function reportSyncWriteFailure(error: unknown, source: string): void {
  if (failingSources.has(source)) return;
  failingSources.add(source);
  reportHandledError(error, { source });
  // The notifier is injected, so its body is not ours to trust: the wired one
  // reaches a BrowserWindow whose webContents can be gone even when the window
  // itself is not (a renderer crash). A throw here would escape safeWriteJson's
  // catch and break the "returns false on any failure" contract every adopted
  // call site now relies on - task-crud.ts dropped its own try/catch on the
  // strength of it. reportHandledError already swallows its own failures.
  try {
    notifier?.(USER_MESSAGE);
  } catch {
    // Telling the user must never take down the write path it is reporting on.
  }
}

/** Clears `source`'s latch, so a later failure of that same source can report again. */
export function noteSyncWriteSuccess(source: string): void {
  failingSources.delete(source);
}

/** Test-only: reset the latch and the injected notifier between cases. */
export function __resetForTest(): void {
  failingSources.clear();
  notifier = null;
}
