/**
 * Guards the two subscription gates in
 * `src/renderer/window-manager/bridge/useWindowSessionClaims.ts`.
 *
 * That effect re-derives `dialogSessionIds` - the renderer-global "which sessions
 * do open detail windows own" set, which decides whether the bottom panel mounts
 * its own xterm AND whether main streams a session's PTY bytes at all. It has to
 * stay correct, and it also sits on two of the hottest notification paths in the
 * renderer, so both gates below are load-bearing in opposite directions:
 *
 *   - Too loose and it runs an O(windows x sessions) cross-layer scan on every
 *     usage report, activity change and telemetry event (several times a second
 *     per running agent), and on every committed geometry frame of a window drag,
 *     which lands on the pointer-move thread.
 *   - Too tight and the self-healing this module exists for stops working. Gating
 *     the session-store subscription on `sessions` alone is the tempting mistake:
 *     it looks sufficient (only `sessions` can change which session an anchor
 *     resolves to) but it silences the exact case the file was written for, where
 *     something resets `dialogSessionIds` out from under the open windows and the
 *     windows do not re-claim on their own.
 *
 * These are static scans because the unit tier runs on plain Node with no DOM, so
 * the effect cannot be mounted here. The behavioral coverage of the claim set
 * itself lives in `tests/ui/agent-monitor.spec.ts` (a monitor detail claims its
 * session; closing the monitor releases it).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_PATH = 'src/renderer/window-manager/bridge/useWindowSessionClaims.ts';

/** Strip comments so the prose explaining a gate cannot satisfy a scan for it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const source = stripComments(fs.readFileSync(path.join(REPO_ROOT, SOURCE_PATH), 'utf-8'));

describe('useWindowSessionClaims subscription gates', () => {
  it('gates the session-store subscription on a previous-state comparison', () => {
    // A bare `useSessionStore.subscribe(reconcile)` fires on every write to the
    // store, including the per-session record maps that cannot change the answer.
    expect(
      /useSessionStore\.subscribe\(\s*\(\s*state\s*,\s*previous/.test(source),
      `${SOURCE_PATH} subscribes to the session store without a (state, previous) `
      + 'comparison. Every usage report, activity change and telemetry event writes '
      + 'to that store, so an ungated listener runs the full cross-layer claim scan '
      + 'several times a second per running agent.',
    ).toBe(true);
  });

  it('reconciles on BOTH sessions and dialogSessionIds identity', () => {
    // Extract just the session-store listener so an unrelated mention of either
    // field elsewhere in the file cannot satisfy this.
    const listener = source.slice(source.indexOf('useSessionStore.subscribe('));

    expect(
      /state\.sessions\s*===\s*previous\.sessions/.test(listener),
      `${SOURCE_PATH} must reconcile when the sessions array identity changes: that `
      + "is what decides which session a window's anchor resolves to.",
    ).toBe(true);

    expect(
      /state\.dialogSessionIds\s*===\s*previous\.dialogSessionIds/.test(listener),
      `${SOURCE_PATH} must ALSO reconcile when dialogSessionIds changes. Gating on `
      + 'sessions alone looks sufficient but silences the self-healing this module '
      + 'exists for: when something clobbers dialogSessionIds out from under the open '
      + 'windows, the windows do not re-claim on their own and their sessions drop '
      + 'out of the focused set, so main stops streaming their PTY bytes.',
    ).toBe(true);
  });

  it('does not pass the raw reconcile to the window stores', () => {
    // Window stores fire on every committed frame of a drag or resize, and geometry
    // cannot change which session is claimed.
    expect(
      /manager\.store\.subscribe\(\s*reconcile\s*[,)]/.test(source),
      `${SOURCE_PATH} subscribes the raw reconcile to a window store. Those fire on `
      + 'every committed geometry frame of a drag, so the O(windows x sessions) scan '
      + 'runs on the pointer-move thread. Route it through the fingerprint gate.',
    ).toBe(false);
  });

  it('still reconciles on a layer mount or unmount', () => {
    // A layer mounting or unmounting changes which windows count toward the claim
    // set without touching any store, so it cannot be folded into the gates above.
    expect(
      /subscribeLayerMounts\(/.test(source),
      `${SOURCE_PATH} must keep its layer-mount subscription: an unmounted layer has `
      + 'no xterm, and that transition changes the claim set without any store write.',
    ).toBe(true);
  });
});
