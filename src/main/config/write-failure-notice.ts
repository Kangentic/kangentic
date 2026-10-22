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
 * How Windows refuses a rename onto a file another program holds open without delete
 * sharing: a file-sync client, a scanner or an indexer, usually for a moment after every
 * change (Sentry DESKTOP-1Z). A target with the read-only attribute fails the same way,
 * as EPERM from `rename`, and the error carries nothing that tells the two apart. A local
 * POSIX filesystem never refuses a rename over an open file, so there these codes keep
 * the meaning `CAUSE_BY_ERRNO` gives them. The async writer in
 * `agent/adapters/claude/trust-manager.ts` also retries on these three codes, with its
 * own budget and no platform or syscall check.
 */
const HELD_FILE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Names both causes, because a held file and a read-only one raise the same error. */
const HELD_FILE_CAUSE = 'The file is in use or read-only';

/**
 * What the user can actually do about it, keyed by errno. A full disk, a permissions
 * problem and a read-only volume are three different fixes, and the message used to
 * name none of them - Sentry DESKTOP-1C was an ENOSPC that read as a Kangentic bug.
 * A rename Windows refused over its target is checked before this table
 * (`isRenameOntoHeldFile`), because there EPERM and EACCES mean a held or read-only file,
 * not a permissions problem.
 *
 * `EBADF` is here deliberately: it is the errno from DESKTOP-14/DESKTOP-13, the
 * userData-on-a-removable-volume case this whole subsystem was built for.
 *
 * An unlisted errno gets no cause, so the message falls back to the plain sentence.
 * A cause we have not seen degrades to no cause rather than to a wrong guess.
 *
 * A `Map` rather than an object literal so an errno that happens to name an
 * `Object.prototype` member (`constructor`, `toString`) misses instead of resolving to
 * an inherited function, which a truthy value would then splice into the user's message.
 *
 * The last four keys are one condition, not four: a drive that went away reports itself
 * differently depending on where in the stack the write died.
 */
const CAUSE_BY_ERRNO = new Map<string, string>([
  ['ENOSPC', 'The disk is full'],
  ['EACCES', 'Kangentic does not have permission'],
  ['EPERM', 'Kangentic does not have permission'],
  ['EROFS', 'The volume is read-only'],
  ['EBADF', 'The drive is unavailable'],
  ['ENODEV', 'The drive is unavailable'],
  ['ENXIO', 'The drive is unavailable'],
  ['EIO', 'The drive is unavailable'],
]);

/** The errno of a Node fs error, or undefined for anything that carries no `code`. */
function readErrnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/** The syscall a Node fs error came from (`rename`, `open`, `mkdir`), or undefined. */
function readSyscall(error: unknown): string | undefined {
  const syscall = (error as NodeJS.ErrnoException | undefined)?.syscall;
  return typeof syscall === 'string' && syscall.length > 0 ? syscall : undefined;
}

/**
 * True when `error` is Windows refusing a rename because another program holds the
 * target, or because the target is read-only, which raises the same error. Read from the
 * error's fields, never its message. `safe-write.ts` retries on it
 * and the notice names it, so the two cannot disagree about what a held file looks like.
 * The platform is read per call so a test can switch it.
 */
export function isRenameOntoHeldFile(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  if (readSyscall(error) !== 'rename') return false;
  return HELD_FILE_RENAME_CODES.has(readErrnoCode(error) ?? '');
}

/**
 * One wording for every source. "Its data folder" did not describe a project's
 * `.kangentic/`, and the old consequence ("Changes apply to this session") was false for
 * a project override, which keeps no in-memory copy and so loses the change outright.
 *
 * The toast body, one sentence: the renderer titles it "Change not saved to disk", which
 * is what "it" refers to, so the body is only the cause and what it costs.
 */
function buildUserMessage(error: unknown): string {
  const cause = isRenameOntoHeldFile(error)
    ? HELD_FILE_CAUSE
    : CAUSE_BY_ERRNO.get(readErrnoCode(error) ?? '');
  return cause ? `${cause}, so it may be lost on restart.` : 'It may be lost on restart.';
}

/**
 * What goes to Sentry in place of a Node system error. Node writes the paths a syscall
 * touched into the message (`EPERM: operation not permitted, rename '<temp>' -> '<target>'`)
 * and the stack's first line repeats it. `redact-event-paths.ts` rewrites only the home
 * directory, so a project on another drive reached Sentry whole (DESKTOP-1Z).
 *
 * The copy's message is built from the errno and syscall fields. It keeps the original
 * frames when the original stack's first line is exactly the header it is replacing, so the
 * trace and the issue's grouping stay the same; otherwise it keeps its own frames rather than
 * risk copying part of the old message. A prefix match is not enough: a message that was
 * shortened after the stack was captured heads a longer, path-bearing first line, and slicing
 * at the shorter header would send the rest of that line. `path`, `dest` and `cause` are not
 * copied.
 *
 * An error with no `code` is not a system error and carries no syscall paths, so it is
 * sent as it is.
 */
function toPathFreeError(error: unknown, errno: string | undefined, syscall: string | undefined): unknown {
  if (!errno) return error;
  const pathFree = new Error(syscall ? `${errno}: ${syscall} failed` : errno);
  const original = error as Error;
  const originalHeader = `${original.name}: ${original.message}`;
  const originalStack = original.stack;
  const headerIsWholeFirstLine = typeof originalStack === 'string'
    && (originalStack === originalHeader || originalStack.startsWith(`${originalHeader}\n`));
  if (headerIsWholeFirstLine) {
    pathFree.stack = `${pathFree.name}: ${pathFree.message}${originalStack.slice(originalHeader.length)}`;
  }
  return pathFree;
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
  const syscall = readSyscall(error);
  // The errno and syscall ride as tags so this class stays queryable, and mutable, from
  // the Sentry UI without a code change. ENOSPC is a host condition rather than a bug,
  // but it is also the only evidence this user-facing path fires at all, so it is
  // filed rather than filtered. Each is omitted entirely when the error does not carry
  // it, rather than sent as an empty string.
  const tags: Record<string, string> = { source };
  if (errno) tags.errno = errno;
  if (syscall) tags.syscall = syscall;
  reportHandledError(toPathFreeError(error, errno, syscall), tags);
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
