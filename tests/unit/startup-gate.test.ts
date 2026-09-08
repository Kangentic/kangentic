/**
 * Unit tests for src/main/startup-gate.ts and its wiring into
 * src/main/index.ts. The module owns both window-lifecycle predicates, so this
 * suite covers two crashes.
 *
 * Sentry DESKTOP-J (`decideSecondInstanceAction`): the second-instance handler
 * checked `if (mainWindow)` and nothing ever nulled that variable, so a second
 * launch after the window closed called isMinimized() on a DESTROYED
 * BrowserWindow and died with an uncaught `TypeError: Object has been
 * destroyed`. See the describe block for the full ordering rationale.
 *
 * Regression cover for Sentry DESKTOP-3 / DESKTOP-4: on a cold macOS launch,
 * `app.on('activate')` fires DURING launch. The old handler saw a zero window
 * count and called createWindow() while the whenReady body was still parked on
 * `await startMcpHttpServer(...)`. createWindow() calls mainWindow.loadURL()
 * internally, so the renderer mounted and invoked `announcements:get` /
 * `announcements:getHistory` before `initAnnouncements(mainWindow)` had run
 * `ipcMain.handle` - and the invoke rejected with "No handler registered".
 *
 * The suite has two halves. The behavioural half exercises the decision
 * directly. The static half scans src/main/index.ts, because that file makes
 * top-level `electron` calls and cannot be imported by a unit test - the same
 * constraint documented in tests/unit/developer-flag-defaults.test.ts and
 * tests/unit/config-manager.test.ts, and the same scan approach already used by
 * tests/unit/window-open-policy.test.ts and
 * tests/unit/pop-out-surface-registry.test.ts.
 *
 * tests/unit/register-all-idempotency.test.ts covers the neighbouring macOS
 * re-activate invariant, but only by calling registerAllIpc directly; it never
 * goes through the activate handler. This suite closes that gap.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { decideSecondInstanceAction, shouldCreateWindowOnActivate } from '../../src/main/startup-gate';

const REPO_ROOT = path.resolve(__dirname, '../..');
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

/**
 * A named region of index.ts, so a failing scan reports the handful of lines it
 * looked at instead of dumping the whole 1500-line file into the CI log.
 */
function sliceAfter(marker: string, length: number): string {
  const start = INDEX_SOURCE.indexOf(marker);
  if (start === -1) throw new Error(`src/main/index.ts no longer contains ${marker}`);
  return INDEX_SOURCE.slice(start, start + length);
}

/**
 * index.ts with comment-only lines removed, for the COUNT and containment scans
 * below.
 *
 * They match bare call text, which prose can contain: this file's own docblocks
 * discuss `createWindow` and `rebuildMainWindow` by name. Stripping `//` lines
 * and JSDoc `*` bodies first means a comment can never inflate a count into a
 * false green. Positions for the ORDERING scans are still taken from the raw
 * source, since stripping shifts every offset.
 */
const INDEX_CODE = INDEX_SOURCE
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    // Deliberately NOT a bare startsWith('*'): that also drops any future code
    // line whose first character is an asterisk, which would silently remove a
    // call from the counts below - a fail-open, and these scans are the only
    // thing standing between an ungated rebuild path and production.
    const isJsDocBody = trimmed === '*' || trimmed.startsWith('* ') || trimmed.startsWith('*/');
    return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !isJsDocBody;
  })
  .join('\n');

/**
 * Offset of the whenReady body's own `createWindow();`, found by searching from
 * the `app.whenReady().then(` call rather than from the top of the file.
 *
 * The startup-ordering scans below are all about the STARTUP call: what runs
 * before it, and that nothing suspends between it and the gate open. A plain
 * indexOf('createWindow();') was unambiguous while the whenReady body held the
 * only bare call. DESKTOP-J added a second one inside `rebuildMainWindow`,
 * which is defined above app.whenReady() - so the plain scan silently bound to
 * the helper instead and measured a span with nothing to do with startup. Two
 * of those scans went red with misleading messages; the third ('registers
 * updater and announcements from a finally') kept PASSING while measuring
 * restoreShellEnv's finally, which is the worse failure because nothing
 * reports it.
 *
 * Anchoring inside the startup body makes the helper's position irrelevant:
 * wherever it is defined, the startup call is the first one after whenReady.
 */
function whenReadyCreateWindowIndex(): number {
  // `.then(` is load-bearing: two COMMENTS earlier in the file mention
  // "app.whenReady()" in prose (the ConfigManager seed note and the analytics
  // ordering note), and a bare indexOf binds to the first of those - which sits
  // above rebuildMainWindow and so hands back the helper's call again.
  const whenReady = INDEX_SOURCE.indexOf('app.whenReady().then(');
  if (whenReady === -1) throw new Error('src/main/index.ts no longer calls app.whenReady().then(...)');
  const index = INDEX_SOURCE.indexOf('createWindow();', whenReady);
  if (index === -1) throw new Error('no createWindow() call site found after app.whenReady()');
  return index;
}

/**
 * A whole region of comment-stripped index.ts, marker to marker.
 *
 * No character budget, deliberately, and this file already learned why twice:
 * `sliceAfter`'s callers below are tuned to today's code length, so adding a
 * branch or a comment to a handler pushes the code being asserted on out of the
 * window and the test goes red with a message about a bug nobody touched. This
 * is the idiom the whenReady `.catch` scan already uses ("no fixed character
 * budget, so comment growth cannot push the call out of the window"); stripping
 * comments on top of it means the region is exactly the handler's code.
 */
function sliceCodeBetween(startMarker: string, endMarker: string): string {
  const start = INDEX_CODE.indexOf(startMarker);
  if (start === -1) throw new Error(`src/main/index.ts no longer contains ${startMarker}`);
  const end = INDEX_CODE.indexOf(endMarker, start);
  if (end === -1) throw new Error(`the region opened by ${startMarker} is never closed by ${endMarker}`);
  return INDEX_CODE.slice(start, end);
}

