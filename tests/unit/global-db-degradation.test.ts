/**
 * Unit tests for the unreadable-global-database path: src/main/db/database.ts,
 * src/main/db/soft-db.ts, and src/main/db/global-db-dialog.ts.
 *
 * Regression cover for Sentry DESKTOP-9 / DESKTOP-A / DESKTOP-B. One install hit
 * `SqliteError: disk I/O error` on the global index.db at launch. Three things
 * went wrong at once, and each has tests below:
 *
 *   1. `getGlobalDb()` published the connection to its module cache BEFORE the
 *      pragmas and migrations ran, so a throw from `journal_mode = WAL` left a
 *      cached handle that had never been migrated. The first caller saw the real
 *      SqliteError; every later caller got `no such table: projects` instead, so
 *      the symptom mutated away from its cause.
 *   2. `project:list` and `projectGroup:list` were bare one-liners, so the
 *      SqliteError crossed IPC raw. (Covered in project-list-degradation.test.ts,
 *      which needs the opposite mock universe: this file runs the REAL database
 *      module, that one mocks it.)
 *   3. Nothing told the user anything.
 *
 * Every module here is the real one. `better-sqlite3` is mocked instead, because
 * it is an Electron ABI build that cannot load under plain Node at all (see
 * dev-port-ledger-unavailable.test.ts for the CI failure that documents this).
 * Driving the failure from the driver rather than from a mocked `getGlobalDb`
 * is what makes assertion 1 meaningful: a mocked database module would have no
 * cache to get this wrong.
 *
 * Module-level state (the connection cache, the log-once set, the notify-once
 * flag) is cleared with vi.resetModules() plus a fresh import rather than a
 * test-only reset export, which is this repo's idiom - see the comment in
 * tests/unit/startup-gate.test.ts and importFreshModule() in
 * tests/unit/announcements-init-guard.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

interface FakeWindow {
  name: string;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
}

const {
  openDatabase,
  runGlobalMigrationsMock,
  showMessageBoxMock,
  appQuitMock,
  isShuttingDownMock,
  allWindows,
} = vi.hoisted(() => ({
  openDatabase: vi.fn(),
  runGlobalMigrationsMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  appQuitMock: vi.fn(),
  isShuttingDownMock: vi.fn(() => false),
  // Mutable so a test can stand up the window set it needs. BrowserWindow.getAllWindows()
  // is NOT just the main window: browser-lane-manager.ts creates offscreen lanes
  // with `show: false`, and pop-outs are windows of their own.
  allWindows: [] as FakeWindow[],
}));

vi.mock('better-sqlite3', () => ({
  // Returning an object from a constructor overrides `this`, so this stands in
  // for `new Database(file)` without needing a real native binding.
  default: function MockDatabase(file: string) {
    return openDatabase(file);
  },
}));

vi.mock('../../src/main/db/migrations', () => ({
  runGlobalMigrations: (...args: unknown[]) => runGlobalMigrationsMock(...args),
  runProjectMigrations: vi.fn(),
}));

vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    globalDb: '/mock/config/index.db',
    projectDb: (id: string) => `/mock/config/projects/${id}.db`,
  },
  ensureDirs: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { quit: (...args: unknown[]) => appQuitMock(...args) },
  BrowserWindow: { getAllWindows: () => allWindows },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBoxMock(...args) },
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => isShuttingDownMock(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockConnection {
  pragma: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** A connection that answers every pragma happily. */
function healthyConnection(): MockConnection {
  return { pragma: vi.fn(), close: vi.fn() };
}

/**
 * A connection that opens fine and then fails on its first pragma, which is the
 * DESKTOP-9 shape exactly: `new Database()` succeeded and
 * `pragma('journal_mode = WAL')` threw, because WAL has to create the -wal and
 * -shm sidecars and that is what a scan or sync lock blocks.
 */
function ioErrorOnPragma(): MockConnection {
  const error = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
  return {
    pragma: vi.fn(() => { throw error; }),
    close: vi.fn(),
  };
}

const RETRY = 0;
const QUIT = 1;

