/**
 * The report main sends when an agent's history view is no longer recognized
 * (`history-view-report.ts`): the one signal that a Claude Code update broke the
 * find bar's whole-conversation search, which otherwise falls back without a word.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const { reportUnrecognizedHistoryView, resetHistoryViewReports } = await import('../../src/main/pty/history-view-report');

describe('reportUnrecognizedHistoryView', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetHistoryViewReports();
  });

  it('reports once per agent per launch, tagged with the agent and nothing from its screen', () => {
    reportUnrecognizedHistoryView('claude');
    reportUnrecognizedHistoryView('claude');
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(error.message).toBe('Agent history view was not recognized');
    expect(tags).toEqual({ source: 'history_view', agent: 'claude' });

    reportUnrecognizedHistoryView('codex');
    expect(reportHandledError).toHaveBeenCalledTimes(2);
  });

  it('reports a session with no agent name under unknown', () => {
    reportUnrecognizedHistoryView(null);
    expect(reportHandledError.mock.calls[0]?.[1]).toEqual({ source: 'history_view', agent: 'unknown' });
  });
});
