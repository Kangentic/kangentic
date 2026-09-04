/**
 * Unit tests for the startup gate (src/main/startup-gate.ts) and its wiring
 * into src/main/index.ts.
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

import { shouldCreateWindowOnActivate } from '../../src/main/startup-gate';

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
    // Anchored on the full call, not just "app.on('activate'": an unrelated
    // comment upstream mentions the event by name, and indexOf finds that first.
    const handler = sliceAfter("app.on('activate', () => {", 400);
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
  });

  it('creates the window from exactly two call sites', () => {
    // `const createWindow = () =>` is the definition and does not match.
    const callSites = INDEX_SOURCE.match(/createWindow\(\);/g) ?? [];
    expect(
      callSites.length,
      'createWindow() must be invoked from exactly two places - the whenReady body and the gated activate handler. A third caller is a third chance to build a duplicate window, which the gate does not cover.',
    ).toBe(2);
  });

  it('opens the gate with no suspension point after creating the window', () => {
    // THE load-bearing assertion. createWindow() calls loadURL() internally, so
    // the renderer is already booting when it returns; only the absence of an
    // await between there and the gate/registrations guarantees the renderer
    // cannot invoke before initUpdater and initAnnouncements have run.
    const windowIndex = INDEX_SOURCE.indexOf('createWindow();');
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

    expect(
      INDEX_SOURCE.slice(catchStart, catchEnd),
      'one markStartupComplete() must sit INSIDE the whenReady .catch. A startup throw that leaves the gate shut strands the user on a dock icon that opens nothing, which is the failure this escape hatch exists to prevent.',
    ).toContain('markStartupComplete();');
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
});
