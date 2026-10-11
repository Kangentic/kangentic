/**
 * Wiring test for the agent-absence request pair on SessionTelemetry:
 * `requestAgentAbsenceCheck` and `cancelAgentAbsenceCheck` forward to the
 * bg-shell watcher it owns, and do nothing (rather than throw) when there is no
 * watcher. SessionManager calls the pair on a Command Terminal's SessionEnd and
 * SessionStart; its own tests mock SessionTelemetry, so this is the only place
 * the forwarding itself is pinned.
 *
 * What each request DOES inside the watcher (looks, backoff reset, withdrawal)
 * is covered in bg-shell-watcher.test.ts.
 *
 * Test tier: Unit (vitest, no browser, no Electron, no real OS processes). The
 * BgShellWatcher is constructed inside SessionTelemetry with an inert probe, and
 * its two methods are spied on the real instance.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionTelemetryOptions } from '../../src/main/activity-engine/session-telemetry';
import type { BgShellWatcher } from '../../src/main/activity-engine/background-shell/watcher';
import type { ProcessInfo, ProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';

/** A probe that sees nothing and owns nothing, so no cycle ever has OS work. */
class InertProcessTreeProbe implements ProcessTreeProbe {
  isAlive(): boolean {
    return false;
  }
  async listAllProcesses(): Promise<ProcessInfo[]> {
    return [];
  }
  async listDescendants(): Promise<ProcessInfo[]> {
    return [];
  }
  dispose(): void {
    // Nothing long-lived to release.
  }
}

const baseCallbacks = {
  onUsageChange: (): void => {},
  onActivityChange: (): void => {},
  onEvent: (): void => {},
  onIdleTimeout: (): void => {},
  onPlanExit: (): void => {},
  onPRCandidate: (): void => {},
  requestSuspend: (): void => {},
  isSessionRunning: (): boolean => true,
};

function makeTelemetry(options: {
  disableBgShellWatcher?: boolean;
  withRootPidLookup: boolean;
}): SessionTelemetry {
  const telemetryOptions: SessionTelemetryOptions = {
    processTreeProbe: new InertProcessTreeProbe(),
    disableBgShellWatcher: options.disableBgShellWatcher ?? false,
  };
  return new SessionTelemetry(
    options.withRootPidLookup
      ? { ...baseCallbacks, getSessionRootPid: () => undefined }
      : baseCallbacks,
    telemetryOptions,
  );
}

function requireWatcher(telemetry: SessionTelemetry): BgShellWatcher {
  if (!telemetry.bgShellWatcher) {
    throw new Error('expected SessionTelemetry to have built a bg-shell watcher');
  }
  return telemetry.bgShellWatcher;
}

describe('SessionTelemetry: agent-absence request and cancel', () => {
  let telemetry: SessionTelemetry | null = null;

  afterEach(() => {
    telemetry?.dispose();
    telemetry = null;
  });

  describe('with a bg-shell watcher', () => {
    it('forwards requestAgentAbsenceCheck to the watcher with the session id, and only that call', () => {
      const subject = makeTelemetry({ withRootPidLookup: true });
      telemetry = subject;
      const watcher = requireWatcher(subject);
      const requestSpy = vi.spyOn(watcher, 'requestAgentAbsenceCheck').mockImplementation(() => {});
      const cancelSpy = vi.spyOn(watcher, 'cancelAgentAbsenceCheck').mockImplementation(() => {});

      subject.requestAgentAbsenceCheck('session-1');

      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith('session-1');
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('forwards cancelAgentAbsenceCheck to the watcher with the session id, and only that call', () => {
      const subject = makeTelemetry({ withRootPidLookup: true });
      telemetry = subject;
      const watcher = requireWatcher(subject);
      const requestSpy = vi.spyOn(watcher, 'requestAgentAbsenceCheck').mockImplementation(() => {});
      const cancelSpy = vi.spyOn(watcher, 'cancelAgentAbsenceCheck').mockImplementation(() => {});

      subject.cancelAgentAbsenceCheck('session-2');

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith('session-2');
      expect(requestSpy).not.toHaveBeenCalled();
    });
  });

  describe('without a bg-shell watcher', () => {
    // Two ways to have none: the watcher switched off, and no root-pid lookup
    // wired (the constructor builds a watcher only when it can resolve a PTY).
    it.each([
      ['the watcher is disabled', { disableBgShellWatcher: true, withRootPidLookup: true }],
      ['no root pid lookup is wired', { withRootPidLookup: false }],
    ])('neither call throws when %s', (_label, options) => {
      const subject = makeTelemetry(options);
      telemetry = subject;
      expect(subject.bgShellWatcher).toBeNull();

      expect(() => subject.requestAgentAbsenceCheck('session-1')).not.toThrow();
      expect(() => subject.cancelAgentAbsenceCheck('session-1')).not.toThrow();
    });
  });
});