/** The whole `second-instance` handler body. Its own close is at 4-space indent;
 *  the trackEvent call it contains closes at 6, so the marker is unambiguous. */
function secondInstanceHandler(): string {
  return sliceCodeBetween("app.on('second-instance', () => {", '\n    });');
}

/** The whole `activate` handler body. Its own close sits at column 0; the
 *  shouldCreateWindowOnActivate object literal it opens closes at 2-space
 *  indent, so the column-0 marker is unambiguous. */
function activateHandler(): string {
  return sliceCodeBetween("app.on('activate', () => {", '\n});');
}

describe('shouldCreateWindowOnActivate', () => {
  it('refuses the launch-time activate that fires before startup completes', () => {
    // The DESKTOP-3/4 case exactly: macOS fires activate during launch, no
    // window exists yet, and the whenReady body has not registered IPC.
    expect(
      shouldCreateWindowOnActivate({
        shuttingDown: false,
        startupComplete: false,
        openWindowCount: 0,
      }),
      'an activate arriving before the whenReady body finished must NOT build a window: it would load a renderer that can invoke announcements/updater channels nobody has registered yet, and leave registerAllIpc holding an unsettled mcpServerHandle',
    ).toBe(false);
  });

  it('builds the window for a normal dock re-activation after startup', () => {
    expect(
      shouldCreateWindowOnActivate({
        shuttingDown: false,
        startupComplete: true,
        openWindowCount: 0,
      }),
      'once startup has completed, an activate with no open windows is the macOS dock-click path and must still rebuild the window',
    ).toBe(true);
  });

  it('does nothing when a window is already open', () => {
    expect(
      shouldCreateWindowOnActivate({
        shuttingDown: false,
        startupComplete: true,
        openWindowCount: 1,
      }),
      'a second BrowserWindow orphans the first, which holds getAllWindows() above zero forever and blocks window-all-closed -> before-quit -> syncShutdownCleanup',
    ).toBe(false);
  });

  it('does nothing while shutting down, even with no windows left', () => {
    expect(
      shouldCreateWindowOnActivate({
        shuttingDown: true,
        startupComplete: true,
        openWindowCount: 0,
      }),
      'rebuilding a window during shutdown resurrects the app mid-teardown',
    ).toBe(false);
  });

  it('keeps the shutdown check ahead of the startup check', () => {
    // Shutdown before startup completed is reachable: a quit during a slow
    // startup. Neither input alone may authorize a window.
    expect(
      shouldCreateWindowOnActivate({
        shuttingDown: true,
        startupComplete: false,
        openWindowCount: 0,
      }),
    ).toBe(false);
  });
});

/**
 * Sentry DESKTOP-J: a fatal, uncaught `TypeError: Object has been destroyed`
 * out of the second-instance handler.
 *
 * The old handler was `if (mainWindow) { if (mainWindow.isMinimized()) ... }`.
 * Nothing ever assigned `mainWindow = null`, so once the window closed the
 * variable held a DESTROYED BrowserWindow: the truthiness check passed and
 * isMinimized() threw out of a raw Electron event handler with no JS frame
 * below it to catch.
 */
describe('decideSecondInstanceAction', () => {
  it('rebuilds when the app outlived its window - the DESKTOP-J case', () => {
    // The exact crash state: the window is gone but the process is still alive
    // holding the single-instance lock, because a browser lane survived the
    // 'closed' sweep and window-all-closed therefore never fired. The old code
    // read this as "focus" and threw; anything but 'rebuild' here either
    // crashes or silently swallows the user's second launch into a process
    // they cannot see.
    expect(
      decideSecondInstanceAction({
        hasLiveWindow: false,
        shuttingDown: false,
        startupComplete: true,
      }),
    ).toBe('rebuild');
  });

  it('focuses an existing window - the ordinary double-launch', () => {
    expect(
      decideSecondInstanceAction({
        hasLiveWindow: true,
        shuttingDown: false,
        startupComplete: true,
      }),
      'the common path must still raise the running window, which is the whole point of holding the single-instance lock',
    ).toBe('focus');
  });

  it('ignores a second launch during shutdown even though a window is still live', () => {
    // THE ordering test. The before-quit drain HIDES windows rather than
    // destroying them, so mid-quit hasLiveWindow is genuinely true. Checking
    // hasLiveWindow before shuttingDown would return 'focus' here and un-hide
    // an app that is already tearing down its PTYs and databases.
    expect(
      decideSecondInstanceAction({
        hasLiveWindow: true,
        shuttingDown: true,
        startupComplete: true,
      }),
      'the shutdown check must come FIRST: the drain hides rather than destroys, so a live-but-hidden window during a quit would otherwise be raised back up mid-teardown',
    ).toBe('ignore');
  });

  it('ignores a second launch during shutdown with no window left', () => {
    expect(
      decideSecondInstanceAction({
        hasLiveWindow: false,
        shuttingDown: true,
        startupComplete: true,
      }),
      'rebuilding a window during shutdown resurrects the app mid-teardown',
    ).toBe('ignore');
  });

  it('refuses to rebuild before startup completes', () => {
    // The DESKTOP-3/4 race, reached from the second-instance side this time:
    // createWindow calls loadURL, so building a window before the whenReady
    // body has registered its channels lets the renderer invoke handlers that
    // do not exist yet. The whenReady body creates the window anyway.
    expect(
      decideSecondInstanceAction({
        hasLiveWindow: false,
        shuttingDown: false,
        startupComplete: false,
      }),
      'a second launch arriving mid-startup must NOT build a window: the whenReady body is about to create one, and racing it is exactly the announcements/updater "No handler registered" failure of DESKTOP-3/4',
    ).toBe('ignore');
  });

  it('still focuses a live window while startup is incomplete', () => {
    // The startup gate exists to stop a window being BUILT too early, not to
    // stop an existing one being raised. Gating 'focus' on it too would make a
    // second launch during a slow startup do nothing at all.
    expect(
      decideSecondInstanceAction({
        hasLiveWindow: true,
        shuttingDown: false,
        startupComplete: false,
      }),
      'startupComplete must gate ONLY the rebuild: a window that already exists is safe to raise whether or not the startup sequence has finished',
    ).toBe('focus');
  });
});

