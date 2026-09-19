/**
 * The mobile bridge's sleep/wake recovery wiring inside `app.whenReady()` in
 * `src/main/index.ts`: powerMonitor's 'resume' event redials or probes every
 * roster session (`MobileBridgeService.resumeAllSessions`), and
 * 'unlock-screen' sends one presence probe
 * (`MobileBridgeService.probeAllPresence`). Both methods' own behavior
 * (fan-out, logging, the no-session no-op) are unit tested directly in
 * tests/unit/mobile-bridge/mobile-bridge-session-lifecycle.test.ts; this file
 * only pins that index.ts wires the right powerMonitor event to the right
 * method, with the right reason string, and that the two registrations are
 * not accidentally swapped.
 *
 * `src/main/index.ts` makes top-level `electron` calls and cannot be
 * imported by a unit test, so this is a static source scan, the same
 * constraint and approach as `tests/unit/before-quit-drain-wiring.test.ts`
 * and `tests/unit/gpu-escalation-report-wiring.test.ts`.
 *
 * Tier: Unit.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

/**
 * index.ts with comment-only lines removed, so a `toContain` / `not.toContain`
 * check cannot be satisfied by prose that merely discusses the code. The
 * 12-line comment above the two registrations narrates both event names and
 * both method names ("an unlock is only a hint, so it sends one presence
 * probe", "'resume' also fires..."), which would otherwise let every
 * assertion below pass whether or not the real call is there. Same
 * JSDoc-body exclusion as tests/unit/gpu-escalation-report-wiring.test.ts's
 * INDEX_CODE.
 */
const INDEX_CODE = INDEX_SOURCE
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    const isJsDocBody = trimmed === '*' || trimmed.startsWith('* ') || trimmed.startsWith('*/');
    return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !isJsDocBody;
  })
  .join('\n');

/**
 * Slices from the `powerMonitor.on('<eventName>', ...)` call through its own
 * closing `});`, in the comment-stripped source. Both registrations are a
 * single statement with no nested object literal or callback of their own,
 * so the fixed `});` close (rather than the balanced-brace slicer the
 * sibling wiring tests use for a more complex handler body) is enough to
 * bound each region without spilling into the next registration.
 */
function powerMonitorRegistration(eventName: string): string {
  const start = INDEX_CODE.indexOf(`powerMonitor.on('${eventName}'`);
  if (start === -1) {
    throw new Error(`src/main/index.ts no longer registers powerMonitor.on('${eventName}', ...)`);
  }
  const end = INDEX_CODE.indexOf('});', start);
  if (end === -1) {
    throw new Error(`the powerMonitor.on('${eventName}', ...) registration must close with '});'`);
  }
  return INDEX_CODE.slice(start, end + 3);
}

describe('the mobile bridge sleep/wake recovery is wired into src/main/index.ts', () => {
  it("routes powerMonitor's 'resume' to resumeAllSessions('system resumed from sleep'), and not to probeAllPresence", () => {
    const region = powerMonitorRegistration('resume');
    expect(
      region,
      "a resume must call mobileBridgeService.resumeAllSessions('system resumed from sleep') through the optional getOptionalIpcContext(), so a session with no phone attached redials at once, one whose phone was present is probed on its own evidence, and the call is a no-op before the IPC context exists or with the bridge disabled",
    ).toContain("getOptionalIpcContext()?.mobileBridgeService.resumeAllSessions('system resumed from sleep')");
    expect(
      region,
      "'resume' must not also call probeAllPresence: that is unlock-screen's job, and calling both on the same edge would double the redial/probe traffic against every roster session",
    ).not.toContain('probeAllPresence');
  });

  it("routes powerMonitor's 'unlock-screen' to probeAllPresence('screen unlocked'), and not to resumeAllSessions", () => {
    const region = powerMonitorRegistration('unlock-screen');
    expect(
      region,
      "an unlock is only a hint, so it must call mobileBridgeService.probeAllPresence('screen unlocked') through the optional getOptionalIpcContext(), sending one presence probe per session and letting each session's own budget decide, rather than forcing a redial",
    ).toContain("getOptionalIpcContext()?.mobileBridgeService.probeAllPresence('screen unlocked')");
    expect(
      region,
      "'unlock-screen' must not also call resumeAllSessions: forcing a redial on every unlock would tear down a session that is merely idle, not proven dead",
    ).not.toContain('resumeAllSessions');
  });
});
