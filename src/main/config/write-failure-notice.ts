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

/**
 * What the user can actually do about it, keyed by errno. A full disk, a permissions
 * problem and a read-only volume are three different fixes, and the message used to
 * name none of them - Sentry DESKTOP-1C was an ENOSPC that read as a Kangentic bug.
 *
 * `EBADF` is here deliberately: it is the errno from DESKTOP-14/DESKTOP-13, the
 * userData-on-a-removable-volume case this whole subsystem was built for.
 *
 * An unlisted errno gets no clause, so the message falls back to exactly the sentence
 * that shipped before the causes existed. A cause we have not seen degrades to the old
 * wording rather than to a wrong guess.
 *
 * A `Map` rather than an object literal so an errno that happens to name an
 * `Object.prototype` member (`constructor`, `toString`) misses instead of resolving to
 * an inherited function, which a truthy value would then splice into the user's message.
 *
 * The last four keys are one condition, not four: a drive that went away reports itself
 * differently depending on where in the stack the write died.
 */
const CAUSE_CLAUSE_BY_ERRNO = new Map<string, string>([
  ['ENOSPC', ' because the disk is full'],
  ['EACCES', ' because it does not have permission'],
  ['EPERM', ' because it does not have permission'],
  ['EROFS', ' because the volume is read-only'],
  ['EBADF', ' because the drive is unavailable'],
  ['ENODEV', ' because the drive is unavailable'],
  ['ENXIO', ' because the drive is unavailable'],
  ['EIO', ' because the drive is unavailable'],
]);

/** The errno of a Node fs error, or undefined for anything that carries no `code`. */
function readErrnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function buildUserMessage(error: unknown): string {
  const causeClause = CAUSE_CLAUSE_BY_ERRNO.get(readErrnoCode(error) ?? '') ?? '';
  return `Kangentic could not write to its data folder${causeClause}. `
    + 'Changes apply to this session but will not persist.';
}

/**
 * Report a sync write that failed for `source`. Reports to Sentry and notifies the
 * user once per source, then stays silent until `noteSyncWriteSuccess(source)`
 * re-arms it - a window drag or a settings change during an outage must not spam
 * either channel.
 *
 * The latch is keyed by source ALONE, not by (source, errno): one outage is one
 * notice, even if the errno changes while it lasts. Naming the cause in the message
 * is what makes that worth stating out loud, since it reads like an invitation to
 * re-notify whenever the cause changes. It is not one.
 *
 * A settings change the user makes DURING an already-latched outage is told about
 * separately, by the settings panel reading `config:set`'s `persisted` flag (see
 * `AppSettingsPanel.tsx`). That is deliberately not this latch's job: the busiest
 * writer of source `config` is the window-bounds debounce, so this notice is usually
 * spent on a window move nobody was thinking about, and the second mechanism is what
 * keeps the settings save the user DID care about from being silent.
 */
export function reportSyncWriteFailure(error: unknown, source: string): void {
  if (failingSources.has(source)) return;
  failingSources.add(source);
  const errno = readErrnoCode(error);
  // The errno rides as a tag so this class stays queryable, and mutable, from the
  // Sentry UI without a code change. ENOSPC is a host condition rather than a bug,
  // but it is also the only evidence this user-facing path fires at all, so it is
  // filed rather than filtered. Omitted entirely when the error carries no code,
  // rather than sent as an empty string.
  reportHandledError(error, errno ? { source, errno } : { source });
  // The notifier is injected, so its body is not ours to trust: the wired one
  // reaches a BrowserWindow whose webContents can be gone even when the window
  // itself is not (a renderer crash). A throw here would escape safeWriteJson's
  // catch and break the "returns false on any failure" contract every adopted
  // call site now relies on - task-crud.ts dropped its own try/catch on the
  // strength of it. reportHandledError already swallows its own failures.
  try {
    notifier?.(buildUserMessage(error));
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
