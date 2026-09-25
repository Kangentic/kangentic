import { isShuttingDown } from '../shutdown-state';

/**
 * Run a database access that must not take its caller down with it.
 *
 * Promoted from the private `softly()` in `repositories/dev-port-repository.ts`,
 * which argued the case first: a lookup that degrades to a sensible empty
 * answer is often the correct behaviour, while a throw that propagates is not.
 * Sentry DESKTOP-A/B is the second consumer, and what earned the extraction:
 * `project:list` and `projectGroup:list` were bare one-liners, so a
 * `SQLITE_IOERR` on the global database reached the user as
 * `Error invoking remote method 'project:list'` with a stack trace attached.
 *
 * ## What may be softened
 *
 * Reads, and writes that are ADVISORY - nothing reports their success and
 * nothing downstream depends on it. The dev-port lease table is the whole of
 * the second category today, and its own docblock explains why an advisory
 * ledger must never be load bearing.
 *
 * NOT a write whose success is reported back to the renderer.
 * `.claude/rules/project-scoped-ipc.md` is explicit that a failed mutation must
 * not report success, and swallowing one here would do exactly that.
 *
 * ## Why the dialog is opt-in and not baked in
 *
 * Not every soft failure means the app is broken. The dev-port ledger degrades
 * on every unit-tier CI run by design (`better-sqlite3` is an Electron ABI
 * build, so `getGlobalDb()` throws NODE_MODULE_VERSION under plain Node - see
 * tests/unit/dev-port-ledger-unavailable.test.ts). Wiring the user-facing
 * notification into this combinator would mean a dev-only feature's expected
 * ledger miss pops "Kangentic can't read its database" at a production user,
 * and would burn the once-per-process notification on it, so the later
 * `project:list` failure surfaces nothing at all. That is precisely the "app
 * looks broken with no explanation" case this module exists to close.
 *
 * So `notify` is passed only by call sites whose failure genuinely leaves the
 * app non-functional.
 */

export interface SoftlyOptions {
  /**
   * Appended to the one-time log line to say what the fallback MEANS, since
   * "returned an empty array" reads very differently for an advisory ledger
   * than for the project list.
   */
  note?: string;
  /** Log prefix. Defaults to `[db]`; the dev-port ledger keeps its own. */
  tag?: string;
  /**
   * Console level. Defaults to `error`. The advisory dev-port ledger passes
   * `warn`, because its degradation is expected rather than a fault. The log
   * mirror persists both unconditionally, so this is about how the line reads,
   * not whether it survives.
   */
  level?: 'warn' | 'error';
  /**
   * Surface the unreadable-database dialog. Only for access whose failure makes
   * the app non-functional. The notifier debounces to once per process.
   */
  notify?: boolean;
}

/**
 * Called on every notifying failure. Injected rather than imported so this
 * module's static graph stays free of `electron` and `@sentry/electron`, which
 * is the same reason `setProjectDbInitializer` exists in `database.ts`: the
 * unit tier traverses this graph and cannot load either.
 *
 * Left unset, a notifying access still degrades and still logs. It just has no
 * way to tell anyone, which is the right behaviour outside a running app.
 */
export type GlobalDbFailureNotifier = (error: unknown, operation: string) => void;

let notifier: GlobalDbFailureNotifier | null = null;

export function setGlobalDbFailureNotifier(notify: GlobalDbFailureNotifier): void {
  notifier = notify;
}

/**
 * Logged once per OPERATION, not once per call. The dev-port docblock's
 * objection was to a line per task serialization, which this still avoids; the
 * operation set is small and static, so the bound holds while each distinct
 * failure still gets said out loud exactly once.
 */
const loggedOperations = new Set<string>();

export function softly<T>(
  operation: string,
  fallback: T,
  run: () => T,
  options: SoftlyOptions = {},
): T {
  try {
    return run();
  } catch (error) {
    // Shutdown closes every connection synchronously, so anything that resumes
    // afterwards throws "The database connection is not open". That is teardown
    // working correctly, not a disk problem: stay silent. Same guard, same
    // reason as handlers/task-move.ts.
    if (isShuttingDown()) return fallback;

    if (!loggedOperations.has(operation)) {
      loggedOperations.add(operation);
      const tag = options.tag ?? '[db]';
      const note = options.note ? ` ${options.note}` : '';
      const line = `${tag} Database access failed (${operation}); degrading.${note}`;
      if (options.level === 'warn') console.warn(line, error);
      else console.error(line, error);
    }

    // No once-guard here on purpose. The notifier owns those semantics, because
    // it is the half that knows a successful Retry has re-armed it. Duplicating
    // the flag here would leave this one latched true after a recovery and
    // silence the next real failure.
    if (options.notify) notifier?.(error, operation);

    return fallback;
  }
}
