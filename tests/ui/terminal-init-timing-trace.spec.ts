/**
 * UI test for the `init-timing` renderer trace event `initTerminal` emits
 * (see the top of `initTerminal` in `src/renderer/hooks/useTerminal.ts`).
 *
 * Mirrors `window-reveal-grid-width.spec.ts`'s pattern: drive a REAL mounted
 * xterm through a session-backed task-detail open, and read the outcome off
 * `window.__kangenticTerminalTrace` rather than off terminal content (which a
 * timing event has none of).
 *
 * A session-backed task-detail open reliably produces TWO mount cycles here,
 * not one: the bottom panel auto-mounts a terminal for the project's sole
 * running session as soon as the board loads (useFocusedSessionsSync), then
 * disposes it on the ownership handoff to the dialog's own mount. That is
 * exactly why the invariants below are expressed as ratios/per-cycle checks
 * rather than fixed counts - do not "simplify" them to `=== 1`.
 *
 * Per the rule against asserting timing VALUES (cross-platform-parity.md),
 * every assertion here is structural: event presence, event counts relative
 * to another event, the `branch` discriminant, key presence, finiteness, an
 * arithmetic relationship with tolerance, and runtime ring ORDER. No ms value
 * is ever compared to a number.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-init-timing-trace';
const TASK_ID = 'task-init-timing-trace';
const SESSION_ID = 'sess-init-timing-trace';
const TASK_TITLE = 'Init Timing Trace Task';

// Named once so the red-green check (see the report) is a single-line toggle:
// pointing this at an event name the code never emits must turn every
// invariant below red, because they all key off this constant rather than a
// literal string repeated three times.
const INIT_TIMING_EVENT = 'init-timing';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Init Timing Trace Test',
      path: '/mock/init-timing-trace-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so the task-detail window opens with a live,
    // session-backed terminal (initTerminal's 'session' branch).
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/init-timing-trace-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: '${TASK_TITLE}',
      description: 'Task used to verify the init-timing renderer trace event',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/init-timing-trace',
      branch_name: 'feature/init-timing-trace',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

// Patches getFirstOutput/getScrollback BEFORE the app boots (a separate
// addInitScript, run after MOCK_SCRIPT has defined window.electronAPI), so
// EVERY terminal that mounts for this session - not just the one this spec
// opens deliberately - sees a ready overlay and a non-empty scrollback from
// its very first render.
//
// This matters because a running session's bottom-panel TerminalTab mounts
// automatically as soon as the board loads (useFocusedSessionsSync), before
// this spec ever clicks the task card. A runtime page.evaluate() override
// applied after that mount is too late: it races the bottom panel's own
// mount-time overlay/scrollback read and loses, so that mount's replay stays
// suppressed and its scrollback stays empty (no replay-write). Patching at
// addInitScript time removes the race instead of trying to win it.
const overridePreConfig = `
  (function () {
    window.__scrollbackValue = 'INIT-TIMING-TRACE-FRAME\\r\\n';
    if (window.electronAPI && window.electronAPI.sessions) {
      window.electronAPI.sessions.getScrollback = function () {
        return Promise.resolve(window.__scrollbackValue || '');
      };
      window.electronAPI.sessions.getFirstOutput = function () {
        var result = {};
        result['${SESSION_ID}'] = true;
        return Promise.resolve(result);
      };
    }
  })();
`;

interface RendererTraceEvent {
  ts: number;
  sessionId: string | null;
  event: string;
  detail?: Record<string, unknown>;
}

interface TestWindow {
  __kangenticTerminalTrace?: () => RendererTraceEvent[];
}

async function launchWithPreConfig(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(overridePreConfig);
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function readTrace(page: Page): Promise<RendererTraceEvent[]> {
  return page.evaluate((sessionId) => {
    const read = (window as unknown as TestWindow).__kangenticTerminalTrace;
    if (typeof read !== 'function') return [];
    return read().filter((entry) => entry.sessionId === sessionId);
  }, SESSION_ID);
}

test.describe('Terminal init-timing renderer trace', () => {
  test('a session-backed mount emits a paired, consistent, correctly ordered init-timing event per mount cycle', async () => {
    // Same cold-start cost the sibling grid-width spec documented needing
    // headroom for: one full Electron-less renderer boot plus a real
    // mount-time scrollback replay. ~2s unloaded; the margin is for a loaded
    // CI shard, not for slowness in this test.
    test.slow();
    const { browser, page } = await launchWithPreConfig(preConfig);
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      await page
        .locator('[data-swimlane-name="Code Review"]')
        .locator(`text=${TASK_TITLE}`)
        .first()
        .click();
      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await dialog.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 10000 });

      // Wait for the mount replay to finish. replay-write always lands on the
      // ring strictly before replay-done (same .then() callback, replay-write
      // fires before the chunked write that leads to replay-done even starts),
      // so once replay-done is present, replay-write is guaranteed to be too.
      await expect
        .poll(async () => (await readTrace(page)).filter((entry) => entry.event === 'replay-done').length, {
          timeout: 15000,
        })
        .toBeGreaterThan(0);

      const trace = await readTrace(page);

      // Named setup check, so a broken getFirstOutput/getScrollback override
      // fails here with a clear reason instead of surfacing as an opaque
      // invariant-3 failure below. At least one mount-triggered replay must
      // have run unsuppressed - the dialog's own mount is the one this spec
      // opens deliberately, but an earlier bottom-panel mount (auto-focused
      // as soon as the board loads) may also have one, since the override is
      // installed before either mounts.
      const mountReplayStarts = trace.filter(
        (entry) => entry.event === 'replay-start' && entry.detail?.trigger === 'mount',
      );
      expect(mountReplayStarts.length, 'no replay-start recorded for any mount').toBeGreaterThan(0);
      expect(
        mountReplayStarts.some((entry) => entry.detail?.suppressed === false),
        'every mount replay was suppressed, so the scrollback override never ran and replay-write cannot have '
        + `fired - check the getFirstOutput / getScrollback addInitScript override. suppressed flags: `
        + `${JSON.stringify(mountReplayStarts.map((entry) => entry.detail?.suppressed))}`,
      ).toBe(true);

      const events = trace.map((entry) => entry.event);
      const mountEvents = trace.filter((entry) => entry.event === 'mount');
      const initTimingEvents = trace.filter((entry) => entry.event === INIT_TIMING_EVENT);

      // INVARIANT 1: emission + branch discriminant. Paired 1:1 with 'mount',
      // NOT asserted === 1 - a task-detail open/close pays init twice per the
      // comment above traceInitTiming in useTerminal.ts (once per ownership
      // handoff), so the correct invariant is the ratio between the two
      // events, not a fixed count.
      expect(mountEvents.length, `no terminal mounted for this session. trace: ${JSON.stringify(events)}`).toBeGreaterThan(0);
      expect(
        initTimingEvents.length,
        `init-timing count (${initTimingEvents.length}) did not match mount count (${mountEvents.length}). `
        + `trace: ${JSON.stringify(events)}`,
      ).toBe(mountEvents.length);
      for (const entry of initTimingEvents) {
        expect(entry.detail?.branch, 'a session-backed mount must report the session branch').toBe('session');
      }

      // INVARIANT 2: payload consistency, checked on every init-timing entry
      // this mount produced.
      const NUMERIC_KEYS = [
        'constructMs', 'webglMs', 'fitMs', 'reusableMs', 'syncTotalMs', 'startedAtMs', 'endedAtMs',
      ] as const;
      for (const entry of initTimingEvents) {
        for (const key of NUMERIC_KEYS) {
          const value = entry.detail?.[key];
          expect(typeof value, `${key} missing or not a number: ${JSON.stringify(entry.detail)}`).toBe('number');
          expect(Number.isFinite(value as number), `${key} is not finite: ${JSON.stringify(entry.detail)}`).toBe(true);
        }
        const constructMs = entry.detail?.constructMs as number;
        const webglMs = entry.detail?.webglMs as number;
        const reusableMs = entry.detail?.reusableMs as number;
        // Tolerance, never exact equality: constructMs/webglMs/reusableMs are
        // each rounded to 0.1ms independently, so the sum can drift from the
        // reported field by up to one rounding unit (worst case is exactly
        // 0.1ms; 0.11 gives float slack over that, no more).
        expect(
          Math.abs(reusableMs - (constructMs + webglMs)),
          `reusableMs (${reusableMs}) should be constructMs + webglMs (${constructMs + webglMs}) within a rounding unit`,
        ).toBeLessThanOrEqual(0.11);
        // The clock domain the code's own comment calls load-bearing for the
        // LoAF join: performance.now() is page-relative and stays well under
        // 1e11 for any realistic session; Date.now() is ~1.7e12. A swap from
        // one clock to the other fails this loudly instead of silently
        // breaking the join.
        expect(
          entry.detail?.startedAtMs as number,
          'startedAtMs looks like a Date.now() epoch, not performance.now() - the LoAF join would silently break',
        ).toBeLessThan(1e11);
      }

      // INVARIANT 3: syncTotalMs excludes the async replay write - the ring
      // must record init-timing BEFORE replay-write, for the SAME mount. A
      // source-order scan would get this backwards (writeChunkedToTerminal
      // appears earlier in the file than traceInitTiming('session')); only
      // the RUNTIME ring order is correct, because init-timing fires
      // synchronously as the last statement of a mount's synchronous body,
      // while that same mount's replay-write only fires after its
      // getScrollback IPC round-trip resolves - which cannot happen until
      // the synchronous stack that produced its init-timing has finished.
      //
      // This must be checked PER MOUNT CYCLE, not with one global indexOf
      // pair: mount cycle 1's replay-write/replay-done can land on the ring
      // BEFORE mount cycle 2's own mount/init-timing even fires (confirmed
      // against a captured trace here), so a single global
      // indexOf('init-timing') < indexOf('replay-write') check would only
      // ever exercise the first cycle and pass vacuously for the rest.
      const mountIndices: number[] = [];
      events.forEach((event, index) => {
        if (event === 'mount') mountIndices.push(index);
      });
      let sawAnyReplayWrite = false;
      mountIndices.forEach((segmentStart, cycleIndex) => {
        const segmentEnd = cycleIndex + 1 < mountIndices.length ? mountIndices[cycleIndex + 1] : events.length;
        const segment = events.slice(segmentStart, segmentEnd);
        const initTimingAt = segment.indexOf(INIT_TIMING_EVENT);
        expect(
          initTimingAt,
          `mount cycle at ring index ${segmentStart} produced no init-timing. segment: ${JSON.stringify(segment)}`,
        ).toBeGreaterThan(-1);
        const replayWriteAt = segment.indexOf('replay-write');
        if (replayWriteAt === -1) return;
        sawAnyReplayWrite = true;
        expect(
          initTimingAt,
          `mount cycle at ring index ${segmentStart}: init-timing (segment offset ${initTimingAt}) must precede `
          + `replay-write (segment offset ${replayWriteAt}). segment: ${JSON.stringify(segment)}`,
        ).toBeLessThan(replayWriteAt);
      });
      expect(
        sawAnyReplayWrite,
        `no mount cycle produced a replay-write, so ordering was never checked. trace: ${JSON.stringify(events)}`,
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
