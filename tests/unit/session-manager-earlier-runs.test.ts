/**
 * Unit tests for SessionManager's earlier-runs wiring: the spawn-time load
 * (`loadEarlierRuns`, which performSpawn calls) and
 * `refreshToolBreakdownAcrossRuns`, the read behind the context bar's tool-call
 * popover.
 *
 * Every resume (an app restart, a pause and resume) is a new session id and a
 * new record, so without these the pill drops to 0 and the table empties. The
 * per-run reads (`getToolCallCount`, `getToolBreakdown`) must stay per run:
 * captureSessionMetrics stores them on this run's record.
 *
 * Modelled on session-manager-remove-emit.test.ts: rows are seeded into the
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
import type { Session } from '../../src/shared/types';
import { SessionManager, type EarlierRunsSource } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { ToolCallTotals } from '../../src/shared/tool-call-totals';

const EARLIER_TOTALS: ToolCallTotals = {
  toolCallCount: 482,
  toolBreakdown: [
    { toolName: 'Read', callCount: 300, totalDurationMs: 50_000, interruptedCount: 0, resultTokens: 57_900 },
    { toolName: 'Bash', callCount: 182, totalDurationMs: 90_000, interruptedCount: 2 },
  ],
};

describe('SessionManager earlier runs', () => {
  let manager: SessionManager;
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    telemetry = (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
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
      resuming: true,
      transient: false,
      isolatedSwimlaneId: null,
      exitSequence: ['\x03'],
      ...overrides,
    } as ManagedSession);
    telemetry.initSession(id);
  }

  function loadEarlierRuns(sessionId: string): void {
    (manager as unknown as { loadEarlierRuns: (sessionId: string) => void }).loadEarlierRuns(sessionId);
  }

  function makeSource(overrides: Partial<EarlierRunsSource> = {}): EarlierRunsSource {
    return {
      readToolTotals: vi.fn(() => EARLIER_TOTALS),
      fillMissingResultTokens: vi.fn(async () => false),
      ...overrides,
    };
  }

  function stampedCount(sessionId: string): number | undefined {
    telemetry.setSessionUsage(sessionId, {});
    return manager.getUsageCache()[sessionId]?.toolCallCount;
  }

  it('loads a task session\'s earlier runs at spawn and starts the Tokens fill', () => {
    const source = makeSource();
    manager.setEarlierRunsSource(source);
    seedSession('resumed');

    loadEarlierRuns('resumed');

    const readFor = vi.mocked(source.readToolTotals).mock.calls[0][0] as Session;
    expect(readFor).toMatchObject({ id: 'resumed', taskId: 'task-1', projectId: 'project-1', isolatedSwimlaneId: null });
    expect(source.fillMissingResultTokens).toHaveBeenCalledOnce();
    // The pill shows the earlier runs before any new call.
    expect(stampedCount('resumed')).toBe(482);
  });

  it('skips a Command Terminal, which has no record', () => {
    const source = makeSource();
    manager.setEarlierRunsSource(source);
    seedSession('command-terminal', { transient: true });

    loadEarlierRuns('command-terminal');

    expect(source.readToolTotals).not.toHaveBeenCalled();
    expect(source.fillMissingResultTokens).not.toHaveBeenCalled();
  });

  it('never fails a spawn over a failed read, and counts this run alone', () => {
    const source = makeSource({ readToolTotals: vi.fn(() => { throw new Error('database is closed'); }) });
    manager.setEarlierRunsSource(source);
    seedSession('resumed');

    expect(() => loadEarlierRuns('resumed')).not.toThrow();
    expect(source.fillMissingResultTokens).not.toHaveBeenCalled();
    expect(stampedCount('resumed')).toBe(0);
  });

  it('merges the earlier runs with this run for the popover, and keeps the per-run reads per run', () => {
    manager.setEarlierRunsSource(makeSource());
    seedSession('resumed');
    telemetry.ingestEvents('resumed', [
      { ts: 1, type: EventType.ToolStart, tool: 'Read', toolId: 'call-1' },
      { ts: 2, type: EventType.ToolEnd, tool: 'Read', toolId: 'call-1' },
      { ts: 3, type: EventType.ToolStart, tool: 'Write', toolId: 'call-2' },
      { ts: 5, type: EventType.ToolEnd, tool: 'Write', toolId: 'call-2' },
    ]);

    const rows = manager.refreshToolBreakdownAcrossRuns('resumed');

    expect(rows).toEqual([
      { toolName: 'Read', callCount: 301, totalDurationMs: 50_001, interruptedCount: 0, resultTokens: 57_900 },
      { toolName: 'Bash', callCount: 182, totalDurationMs: 90_000, interruptedCount: 2 },
      { toolName: 'Write', callCount: 1, totalDurationMs: 2, interruptedCount: 0 },
    ]);
    expect(manager.getToolCallCount('resumed')).toBe(2);
    expect(manager.getToolBreakdown('resumed').map((stat) => stat.toolName).sort()).toEqual(['Read', 'Write']);
  });

  it('refreshes the pill\'s count when the popover reads a total that changed since the spawn', () => {
    let current = EARLIER_TOTALS;
    manager.setEarlierRunsSource(makeSource({ readToolTotals: vi.fn(() => current) }));
    seedSession('resumed');
    loadEarlierRuns('resumed');
    expect(stampedCount('resumed')).toBe(482);

    // A run-end backfill landed on an earlier record after the spawn.
    current = { ...EARLIER_TOTALS, toolCallCount: 490 };
    manager.refreshToolBreakdownAcrossRuns('resumed');

    expect(manager.getUsageCache()['resumed'].toolCallCount).toBe(490);
  });

  it('shows this run alone when no source is wired', () => {
    seedSession('unwired');
    telemetry.ingestEvents('unwired', [
      { ts: 1, type: EventType.ToolStart, tool: 'Read', toolId: 'call-1' },
      { ts: 2, type: EventType.ToolEnd, tool: 'Read', toolId: 'call-1' },
    ]);

    expect(manager.refreshToolBreakdownAcrossRuns('unwired')).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 1, interruptedCount: 0 },
    ]);
  });
});