describe('the startup-complete flag', () => {
  beforeEach(() => {
    // The flag is module-level state. vi.resetModules + a fresh dynamic import
    // is this repo's idiom for clearing it (see importFreshModule() in
    // tests/unit/announcements-init-guard.test.ts), which is why the module
    // ships no test-only reset export.
    vi.resetModules();
  });

  it('starts closed, so a launch-time activate is dropped by default', async () => {
    const gate = await import('../../src/main/startup-gate');
    expect(
      gate.isStartupComplete(),
      'the gate must default to closed: the whole fix rests on the launch-time activate finding it shut',
    ).toBe(false);
  });

  it('opens once marked, and stays open', async () => {
    const gate = await import('../../src/main/startup-gate');
    gate.markStartupComplete();
    expect(gate.isStartupComplete()).toBe(true);
    gate.markStartupComplete();
    expect(gate.isStartupComplete()).toBe(true);
  });

  it('is fresh state per module instance', async () => {
    const first = await import('../../src/main/startup-gate');
    first.markStartupComplete();
    expect(first.isStartupComplete()).toBe(true);

    vi.resetModules();
    const second = await import('../../src/main/startup-gate');
    expect(
      second.isStartupComplete(),
      'a re-imported module must start closed again, or the tests above leak into each other',
    ).toBe(false);
  });
});

/**
 * The gate is only worth anything if index.ts actually reads it, and only SAFE
 * while nothing suspends between building the window and opening the gate.
 * Each scan below names the bug it prevents.
 */