async function freshModules() {
  vi.resetModules();
  const database = await import('../../src/main/db/database');
  const softDb = await import('../../src/main/db/soft-db');
  const dialogModule = await import('../../src/main/db/global-db-dialog');
  return { ...database, ...softDb, ...dialogModule };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  openDatabase.mockReset();
  runGlobalMigrationsMock.mockReset();
  showMessageBoxMock.mockReset();
  appQuitMock.mockReset();
  isShuttingDownMock.mockReturnValue(false);
  allWindows.length = 0;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The dialog suppresses itself under NODE_ENV=test so E2E never hangs on a
  // modal. Most tests here are ABOUT the dialog, so it is cleared by default
  // and the suppression gets its own test.
  delete process.env.NODE_ENV;
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

// ---------------------------------------------------------------------------

describe('getGlobalDb caching', () => {
  it('does not cache a connection whose pragma threw', async () => {
    // THE red-green test for DESKTOP-9's second-order bug. Before the fix,
    // `globalDb` was assigned on the line above the pragmas, so the broken
    // handle stayed cached for the life of the process and every later read
    // failed as `no such table: projects` instead of as the disk error.
    const broken = ioErrorOnPragma();
    const healthy = healthyConnection();
    openDatabase.mockReturnValueOnce(broken).mockReturnValueOnce(healthy);

    const { getGlobalDb } = await freshModules();

    expect(() => getGlobalDb()).toThrow('disk I/O error');
    expect(
      broken.close,
      'the half-built connection must be closed on failure: leaving the file handle open means a retry is fighting our own lock, not just the antivirus scan',
    ).toHaveBeenCalled();

    expect(
      getGlobalDb(),
      'a second call must REOPEN. Returning the cached, never-migrated connection is what turned a disk error into `no such table: projects` and hid the real cause.',
    ).toBe(healthy);
    expect(openDatabase).toHaveBeenCalledTimes(2);
  });

  it('does not cache a connection whose migrations threw', async () => {
    // Same hazard, one step later in the same function. Migrations run on the
    // connection after the pragmas, so an I/O error there is just as able to
    // leave a handle that answers queries against a schema that was never built.
    const broken = healthyConnection();
    const healthy = healthyConnection();
    openDatabase.mockReturnValueOnce(broken).mockReturnValueOnce(healthy);
    runGlobalMigrationsMock
      .mockImplementationOnce(() => { throw new Error('migration failed'); })
      .mockImplementation(() => {});

    const { getGlobalDb } = await freshModules();

    expect(() => getGlobalDb()).toThrow('migration failed');
    expect(broken.close).toHaveBeenCalled();
    expect(getGlobalDb()).toBe(healthy);
  });

  it('caches a healthy connection, so the happy path still opens once', async () => {
    const healthy = healthyConnection();
    openDatabase.mockReturnValue(healthy);

    const { getGlobalDb } = await freshModules();

    expect(getGlobalDb()).toBe(healthy);
    expect(getGlobalDb()).toBe(healthy);
    expect(
      openDatabase,
      'the fix must not turn the cache off: reopening index.db on every read would be a real regression',
    ).toHaveBeenCalledTimes(1);
    expect(healthy.pragma).toHaveBeenCalledWith('journal_mode = WAL');
    expect(runGlobalMigrationsMock).toHaveBeenCalledTimes(1);
  });

  it('sets busy_timeout before switching to WAL, on both the global and project databases', async () => {
    // busy_timeout is a connection setting: it only covers statements that run
    // AFTER it. journal_mode = WAL is a lock-taking statement (it creates the
    // -wal and -shm sidecars), and two Kangentic instances sharing a config dir
    // (the main checkout plus a non-ephemeral worktree dev run) both open this
    // file eagerly at boot now, so the WAL switch is exactly where they can
    // collide. Swapping the two pragma lines back would silently drop the
    // busy-wait coverage for that collision while every existing assertion
    // (which only checked WAL was called, not when) kept passing.
    const globalHealthy = healthyConnection();
    const projectHealthy = healthyConnection();
    openDatabase.mockReturnValueOnce(globalHealthy).mockReturnValueOnce(projectHealthy);

    const { getGlobalDb, getProjectDb } = await freshModules();
    getGlobalDb();
    getProjectDb('project-1');

    const expectedOrder = ['busy_timeout = 5000', 'journal_mode = WAL', 'foreign_keys = ON'];
    expect(globalHealthy.pragma.mock.calls.map(([sql]) => sql)).toEqual(expectedOrder);
    expect(projectHealthy.pragma.mock.calls.map(([sql]) => sql)).toEqual(expectedOrder);
  });

  it('does not let a close() that itself throws mask the original open failure', async () => {
    // "the original open attempt's error is the one worth surfacing" is
    // closeQuietly's whole stated purpose (see its docblock in database.ts). A
    // connection whose file is already unreachable can easily fail its own
    // close() too, and if that propagated it would replace the real
    // SQLITE_IOERR with a generic close failure - which is exactly the wrong
    // cause for the unreadable-database dialog to name.
    const broken = ioErrorOnPragma();
    broken.close = vi.fn(() => { throw new Error('close failed'); });
    const healthy = healthyConnection();
    openDatabase.mockReturnValueOnce(broken).mockReturnValueOnce(healthy);

    const { getGlobalDb } = await freshModules();

    expect(() => getGlobalDb()).toThrow('disk I/O error');
    expect(broken.close).toHaveBeenCalled();
    // The abandoned handle's own close failure must not have wedged the
    // module: a second call still reopens normally.
    expect(getGlobalDb()).toBe(healthy);
  });

  it('closes a project connection whose pragma threw, too', async () => {
    // getProjectDb never had the cache bug (it writes the map only after
    // migrations), but it did leak the handle: on Windows an unclosed
    // connection keeps the file locked by US, so the retry fights our own lock
    // on top of whatever caused the failure. The code now claims the same
    // guarantee as getGlobalDb, so it gets the same assertion.
    const broken = ioErrorOnPragma();
    const healthy = healthyConnection();
    openDatabase.mockReturnValueOnce(broken).mockReturnValueOnce(healthy);

    const { getProjectDb } = await freshModules();

    expect(() => getProjectDb('project-1')).toThrow('disk I/O error');
    expect(broken.close).toHaveBeenCalled();
    expect(getProjectDb('project-1')).toBe(healthy);
  });

  it('resetGlobalDb closes the handle and forces a genuine reopen', async () => {
    // This is what makes the dialog's Retry button mean something.
    const first = healthyConnection();
    const second = healthyConnection();
    openDatabase.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const { getGlobalDb, resetGlobalDb } = await freshModules();

    expect(getGlobalDb()).toBe(first);
    resetGlobalDb();
    expect(first.close).toHaveBeenCalled();
    expect(getGlobalDb()).toBe(second);
  });

  it('resetGlobalDb still reopens even when the old handle fails to close', async () => {
    // A propagating close() here would throw straight out of the Retry button's
    // click handler (askRetryOrQuit -> resetGlobalDb -> getGlobalDb), which is
    // the one path that exists specifically to recover from a locked file - the
    // exact case where the old handle's close() is likeliest to fail too.
    const first = healthyConnection();
    first.close = vi.fn(() => { throw new Error('close failed'); });
    const second = healthyConnection();
    openDatabase.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const { getGlobalDb, resetGlobalDb } = await freshModules();

    expect(getGlobalDb()).toBe(first);
    expect(() => resetGlobalDb()).not.toThrow();
    expect(getGlobalDb()).toBe(second);
  });
});

// ---------------------------------------------------------------------------

describe('softly', () => {
  it('returns the value when the read succeeds', async () => {
    const { softly } = await freshModules();
    expect(softly('op', [], () => [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('returns the fallback instead of throwing', async () => {
    const { softly } = await freshModules();
    expect(softly('op', ['fallback'], () => { throw new Error('boom'); })).toEqual(['fallback']);
  });

  it('logs once per operation, not once per call', async () => {
    // The dev-port ledger's objection, preserved through the extraction: one
    // line per task serialization would bury every other diagnostic.
    const { softly } = await freshModules();
    const boom = () => { throw new Error('boom'); };

    for (let index = 0; index < 20; index += 1) {
      softly('project:list', [], boom);
      softly('projectGroup:list', [], boom);
    }

    expect(errorSpy.mock.calls.length).toBe(2);
  });

  it('routes an advisory failure to warn rather than error', async () => {
    // The dev-port ledger degrades on every unit-tier CI run by design, so it
    // reads as a warning. An unreadable project list does not.
    const { softly } = await freshModules();
    softly('listForTask', [], () => { throw new Error('boom'); }, { level: 'warn' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('stays completely silent during shutdown', async () => {
    // Shutdown closes every connection synchronously, so anything resuming
    // afterwards throws "The database connection is not open". That is teardown
    // working, not a disk fault, and it must not log or raise a dialog.
    isShuttingDownMock.mockReturnValue(true);
    const { softly, setGlobalDbFailureNotifier } = await freshModules();
    const notifier = vi.fn();
    setGlobalDbFailureNotifier(notifier);

    expect(softly('project:list', [], () => { throw new Error('closed'); }, { notify: true })).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });

  it('notifies only when the call site asked for it', async () => {
    // THE design assertion. If the notification hung off the combinator itself,
    // the dev-port ledger's expected degradation would pop "Kangentic can't read
    // its database" at a production user AND burn the once-per-process
    // notification, so the project:list failure right after it would surface
    // nothing at all - which is the exact "looks broken with no explanation"
    // case this whole change exists to close.
    const { softly, setGlobalDbFailureNotifier } = await freshModules();
    const notifier = vi.fn();
    setGlobalDbFailureNotifier(notifier);
    const boom = () => { throw new Error('boom'); };

    softly('listForTask', [], boom, { level: 'warn' });
    expect(
      notifier,
      'an advisory read must not notify: it is expected to fail on every unit-tier CI run',
    ).not.toHaveBeenCalled();

    softly('project:list', [], boom, { notify: true });
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(expect.any(Error), 'project:list');
  });

  it('still degrades when no notifier was ever registered', async () => {
    // The unit tier never registers one. A read must not become a TypeError
    // because nobody was listening.
    const { softly } = await freshModules();
    expect(softly('project:list', [], () => { throw new Error('boom'); }, { notify: true })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('ensureGlobalDbReadable', () => {
  it('passes silently when the database opens', async () => {
    openDatabase.mockReturnValue(healthyConnection());
    const { ensureGlobalDbReadable } = await freshModules();

    expect((await ensureGlobalDbReadable()).ok).toBe(true);
    expect(showMessageBoxMock).not.toHaveBeenCalled();
  });

  it('names the file and the SQLite code in the dialog', async () => {
    openDatabase.mockReturnValue(ioErrorOnPragma());
    showMessageBoxMock.mockResolvedValue({ response: QUIT });
    const { ensureGlobalDbReadable } = await freshModules();

    await ensureGlobalDbReadable();

    const [options] = showMessageBoxMock.mock.calls[0];
    expect(options.detail).toContain('/mock/config/index.db');
    expect(options.detail).toContain('disk I/O error (SQLITE_IOERR)');
    expect(
      options.detail,
      'the copy has to name the likely causes: the whole point is that SQLITE_IOERR is environmental and the user, not the app, is the one who can act on it',
    ).toContain('antivirus');
    expect(options.buttons).toEqual(['Retry', 'Quit']);
  });

  it('reopens for real on Retry and succeeds once the lock clears', async () => {
    openDatabase
      .mockReturnValueOnce(ioErrorOnPragma())
      .mockReturnValueOnce(healthyConnection());
    showMessageBoxMock.mockResolvedValue({ response: RETRY });
    const { ensureGlobalDbReadable } = await freshModules();

    expect((await ensureGlobalDbReadable()).ok).toBe(true);
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    expect(
      openDatabase,
      'Retry must reopen. An antivirus scan or a sync lock is usually over within seconds, which is the only reason offering Retry beats telling the user to relaunch.',
    ).toHaveBeenCalledTimes(2);
  });

  it('keeps asking while the database stays unreadable', async () => {
    openDatabase.mockReturnValue(ioErrorOnPragma());
    showMessageBoxMock
      .mockResolvedValueOnce({ response: RETRY })
      .mockResolvedValueOnce({ response: RETRY })
      .mockResolvedValue({ response: QUIT });
    const { ensureGlobalDbReadable } = await freshModules();

    expect((await ensureGlobalDbReadable()).ok).toBe(false);
    expect(showMessageBoxMock).toHaveBeenCalledTimes(3);
  });

  it('reports failure without a dialog under NODE_ENV=test', async () => {
    // E2E launches with NODE_ENV=test. A modal there hangs the whole tier with
    // nobody to click it.
    process.env.NODE_ENV = 'test';
    openDatabase.mockReturnValue(ioErrorOnPragma());
    const { ensureGlobalDbReadable } = await freshModules();

    expect((await ensureGlobalDbReadable()).ok).toBe(false);
    expect(showMessageBoxMock).not.toHaveBeenCalled();
  });

  it('hands the give-up error back so the caller can still count it', async () => {
    // Handling this failure must not also make it invisible. The whole cluster
    // was noticed only because it reached Sentry as an unhandled rejection; a
    // silent gate would trade one blind spot for another.
    openDatabase.mockReturnValue(ioErrorOnPragma());
    showMessageBoxMock.mockResolvedValue({ response: QUIT });
    const { ensureGlobalDbReadable } = await freshModules();

    const result = await ensureGlobalDbReadable();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatchObject({ code: 'SQLITE_IOERR' });
  });
});

// ---------------------------------------------------------------------------

describe('notifyGlobalDbUnavailable', () => {
  it('shows the dialog once per process', async () => {
    openDatabase.mockReturnValue(ioErrorOnPragma());
    showMessageBoxMock.mockResolvedValue({ response: QUIT });
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list');
    notifyGlobalDbUnavailable(new Error('boom'), 'projectGroup:list');
    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalled());

    expect(
      showMessageBoxMock,
      'a standing condition deserves one dialog. project:list and projectGroup:list both fail on the same boot, and two identical modals teach nothing.',
    ).toHaveBeenCalledTimes(1);
  });

  it('quits when the user chooses Quit', async () => {
    showMessageBoxMock.mockResolvedValue({ response: QUIT });
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list');
    await vi.waitFor(() => expect(appQuitMock).toHaveBeenCalled());
  });

  it('re-arms after a successful retry, so a later failure can speak again', async () => {
    // The reason the once-guard lives here and not in softly(): this is the
    // half that knows recovery happened. A duplicate flag in the combinator
    // would stay latched true and silence the next real failure.
    openDatabase.mockReturnValue(healthyConnection());
    showMessageBoxMock.mockResolvedValue({ response: RETRY });
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list');
    // Wait for the REOPEN, not for the dialog. The dialog resolves first and
    // the re-arm happens after the reopen succeeds, so waiting on the dialog
    // would fire the second notify into a flag that is still latched.
    await vi.waitFor(() => expect(openDatabase).toHaveBeenCalled());

    notifyGlobalDbUnavailable(new Error('boom again'), 'project:list');
    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalledTimes(2));
  });

  it('does not re-arm after a retry that fails again, so a later failure stays silent', async () => {
    // The mirror of the re-arm test above. A Retry click that STILL fails must
    // not flip `notified` back to false, or a second call site failing on the
    // same still-broken database would pop a second identical dialog for a
    // condition that has not actually changed.
    //
    // The naive version of this test (fire twice, assert one dialog) would
    // pass whether or not the catch branch below ever ran, because `notified`
    // never got reset either way. So this first waits for proof that the retry
    // was actually attempted and actually failed, THEN fires the second call.
    openDatabase.mockReturnValue(ioErrorOnPragma());
    showMessageBoxMock.mockResolvedValue({ response: RETRY });
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list');
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      '[db] Retry failed; the global database is still unreadable.',
      expect.anything(),
    ));

    // `notifyGlobalDbUnavailable` bails at `if (notified) return;` before it
    // does anything else, and that early return is synchronous - so whether
    // this second call did anything can be read back immediately, with no
    // further wait needed.
    notifyGlobalDbUnavailable(new Error('boom again'), 'projectGroup:list');
    expect(
      errorSpy,
      'a second call for a different operation must bail at the top-of-function `notified` guard rather than logging its own "unavailable; notifying" line, which is the earliest observable proof it never re-entered the dialog flow',
    ).not.toHaveBeenCalledWith(
      expect.stringContaining('projectGroup:list'),
      expect.anything(),
    );
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
  });

  it('owns the modal to the window the caller named', async () => {
    const lane: FakeWindow = { name: 'lane', isDestroyed: () => false, isVisible: () => false };
    const main: FakeWindow = { name: 'main', isDestroyed: () => false, isVisible: () => true };
    allWindows.push(lane, main);
    showMessageBoxMock.mockResolvedValue({ response: QUIT });
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list', main as never);
    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalled());

    expect(showMessageBoxMock.mock.calls[0][0]).toBe(main);
  });

  it('never owns the modal to an offscreen lane when it has to guess', async () => {
    // browser-lane-manager.ts creates lanes with `show: false` and
    // `offscreen: true`, and getAllWindows() returns them. Parenting the
    // "your database is unreadable" modal to one would hide the very message
    // this code exists to deliver. The lane is FIRST in the list on purpose:
    // an unfiltered `.find(w => !w.isDestroyed())` picks it.
    const lane: FakeWindow = { name: 'lane', isDestroyed: () => false, isVisible: () => false };
    const popOut: FakeWindow = { name: 'pop-out', isDestroyed: () => false, isVisible: () => true };
    allWindows.push(lane, popOut);
    showMessageBoxMock.mockResolvedValue({ response: QUIT });
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list', null);
    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalled());

    expect(showMessageBoxMock.mock.calls[0][0]).toBe(popOut);
  });

  it('falls back to a parentless dialog when every window is hidden', async () => {
    allWindows.push({ name: 'lane', isDestroyed: () => false, isVisible: () => false });
    showMessageBoxMock.mockResolvedValue({ response: QUIT });
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list', null);
    await vi.waitFor(() => expect(showMessageBoxMock).toHaveBeenCalled());

    // One argument means the parentless overload: a top-level dialog, which is
    // visible, rather than one owned by a window nobody can see.
    expect(showMessageBoxMock.mock.calls[0].length).toBe(1);
  });

  it('does not quit or reopen under NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const { notifyGlobalDbUnavailable } = await freshModules();

    notifyGlobalDbUnavailable(new Error('boom'), 'project:list');

    expect(showMessageBoxMock).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();
  });
});
