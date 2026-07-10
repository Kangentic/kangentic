/**
 * Tests for the history-write side of `captureSessionMetrics`. Pins three
 * contracts:
 *
 *   1. When usage is present (regardless of cost value), the history receives
 *      a row with the correct shape (sessionRecordId, startedAt, sessionType,
 *      cost, tokens, duration, toolCount, model fields). Cost = 0 with real
 *      tokens is the subscription-user case (Claude Plus/Max) and MUST be
 *      recorded; the prior StatusBar filter `total_cost_usd IS NOT NULL`
 *      included those rows.
 *   2. When usage is absent (queued session, exit-before-status), the history
 *      is NOT touched. `usage` undefined means metrics were never captured,
 *      which matches the existing `total_cost_usd IS NULL` rows that the
 *      old SUM filter excluded.
 *   3. Errors thrown by the history repo do not propagate. The capture path
 *      is best-effort; it must never break shutdown or task-move flows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureSessionMetrics } from '../../src/main/ipc/handlers/session-metrics';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../src/main/db/repositories/usage-history-repository';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionUsage } from '../../src/shared/types';

interface Mocks {
  sessionManager: SessionManager;
  sessionRepo: SessionRepository;
  usageHistoryRepo: UsageHistoryRepository;
  updateMetrics: ReturnType<typeof vi.fn>;
  recordSessionUsage: ReturnType<typeof vi.fn>;
  getSessionAgentName: ReturnType<typeof vi.fn>;
  findByAnyId: ReturnType<typeof vi.fn>;
}

function makeUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    contextWindow: {
      usedPercentage: 25,
      usedTokens: 5000,
      cacheTokens: 2000,
      totalInputTokens: 5000,
      totalOutputTokens: 1500,
      contextWindowSize: 200000,
    },
    cost: {
      totalCostUsd: 0.42,
      totalDurationMs: 60000,
    },
    model: {
      id: 'claude-opus-4',
      displayName: 'Claude Opus 4',
    },
    ...overrides,
  };
}

function makeMocks(usageBySessionId: Record<string, SessionUsage> = {}): Mocks {
  const updateMetrics = vi.fn();
  const recordSessionUsage = vi.fn();

  // `captureSessionMetrics` stamps `agent`/`effort` onto the history row from
  // these two lookups (generic manager-recorded agent name + the session
  // record's applied_effort); the mocks must expose them or the history write
  // throws and is swallowed by the best-effort try/catch.
  const getSessionAgentName = vi.fn((): string | undefined => 'claude');
  const findByAnyId = vi.fn((): { applied_effort: string | null } | undefined => ({ applied_effort: 'high' }));

  const sessionManager = {
    getUsageCache: vi.fn(() => usageBySessionId),
    getToolCallCount: vi.fn(() => 7),
    getToolBreakdown: vi.fn(() => []),
    getCompactionCount: vi.fn(() => 0),
    getSessionAgentName,
  } as unknown as SessionManager;

  const sessionRepo = { updateMetrics, findByAnyId } as unknown as SessionRepository;
  const usageHistoryRepo = { recordSessionUsage } as unknown as UsageHistoryRepository;

  return { sessionManager, sessionRepo, usageHistoryRepo, updateMetrics, recordSessionUsage, getSessionAgentName, findByAnyId };
}

describe('captureSessionMetrics history write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a history row when usage exists (cost > 0 case)', () => {
    const { sessionManager, sessionRepo, usageHistoryRepo, recordSessionUsage } = makeMocks({
      'pty-1': makeUsage({ cost: { totalCostUsd: 0.42, totalDurationMs: 60000 } }),
    });

    captureSessionMetrics(
      sessionManager,
      sessionRepo,
      usageHistoryRepo,
      'pty-1',
      'record-1',
      '2026-04-01T10:00:00Z',
      'claude_agent',
    );

    expect(recordSessionUsage).toHaveBeenCalledTimes(1);
    expect(recordSessionUsage).toHaveBeenCalledWith({
      sessionRecordId: 'record-1',
      sessionStartedAt: '2026-04-01T10:00:00Z',
      sessionType: 'claude_agent',
      totalCostUsd: 0.42,
      totalInputTokens: 5000,
      totalOutputTokens: 1500,
      totalDurationMs: 60000,
      toolCallCount: 7,
      modelId: 'claude-opus-4',
      modelDisplayName: 'Claude Opus 4',
      compactionCount: 0,
      agent: 'claude',
      effort: 'high',
    });
  });

  it('does NOT write to the history when usage is missing for the session', () => {
    const { sessionManager, sessionRepo, usageHistoryRepo, updateMetrics, recordSessionUsage } = makeMocks({});

    captureSessionMetrics(
      sessionManager,
      sessionRepo,
      usageHistoryRepo,
      'pty-1',
      'record-1',
      '2026-04-01T10:00:00Z',
      'claude_agent',
    );

    // sessions.updateMetrics is still called (with NULLs) so the existing
    // session-row tool_call_count + duration semantics are preserved.
    expect(updateMetrics).toHaveBeenCalledTimes(1);
    expect(recordSessionUsage).not.toHaveBeenCalled();
  });

  it('writes a history row when usage exists with cost = 0 (subscription-user case)', () => {
    // Claude Plus/Max subscription users see cost = 0 with real, non-zero
    // token counts. Excluding these rows would silently zero their token
    // totals across all StatusBar periods; the previous
    // `total_cost_usd IS NOT NULL` filter included them.
    const { sessionManager, sessionRepo, usageHistoryRepo, recordSessionUsage } = makeMocks({
      'pty-1': makeUsage({ cost: { totalCostUsd: 0, totalDurationMs: 5000 } }),
    });

    captureSessionMetrics(
      sessionManager,
      sessionRepo,
      usageHistoryRepo,
      'pty-1',
      'record-1',
      '2026-04-01T10:00:00Z',
      'claude_agent',
    );

    expect(recordSessionUsage).toHaveBeenCalledTimes(1);
    expect(recordSessionUsage).toHaveBeenCalledWith(expect.objectContaining({
      totalCostUsd: 0,
      totalInputTokens: 5000,
      totalOutputTokens: 1500,
    }));
  });

  it('swallows errors thrown by the history repo (best-effort contract)', () => {
    const { sessionManager, sessionRepo, usageHistoryRepo, recordSessionUsage } = makeMocks({
      'pty-1': makeUsage(),
    });
    recordSessionUsage.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => {
      captureSessionMetrics(
        sessionManager,
        sessionRepo,
        usageHistoryRepo,
        'pty-1',
        'record-1',
        '2026-04-01T10:00:00Z',
        'claude_agent',
      );
    }).not.toThrow();
  });

  it('passes a null sessionType through to the history when given null', () => {
    const { sessionManager, sessionRepo, usageHistoryRepo, recordSessionUsage } = makeMocks({
      'pty-1': makeUsage(),
    });

    captureSessionMetrics(
      sessionManager,
      sessionRepo,
      usageHistoryRepo,
      'pty-1',
      'record-1',
      '2026-04-01T10:00:00Z',
      null,
    );

    expect(recordSessionUsage).toHaveBeenCalledWith(expect.objectContaining({ sessionType: null }));
  });

  it('stamps agent from getSessionAgentName and effort from the session record', () => {
    const { sessionManager, sessionRepo, usageHistoryRepo, recordSessionUsage, getSessionAgentName, findByAnyId } = makeMocks({
      'pty-1': makeUsage(),
    });
    getSessionAgentName.mockReturnValue('codex');
    findByAnyId.mockReturnValue({ applied_effort: 'low' });

    captureSessionMetrics(
      sessionManager,
      sessionRepo,
      usageHistoryRepo,
      'pty-1',
      'record-1',
      '2026-04-01T10:00:00Z',
      'codex_agent',
    );

    expect(getSessionAgentName).toHaveBeenCalledWith('pty-1');
    expect(findByAnyId).toHaveBeenCalledWith('record-1');
    expect(recordSessionUsage).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', effort: 'low' }));
  });

  it('falls back to null agent/effort when the manager and record do not know them', () => {
    const { sessionManager, sessionRepo, usageHistoryRepo, recordSessionUsage, getSessionAgentName, findByAnyId } = makeMocks({
      'pty-1': makeUsage(),
    });
    getSessionAgentName.mockReturnValue(undefined);
    findByAnyId.mockReturnValue(undefined);

    captureSessionMetrics(
      sessionManager,
      sessionRepo,
      usageHistoryRepo,
      'pty-1',
      'record-1',
      '2026-04-01T10:00:00Z',
      'claude_agent',
    );

    expect(recordSessionUsage).toHaveBeenCalledWith(expect.objectContaining({ agent: null, effort: null }));
  });
});
