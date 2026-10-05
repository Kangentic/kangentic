/**
 * A Command Terminal (a transient session) has no session record, so it has no
 * earlier runs to merge in. SessionManager reads earlier runs through one
 * helper, `refreshEarlierRunTotals`, which returns null for a transient row
 * before it touches the wired `EarlierRunsSource`.
 *
 * session-manager-earlier-runs.test.ts pins that skip only through the
 * spawn-time `loadEarlierRuns`. The popover's read, `refreshToolBreakdownAcrossRuns`,
 * reaches the same helper by its own path; without the transient check it would
 * ask the source about a session that has no track, and whatever it returned
 * would be merged into this terminal's table and pill.
 *
 * Modelled on session-manager-earlier-runs.test.ts: the row is seeded into the
 * registry directly, so no PTY is spawned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { EventType } from '../../src/shared/types';
import { SessionManager, type EarlierRunsSource } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { ToolCallTotals } from '../../src/shared/tool-call-totals';

/** What a source would return for a task session's track; a transient session must never see it. */
const EARLIER_TOTALS: ToolCallTotals = {
  toolCallCount: 482,
  toolBreakdown: [
    { toolName: 'Read', callCount: 300, totalDurationMs: 50_000, interruptedCount: 0, resultTokens: 57_900 },
    { toolName: 'Bash', callCount: 182, totalDurationMs: 90_000, interruptedCount: 2 },
  ],
};

describe('SessionManager earlier runs for a transient session', () => {
  let manager: SessionManager;
  let telemetry: SessionTelemetry;
  let source: EarlierRunsSource;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    telemetry = (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
    source = {
      readToolTotals: vi.fn(() => EARLIER_TOTALS),
      fillMissingResultTokens: vi.fn(async () => false),
    };
    manager.setEarlierRunsSource(source);
  });

  function seedSession(id: string, overrides: Partial<ManagedSession> = {}): void {
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    registry.set(id, {
      id,
      taskId: 'task-1',
      projectId: 'project-1',
      pty: null,
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: '2026-10-05T10:00:00.000Z',
      exitCode: null,
      resuming: false,
      transient: false,
      isolatedSwimlaneId: null,
      exitSequence: ['\x03'],
      ...overrides,
    } as ManagedSession);
    telemetry.initSession(id);
  }

  function ingestOneReadCall(sessionId: string): void {
    telemetry.ingestEvents(sessionId, [
      { ts: 1, type: EventType.ToolStart, tool: 'Read', toolId: 'call-1' },
      { ts: 2, type: EventType.ToolEnd, tool: 'Read', toolId: 'call-1' },
    ]);
  }

  function stampedCount(sessionId: string): number | undefined {
    telemetry.setSessionUsage(sessionId, {});
    return manager.getUsageCache()[sessionId]?.toolCallCount;
  }

  it('returns a Command Terminal\'s live rows alone and never reads the source', () => {
    seedSession('command-terminal', { transient: true });
    ingestOneReadCall('command-terminal');

    const rows = manager.refreshToolBreakdownAcrossRuns('command-terminal');

    expect(source.readToolTotals).not.toHaveBeenCalled();
    expect(rows).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 1, interruptedCount: 0 },
    ]);
  });

  it('leaves a Command Terminal\'s pill at its own count after the popover read', () => {
    seedSession('command-terminal', { transient: true });
    ingestOneReadCall('command-terminal');

    manager.refreshToolBreakdownAcrossRuns('command-terminal');

    // A source read would have stamped the 482 earlier calls onto the count.
    expect(stampedCount('command-terminal')).toBe(1);
  });

  it('is the transient flag that skips the source: the same read for a task session does call it', () => {
    // The control. Without it the cases above could pass on a source that was
    // never reachable from this method, and prove nothing about the flag.
    seedSession('task-session');
    ingestOneReadCall('task-session');

    const rows = manager.refreshToolBreakdownAcrossRuns('task-session');

    expect(source.readToolTotals).toHaveBeenCalledOnce();
    expect(rows.find((row) => row.toolName === 'Read')?.callCount).toBe(301);
  });
});