describe('the startup gate is wired into src/main/index.ts', () => {
  it('routes the activate handler through the gate predicate', () => {
    // sliceCodeBetween rather than a fixed character budget: the file already
    // learned twice (see its own docblock) that a budget tuned to today's code
    // length silently stops covering the call once a comment or branch pushes
    // it out of the window.
    const handler = activateHandler();
    expect(
      handler,
      "src/main/index.ts must decide app.on('activate') with shouldCreateWindowOnActivate(...); an inline getAllWindows().length === 0 check alone is what raced ahead of IPC registration on a cold macOS launch (DESKTOP-3/4)",
    ).toContain('shouldCreateWindowOnActivate(');

    // Calling the predicate is not the same as obeying it. Matched as a pattern
    // rather than the literal `if (!shouldCreate) return;` so that renaming the
    // local does not fail a test that has nothing to say about its name.
    expect(
      /if \(!\w+\) return;/.test(handler),
      'the activate handler must ACT on the predicate: calling shouldCreateWindowOnActivate and then building the window regardless still contains the call, and is still the DESKTOP-3/4 race',
    ).toBe(true);

    // Calling the predicate with the wrong inputs is not the same as obeying
    // it either: hardcoding `startupComplete: true` (or feeding it a stale
    // local) keeps both assertions above green while fully reintroducing the
    // launch-time race, because the gate would then never actually close.
    expect(
      handler,
      'the activate handler must read the LIVE gate value via isStartupComplete(), not a literal or a cached local - anything else defeats the gate while leaving the predicate call and its `if (!...) return;` guard in place',
    ).toContain('startupComplete: isStartupComplete()');

    // Passing the gate is not the same as rebuilding through the shared helper.
    // The two counting tests below ("creates the window from exactly two call
    // sites" and "rebuilds the window from exactly two gated call sites") only
    // pin totals across the whole file; neither one names WHERE its two sites
    // are. The second-instance handler's own call is pinned directly (see
    // "gates the windowless-rebuild telemetry on non-darwin"), but nothing
    // previously named activate's. Moving this call out of activate (into a
    // bare createWindow(), or dropping it, or relocating it to some third,
    // untested site) would still leave both totals at 2 - `createWindow();`
    // stays bound to whenReady + the helper's own body regardless of who
    // calls the helper, and `rebuildMainWindow();` would just move from one
    // counted site to another - and every other assertion in this test green,
    // while the macOS dock click silently stopped rebuilding the window.
    expect(
      handler,
      'the activate handler must rebuild through rebuildMainWindow(), not createWindow() directly: rebuildMainWindow is what re-points the updater and announcements refs after a rebuild (see "rebuilds the window from exactly two gated call sites"), and calling createWindow() here instead would leave those two modules pointed at a destroyed window after every dock-click rebuild',
    ).toContain('rebuildMainWindow();');
  });

  it('creates the window from exactly two call sites', () => {
    // `const createWindow = () =>` is the definition and does not match.
    const callSites = INDEX_CODE.match(/createWindow\(\);/g) ?? [];
    expect(
      callSites.length,
      'createWindow() must be invoked from exactly two places - the whenReady body and rebuildMainWindow(). A third caller is a third chance to build a duplicate window, which the gate does not cover.',
    ).toBe(2);
  });

  /**
   * The sibling of the count above, and the reason that count is still worth
   * anything after DESKTOP-J added a second rebuild path.
   *
   * createWindow() does NOT re-point the updater and announcements window refs;
   * that pairing lives at the call site. Funnelling both rebuild paths through
   * one helper is what stops a new site from silently leaving those two modules
   * holding a destroyed window. But the helper also means the count above no
   * longer measures "how many things can rebuild the window" - so count the
   * helper's callers too, or a fourth rebuild path added through it would pass
   * both scans while being completely ungated.
   */
  it('rebuilds the window from exactly two gated call sites, both through the shared helper', () => {
    const rebuildSites = INDEX_CODE.match(/rebuildMainWindow\(\);/g) ?? [];
    expect(
      rebuildSites.length,
      'rebuildMainWindow() must be invoked from exactly two places - the gated activate handler and the gated second-instance handler. A third caller needs its own gate: createWindow only refuses a LIVE window, so an ungated rebuild during startup races IPC registration (DESKTOP-3/4) and one during shutdown resurrects the app mid-teardown.',
    ).toBe(2);

    // The helper has to be what re-points the two refs. Leaving either call at
    // the old activate site (or omitting it from the helper) puts the updater
    // and announcements modules back on a destroyed window after a rebuild,
    // which is the silent bug the extraction exists to prevent.
    const helper = sliceCodeBetween('const rebuildMainWindow = () => {', '\n};');
    expect(
      helper,
      'rebuildMainWindow() must call updateUpdaterWindow(...): without it the updater keeps pushing at the window that was just destroyed',
    ).toContain('updateUpdaterWindow(');
    expect(
      helper,
      'rebuildMainWindow() must call updateAnnouncementsWindow(...): without it the announcements changed-push keeps targeting the destroyed window',
    ).toContain('updateAnnouncementsWindow(');
    expect(
      helper,
      'rebuildMainWindow() must NOT call initUpdater/initAnnouncements - neither is idempotent, so a rebuild that re-inits double-registers their handlers and timers',
    ).not.toContain('initUpdater(');
  });

  it('wraps createWindow() in a try/finally inside rebuildMainWindow, so a throw cannot skip the re-point', () => {
    // The sibling of the whenReady finally scan below ('registers updater and
    // announcements from a finally'), for the OTHER call site that has to
    // re-point updater/announcements after a throwing createWindow. createWindow
    // can throw BELOW `new BrowserWindow` (the DESKTOP-3/4 database read, for
    // instance), which would otherwise leave the live rebuilt window with its
    // updater/announcements refs still pointed at the destroyed one.
    const helper = sliceCodeBetween('const rebuildMainWindow = () => {', '\n};');

    expect(
      helper,
      'rebuildMainWindow must call createWindow() from inside a try, followed by a `} finally {`: without it, a throw inside createWindow after loadURL leaves the re-point entirely skipped',
    ).toContain('} finally {');

    const tryIndex = helper.indexOf('try {');
    expect(tryIndex, 'no try block found in rebuildMainWindow').toBeGreaterThan(-1);
    const finallyIndex = helper.indexOf('} finally {');
    expect(
      helper.slice(tryIndex, finallyIndex),
      'createWindow() must be called INSIDE the try block the finally guards, or the finally protects nothing',
    ).toContain('createWindow();');

    const finallyBody = helper.slice(finallyIndex);
    expect(
      finallyBody,
      'updateUpdaterWindow must sit INSIDE the finally, not merely somewhere in rebuildMainWindow: placed before the try, a throwing createWindow would skip it entirely',
    ).toContain('updateUpdaterWindow(');
    expect(
      finallyBody,
      'updateAnnouncementsWindow must sit INSIDE the finally, for the same reason as updateUpdaterWindow',
    ).toContain('updateAnnouncementsWindow(');
  });

  it('opens the gate with no suspension point after creating the window', () => {
    // THE load-bearing assertion. createWindow() calls loadURL() internally, so
    // the renderer is already booting when it returns; only the absence of an
    // await between there and the gate/registrations guarantees the renderer
    // cannot invoke before initUpdater and initAnnouncements have run.
    const windowIndex = whenReadyCreateWindowIndex();
    expect(windowIndex, 'no createWindow() call site found').toBeGreaterThan(-1);

    const gateIndex = INDEX_SOURCE.indexOf('markStartupComplete();', windowIndex);
    expect(gateIndex, 'no markStartupComplete() call found after createWindow()').toBeGreaterThan(-1);

    const span = INDEX_SOURCE.slice(windowIndex, gateIndex);

    // Anchor check: markStartupComplete() appears twice (the in-body gate open
    // and the degraded-startup .catch escape hatch). Proving initAnnouncements
    // sits inside the span is what pins this to the in-body one deliberately,
    // rather than relying on the .catch happening to come later in the file.
    // Pin BOTH ends of the span. Containing only one registration call would
    // still pass if a future edit moved the other out of the block, and it is
    // the pair that has to sit inside it.
    expect(
      span,
      'the span measured must be the in-body startup sequence (it has to contain the initUpdater call), not the whenReady .catch escape hatch',
    ).toContain('initUpdater(');
    expect(
      span,
      'the span measured must be the in-body startup sequence (it has to contain the initAnnouncements call), not the whenReady .catch escape hatch',
    ).toContain('initAnnouncements(');

    expect(
      span.includes('await'),
      'nothing may await between createWindow() and markStartupComplete(): createWindow calls loadURL, so an await here lets the renderer mount and invoke announcements:get / announcements:getHistory before initAnnouncements registers them - exactly the DESKTOP-3/4 rejection, reintroduced from the whenReady path itself',
    ).toBe(false);
  });

  it('registers updater and announcements from a finally, so a THROW cannot skip them', () => {
    // The sibling of the await scan above, and the gap the Windows DESKTOP-3/4
    // event fell through on 2026-09-03. An await is not the only way to break
    // the "unbroken synchronous block": a THROW breaks it just as completely.
    //
    // What happened: createWindow() reaches getLastOpenedProject() BELOW its own
    // loadURL call, the global database threw SQLITE_IOERR (DESKTOP-9), and
    // initUpdater / initAnnouncements / markStartupComplete never ran. The
    // renderer was already loading, so its first invoke found no handler. The
    // await scan cannot see that, because no await was ever added.
    //
    // Anchored on `} finally {` rather than on brace-balancing, consistent with
    // this file's other exact-text anchors.
    const windowIndex = whenReadyCreateWindowIndex();
    const gateIndex = INDEX_SOURCE.indexOf('markStartupComplete();', windowIndex);
    const span = INDEX_SOURCE.slice(windowIndex, gateIndex);

    expect(
      span,
      'the in-body createWindow() call must be followed by a `} finally {`: without it, any throw inside createWindow after loadURL leaves a live renderer invoking announcements/updater channels that were never registered (the Windows DESKTOP-3/4 event)',
    ).toContain('} finally {');

    // The finally has to be the thing that CONTAINS the registrations, not
    // merely sit somewhere in the span. Slice from the finally to the gate open
    // and prove both calls are inside it.
    const finallyIndex = span.indexOf('} finally {');
    const finallyBody = span.slice(finallyIndex);
    expect(
      finallyBody,
      'initUpdater must sit INSIDE the finally. Leaving it before the try, or between the try and the finally, is the starvable ordering this test exists to reject.',
    ).toContain('initUpdater(');
    expect(
      finallyBody,
      'initAnnouncements must sit INSIDE the finally, for the same reason as initUpdater: it is the channel pair the renderer actually invoked with nobody listening.',
    ).toContain('initAnnouncements(');
  });

  it('opens the global database before it builds the window', () => {
    // Sentry DESKTOP-9/A/B. The first global-database touch used to be
    // getLastOpenedProject() inside createWindow, BELOW loadURL, with no guard
    // at all: a SQLITE_IOERR there produced an unhandled rejection, a renderer
    // holding a raw "Error invoking remote method" stack trace, and a startup
    // that carried on half-initialized. Proving the database readable first is
    // what turns that into a dialog naming the file.
    const gateIndex = INDEX_SOURCE.indexOf('await ensureGlobalDbReadable()');
    expect(
      gateIndex,
      'src/main/index.ts must await ensureGlobalDbReadable() during startup: without it a locked or failing index.db reaches the user as an unhandled rejection instead of a message naming the file (DESKTOP-9/A/B)',
    ).toBeGreaterThan(-1);

    const windowIndex = whenReadyCreateWindowIndex();
    expect(
      gateIndex,
      'the database check must run BEFORE createWindow(): once loadURL has fired, the renderer is already invoking channels, which is the whole failure this ordering prevents',
    ).toBeLessThan(windowIndex);

    // Calling it and ignoring the answer would leave startup walking into the
    // state the dialog just told the user is broken.
    //
    // app.exit, not app.quit: the user chose Quit before registerAllIpc ran, so
    // performShutdown's first act (reaching for the board config manager)
    // throws "IPC not initialized" and aborts the rest of the teardown. Verified
    // against a read-only index.db, which logged exactly that.
    const bail = sliceAfter('await ensureGlobalDbReadable()', 1400);
    expect(
      bail,
      'startup must ACT on ensureGlobalDbReadable(): a false answer is the user choosing Quit, and it has to stop the startup body rather than fall through into createWindow',
    ).toContain('app.exit(0);');
    expect(
      bail,
      'the give-up must still be counted. This whole cluster was noticed only because it reached Sentry as an unhandled rejection, so a gate that handles it silently trades one blind spot for another.',
    ).toContain("source: 'globalDbUnreadable'");
  });

  it('wraps every getLastOpenedProject() call site in softly(\'lastOpenedProject\', ...)', () => {
    // getLastOpenedProject() reads the global database, and this is the exact
    // line DESKTOP-9 threw from: a bare call, below loadURL, with nothing
    // between it and a SQLITE_IOERR. Comment-only mentions of the function name
    // (this file narrates it in two docblocks) are excluded first, so only real
    // call expressions are counted - otherwise the comments alone would inflate
    // the count and hide a missing wrapper.
    //
    // Counted rather than anchored on the two known call sites by exact text: a
    // THIRD call site added later that skips the wrapper must fail this test
    // even though the two existing sites keep passing.
    const codeSource = INDEX_SOURCE
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const callSites = codeSource.match(/getLastOpenedProject\(\)/g) ?? [];
    const softenedCallSites = codeSource.match(/softly\('lastOpenedProject'/g) ?? [];

    expect(
      callSites.length,
      'no getLastOpenedProject() call sites found in src/main/index.ts - has the function been renamed, or this scan\'s anchor gone stale?',
    ).toBeGreaterThan(0);
    expect(
      softenedCallSites.length,
      "every getLastOpenedProject() call in index.ts must be wrapped in softly('lastOpenedProject', ...): a bare call is what threw SQLITE_IOERR as an unhandled rejection in DESKTOP-9, and reintroducing even one unwrapped call site reopens it",
    ).toBe(callSites.length);
  });

  it('debounces the Sentry report but calls the user notification unconditionally, inside the global-db-failure notifier', () => {
    // This closure is registered via setGlobalDbFailureNotifier() entirely
    // inside app.whenReady().then(...), which makes top-level electron calls and
    // cannot be imported by a unit test - the same constraint the rest of this
    // file works around with a static scan.
    //
    // softly() invokes this notifier on EVERY notifying failure (the renderer
    // re-reads project:list on each project switch and HMR re-sync), but an
    // unreadable database is one standing condition, not one event per read.
    // reportHandledError must debounce to once per process behind
    // globalDbFailureReported, or a burst of duplicate Sentry events would fire
    // for a fault Sentry already has. notifyGlobalDbUnavailable owns its own
    // once-per-incident + re-arm-on-retry semantics (see
    // global-db-degradation.test.ts), so it must be called unconditionally:
    // gating it on the same one-shot flag would silence the user-facing dialog
    // after the very first failure even once a later Retry re-armed it.
    const guardMarker = 'if (!globalDbFailureReported) {';
    const guardStart = INDEX_SOURCE.indexOf(guardMarker);
    expect(guardStart, 'the debounce guard `if (!globalDbFailureReported)` was not found in src/main/index.ts').toBeGreaterThan(-1);

    // The guard's own closing brace is a newline followed by 4-space indent,
    // which is unambiguous here: the only other `}` between the guard opening
    // and its close belongs to reportHandledError's inline options object,
    // which closes on the SAME line it opens on and never starts a line of its
    // own at this indent.
    const guardCloseIndex = INDEX_SOURCE.indexOf('\n    }\n', guardStart);
    expect(guardCloseIndex, 'could not find the debounce guard\'s closing brace').toBeGreaterThan(guardStart);
    const guardBody = INDEX_SOURCE.slice(guardStart, guardCloseIndex);

    expect(
      guardBody,
      'reportHandledError must sit INSIDE the once-per-process guard: an unguarded call would send a burst of duplicate Sentry events for one standing condition every time softly() notifies',
    ).toContain('reportHandledError(');
    expect(
      guardBody,
      'notifyGlobalDbUnavailable must NOT be called inside the report guard: it has its own once-per-incident debounce with a re-arm on a successful Retry, and calling it here would double that semantics onto the wrong flag and silence the dialog after the very first failure',
    ).not.toContain('notifyGlobalDbUnavailable(');

    const afterGuard = INDEX_SOURCE.slice(guardCloseIndex, guardCloseIndex + 400);
    expect(
      afterGuard,
      'notifyGlobalDbUnavailable must still be called, unconditionally, after the report guard closes - otherwise a degraded read after the first Sentry report never reaches the user at all',
    ).toContain('notifyGlobalDbUnavailable(');
  });

  it('keeps the degraded-startup escape hatch that also opens the gate', () => {
    // A count scan, not a proximity regex: the whenReady body already contains
    // unrelated .catch( calls (pruneStaleWorktreeProjects,
    // sweepOrphanedBrowserPartitions), so a loose match can bind to the wrong
    // one and fail confusingly.
    const gateOpens = INDEX_SOURCE.match(/markStartupComplete\(\);/g) ?? [];
    expect(
      gateOpens.length,
      'markStartupComplete() must be called from exactly two places: the in-body gate open after initAnnouncements, and the whenReady .catch escape hatch. Without the catch, a synchronous throw early in startup (the fs writes before createWindow) leaves the gate shut forever and every dock click is a no-op - a dead icon instead of a recoverable window.',
    ).toBe(2);

    // The count alone does not prove either call is the escape hatch: moving
    // both into the try body satisfies it. Slice the .catch block marker to
    // marker (no fixed character budget, so comment growth cannot push the
    // call out of the window) and prove one of them lives inside it.
    const catchStart = INDEX_SOURCE.indexOf('}).catch((error) => {');
    expect(catchStart, 'no whenReady .catch escape hatch found in src/main/index.ts').toBeGreaterThan(-1);
    const catchEnd = INDEX_SOURCE.indexOf('\n});', catchStart);
    expect(catchEnd, 'the whenReady .catch block is never closed at column 0').toBeGreaterThan(catchStart);

    const catchBody = INDEX_SOURCE.slice(catchStart, catchEnd);
    expect(
      catchBody,
      'one markStartupComplete() must sit INSIDE the whenReady .catch. A startup throw that leaves the gate shut strands the user on a dock icon that opens nothing, which is the failure this escape hatch exists to prevent.',
    ).toContain('markStartupComplete();');

    // Presence inside the catch is not enough: the call must be UNCONDITIONAL.
    // The catch already contains an `if (!isShuttingDown())` around the
    // analytics report, and it would be an easy edit to tuck the gate open
    // inside it, or to add some other "only reopen on a real failure" guard.
    // Any of those makes recovery conditional on a predicate that has nothing
    // to do with whether the user can still open a window. Anchored on the
    // 2-space indentation of the catch body's own top level rather than by
    // brace-balancing, consistent with this file's other exact-text anchors.
    // Newline-anchored, so it holds under a CRLF checkout too.
    expect(
      catchBody,
      'markStartupComplete() must sit at the TOP LEVEL of the .catch body, not nested inside its isShuttingDown reporting guard or any other condition: the escape hatch has to reopen the gate on every startup failure, or a dock click opens nothing',
    ).toContain('\n  markStartupComplete();');
  });

  it('checks that the MCP handle settled before registering IPC', () => {
    expect(
      sliceAfter('if (!mcpServerSettled) {', 600),
      'the mcpServerSettled check must sit immediately before registerAllIpc(...): mcpServerHandle is null both before startup decides and after it fails, so only the flag distinguishes an unresolved handle from a deliberate one',
    ).toContain('registerAllIpc(');
  });

  it('settles the MCP flag on both the success and failure paths', () => {
    expect(
      INDEX_SOURCE.includes('mcpServerSettled = true;'),
      'mcpServerSettled must be set after the startMcpHttpServer try/catch so a swallowed failure still counts as settled; setting it only inside the try leaves the failure path indistinguishable from "startup has not run yet"',
    ).toBe(true);
  });

  /**
   * The DESKTOP-J wiring. The predicate above is only worth anything if the
   * handler actually asks it, feeds it live values, and obeys the answer.
   */
  it('decides second-instance through the predicate, on live inputs', () => {
    const handler = secondInstanceHandler();

    expect(
      handler,
      "the second-instance handler must decide through decideSecondInstanceAction(...); a bare `if (mainWindow)` is the DESKTOP-J crash itself",
    ).toContain('decideSecondInstanceAction(');

    // Hardcoding either input keeps the call in place while defeating it
    // entirely - the same failure mode the activate scan above guards against.
    expect(
      handler,
      'the handler must read the LIVE shutdown flag via isShuttingDown(), not a literal: during the before-quit drain the window is hidden but not destroyed, so a stale `false` here would raise an app that is mid-teardown',
    ).toContain('shuttingDown: isShuttingDown()');
    expect(
      handler,
      'the handler must read the LIVE gate via isStartupComplete(), not a literal, or a second launch during startup rebuilds a window that races IPC registration (DESKTOP-3/4)',
    ).toContain('startupComplete: isStartupComplete()');

    expect(
      /if \(action === 'ignore'\) return;/.test(handler),
      "the handler must ACT on the predicate: computing an action and then focusing regardless still contains the call and is still the crash",
    ).toBe(true);
  });

  it('computes hasLiveWindow with isDestroyed, never bare truthiness', () => {
    // THE assertion that pins DESKTOP-J shut. mainWindow is non-null and
    // DESTROYED for the whole window between 'closed' and the process exiting,
    // so `Boolean(mainWindow)` alone is exactly the check that threw.
    const handler = secondInstanceHandler();
    expect(
      handler,
      'hasLiveWindow must be computed as `mainWindow && !mainWindow.isDestroyed()`. A bare truthiness check passes on a destroyed window and then throws "Object has been destroyed" on isMinimized() - which is Sentry DESKTOP-J.',
    ).toContain('hasLiveWindow: Boolean(mainWindow && !mainWindow.isDestroyed())');
  });

  it('shows a hidden-but-live window instead of only focusing it', () => {
    // The window is built with `show: false` and only shown from
    // 'ready-to-show', so for the first seconds of a cold start it is live and
    // invisible - and markStartupComplete() has already run by then, so a
    // second launch lands squarely in the focus branch. focus() on an
    // invisible window does nothing the user can see.
    const handler = secondInstanceHandler();
    // Pinned as one string, guard and action together: a bare
    // `.toContain('isVisible()')` also passes for an INVERTED guard
    // (`if (mainWindow!.isVisible()) mainWindow!.show();`), which calls
    // show() only on a window that is already visible and does nothing at
    // all for the hidden-but-live case this test exists to cover.
    expect(
      handler,
      "the focus branch must show() a hidden-but-live window via `if (!mainWindow!.isVisible()) mainWindow!.show();`. Between `new BrowserWindow({ show: false })` and 'ready-to-show' the window is live and invisible, so focus() alone - or a show() gated on the OPPOSITE of this check - makes the user's second launch do nothing at all: the same dead outcome as the crash, minus the Sentry event.",
    ).toContain('if (!mainWindow!.isVisible()) mainWindow!.show();');
  });

  it('counts the windowless rebuild instead of recovering from it silently', () => {
    // Reaching the rebuild branch means a browser lane survived the 'closed'
    // sweep and left a windowless zombie holding the single-instance lock.
    // Handling that silently would trade a visible fatal for an invisible leak,
    // which is the trade the ensureGlobalDbReadable scan above also refuses.
    // A wider budget than the sibling scans above: the telemetry sits in the
    // LAST branch of the handler, after both early returns.
    const handler = secondInstanceHandler();
    expect(
      handler,
      'the rebuild branch must report source: \'secondInstanceNoWindow\'. Without it the fix converts a Sentry-visible crash into a silent recovery and destroys the only signal for the lane leak underneath it.',
    ).toContain("source: 'secondInstanceNoWindow'");
  });

  it('gates the windowless-rebuild telemetry on non-darwin, but always rebuilds regardless of platform', () => {
    // On macOS, an app alive with zero windows is the documented lifecycle
    // (window-all-closed only quits when platform !== 'darwin'), so reporting
    // it as app_error there would bury the real lane-leak signal Windows/Linux
    // rely on. The rebuild itself must stay unconditional - a macOS dock
    // relaunch still has to bring the window back.
    const handler = secondInstanceHandler();

    const guardMarker = "if (process.platform !== 'darwin') {";
    const guardStart = handler.indexOf(guardMarker);
    expect(
      guardStart,
      "the rebuild branch must guard its telemetry on process.platform !== 'darwin': without it, the ordinary macOS lifecycle (window closed, app still running) reports as an app_error and buries the real Windows/Linux lane-leak signal under noise",
    ).toBeGreaterThan(-1);

    // The guard's own closing brace: newline, 6-space indent (matching the
    // guard's own opening indent), closing brace. No trailing-newline
    // requirement, since the guard's close can legitimately be the LAST line
    // of the sliced handler (sliceCodeBetween excludes the newline before its
    // end marker). Unambiguous within this handler regardless: the trackEvent
    // call it contains closes its inline options object at 8-space indent, a
    // different level that this 6-space anchor cannot match mid-line.
    const guardCloseIndex = handler.indexOf('\n      }', guardStart);
    expect(guardCloseIndex, "could not find the non-darwin guard's own closing brace").toBeGreaterThan(guardStart);
    const guardBody = handler.slice(guardStart, guardCloseIndex);

    expect(
      guardBody,
      'trackEvent must sit INSIDE the non-darwin guard. Moving it outside would report app_error on every platform, including the ordinary macOS case where nothing is wrong',
    ).toContain("trackEvent('app_error', {");

    const afterGuard = handler.slice(guardCloseIndex);
    expect(
      afterGuard,
      'rebuildMainWindow() must sit OUTSIDE (after) the non-darwin guard, so the rebuild itself stays unconditional. Moving it inside the guard would leave macOS unable to recover its window from this branch at all',
    ).toContain('rebuildMainWindow();');
  });

  it('nulls mainWindow when the window closes', () => {
    // The root cause. Every bare `if (mainWindow)` in index.ts (the
    // second-instance handler, and the did-finish-load setTitle and
    // PROJECT_AUTO_OPENED sends) is only correct because of this assignment.
    const closedHandler = sliceCodeBetween("mainWindow.on('closed', () => {", '\n  });');
    expect(
      closedHandler,
      "the 'closed' handler must set mainWindow = null. Leaving a destroyed BrowserWindow in the variable is the root cause of DESKTOP-J: it makes every truthiness check in the file pass and then throw on first use.",
    ).toContain('mainWindow = null;');

    // Presence of `mainWindow = null;` is not the whole guarantee: the null-out
    // must be identity-checked against createdWindow (this window's own
    // capture), not unconditional. An unconditional `mainWindow = null` would
    // still contain the substring above and pass that assertion, while blanking
    // a freshly REBUILT window: 'closed' fires whenever ANY window (including a
    // stale one from before a rebuild) is destroyed, and only the identity
    // check makes a closing window clear ONLY its own reference.
    expect(
      closedHandler,
      'the null-out must be identity-checked with `if (mainWindow === createdWindow) mainWindow = null;`, not an unconditional `mainWindow = null;`. Electron fires \'closed\' on destroy, and an unconditional null-out would blank a freshly rebuilt window if a stale handler from a prior window ever fired after it',
    ).toContain('if (mainWindow === createdWindow) mainWindow = null;');
  });

  it('attaches the Windows session-end hook per window, not once at startup', () => {
    // Attached in the whenReady body, a REBUILT window (activate, or a
    // second-instance that found none) gets no session-end hook at all. A later
    // Windows logout then leaves osInitiatedShutdown false, and the before-quit
    // drain holds the quit during an OS shutdown - the one case
    // .claude/rules/synchronous-shutdown.md says it never holds.
    const windowIndex = INDEX_SOURCE.indexOf('const createWindow = () => {');
    const createWindowEnd = INDEX_SOURCE.indexOf('const rebuildMainWindow = () => {');
    expect(createWindowEnd, 'rebuildMainWindow must be defined after createWindow').toBeGreaterThan(windowIndex);

    // Asserted as a boolean rather than with toContain, so a failure prints
    // "expected false to be true" instead of dumping the whole 450-line
    // createWindow body into the CI log - the same reason sliceAfter exists.
    const createWindowBody = INDEX_SOURCE.slice(windowIndex, createWindowEnd);
    expect(
      createWindowBody.includes("on('session-end'"),
      "the Windows 'session-end' listener must be attached INSIDE createWindow, so every window built gets it. Attached once in the whenReady body, a rebuilt window has no OS-shutdown hook and a logout leaves osInitiatedShutdown false, which makes the before-quit drain hold an OS-initiated quit.",
    ).toBe(true);
  });

  it('guards createWindow against building a second live window', () => {
    expect(
      INDEX_SOURCE.includes('mainWindow && !mainWindow.isDestroyed()'),
      'createWindow() must bail when a live mainWindow already exists. A second BrowserWindow orphans the first; the orphan holds getAllWindows() above zero, so window-all-closed never fires, before-quit never runs, and syncShutdownCleanup never kills PTYs, suspends session records, or closes DBs.',
    ).toBe(true);

    // Presence of the condition is not the guard. Anchored on the guard's own
    // telemetry source, which is unique in the file: the bare condition text
    // appears three times, because two IPC broadcast guards share its shape.
    expect(
      sliceAfter("source: 'duplicateCreateWindow'", 200),
      'the duplicate-window guard must RETURN, not merely report. A log-only branch falls straight through and builds the second BrowserWindow anyway, which is the orphan described above.',
    ).toContain('return;');
  });

  it('sends both post-await pushes through the captured createdWindow, isDestroyed-guarded, never the module-level mainWindow', () => {
    // The two pushes that resume AFTER an await: PROJECT_PATH_MISSING (in the
    // preload IIFE's catch) and PROJECT_AUTO_OPENED (in did-finish-load, after
    // `await preloadPromise`). Reading the module-level mainWindow here would
    // let a close-then-rebuild during the await redirect the old launch's push
    // into the NEW window's renderer, which is running its own preload and
    // will announce its own result. createdWindow is captured once, at
    // construction, so it always names the window THIS createWindow() call
    // built - and each send is guarded by isDestroyed() because sending into a
    // destroyed window throws.
    const pathMissingGuardMarker = 'err.message.includes(PROJECT_PATH_MISSING_PREFIX) && !createdWindow.isDestroyed())';
    const pathMissingGuardIndex = INDEX_CODE.indexOf(pathMissingGuardMarker);
    expect(
      pathMissingGuardIndex,
      'the PROJECT_PATH_MISSING branch must guard on !createdWindow.isDestroyed(), not merely on the error type: sending into a destroyed window throws',
    ).toBeGreaterThan(-1);

    const pathMissingSend = 'createdWindow.webContents.send(IPC.PROJECT_PATH_MISSING';
    const pathMissingSendIndex = INDEX_CODE.indexOf(pathMissingSend, pathMissingGuardIndex);
    expect(
      pathMissingSendIndex,
      'PROJECT_PATH_MISSING must be sent via createdWindow, the per-window capture - not the module-level mainWindow, which could have been nulled by \'closed\' and reassigned by a rebuild during this catch\'s own awaits',
    ).toBeGreaterThan(-1);

    const pathMissingSpan = INDEX_CODE.slice(pathMissingGuardIndex, pathMissingSendIndex + pathMissingSend.length);
    expect(
      pathMissingSpan.includes('mainWindow'),
      'nothing in the PROJECT_PATH_MISSING branch may read the module-level mainWindow: this catch resumes after the preload IIFE\'s own awaits, so mainWindow could have been reassigned by a rebuild in the meantime, redirecting the push into the wrong renderer',
    ).toBe(false);

    // PROJECT_AUTO_OPENED. Scoped to the span starting at `await
    // preloadPromise;` so the SYNCHRONOUS setTitle just above it (which
    // deliberately still reads mainWindow - it means "is there a current
    // window at all", not "which window did this listener attach to") cannot
    // make this scan pass or fail for the wrong reason.
    const awaitPreloadIndex = INDEX_CODE.indexOf('await preloadPromise;');
    expect(awaitPreloadIndex, 'no `await preloadPromise;` found in did-finish-load').toBeGreaterThan(-1);

    const autoOpenedGuardMarker = 'if (project && !createdWindow.isDestroyed()) {';
    const autoOpenedGuardIndex = INDEX_CODE.indexOf(autoOpenedGuardMarker, awaitPreloadIndex);
    expect(
      autoOpenedGuardIndex,
      'the PROJECT_AUTO_OPENED send must guard on !createdWindow.isDestroyed(): the same close-then-rebuild race, one line after the await',
    ).toBeGreaterThan(-1);

    const autoOpenedSend = 'createdWindow.webContents.send(IPC.PROJECT_AUTO_OPENED';
    const autoOpenedSendIndex = INDEX_CODE.indexOf(autoOpenedSend, autoOpenedGuardIndex);
    expect(
      autoOpenedSendIndex,
      'PROJECT_AUTO_OPENED must be sent via createdWindow, not mainWindow',
    ).toBeGreaterThan(-1);

    const postAwaitSpan = INDEX_CODE.slice(awaitPreloadIndex, autoOpenedSendIndex + autoOpenedSend.length);
    expect(
      postAwaitSpan.includes('mainWindow'),
      'nothing between `await preloadPromise;` and the PROJECT_AUTO_OPENED send may read the module-level mainWindow: this send resumes after an await, so mainWindow could have been nulled by \'closed\' and reassigned by a rebuild in the meantime, redirecting the push into the wrong renderer',
    ).toBe(false);
  });
});
