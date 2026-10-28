/**
 * Wiring test for the transcript path an agent reports, read through SessionTelemetry.
 *
 * `SessionManager.getReportedTranscriptPath` delegates to
 * `SessionTelemetry.getReportedTranscriptPath`, which reads the `transcriptPath`
 * of the session's cached usage. Main-process readers (the workflow hang check,
 * the workflow agent's turn recording) pass it to the adapter as `reportedPath`,
 * because an agent can keep writing a resumed conversation outside the folder
 * its cwd maps to.
 *
 * This file crosses the delegation through the real public ingest path
 * (`processStatusUpdate`, the status.json channel), so a getter that stops
 * reading the usage, or an ingest path that stops caching the report, goes red
 * here. The usage cache is the only source: a session that never reported a
 * path, or that is not known, has none.
 *
 * Red-green: making SessionTelemetry.getReportedTranscriptPath return null
 * fails the four tests that expect a path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { SessionUsage } from '../../src/shared/types';

function makeTelemetry(): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: () => {},
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      requestSuspend: () => {},
      isSessionRunning: () => true,
    },
    { disableBgShellWatcher: true },
  );
}

/** A status report; `transcriptPath` is left off the payload entirely when not given, as an agent that reports none does. */
function usageReporting(transcriptPath?: string): SessionUsage {
  return {
    contextWindow: {
      usedPercentage: 0,
      usedTokens: 0,
      cacheTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      contextWindowSize: 200_000,
    },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
  };
}

describe('SessionTelemetry.getReportedTranscriptPath', () => {
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    telemetry = makeTelemetry();
  });

  afterEach(() => {
    telemetry.dispose();
  });

  it('returns the path a session reported in its status usage', () => {
    telemetry.processStatusUpdate('session-a', usageReporting('/home/dev/.claude/projects/work/conversation-a.jsonl'));

    expect(telemetry.getReportedTranscriptPath('session-a')).toBe('/home/dev/.claude/projects/work/conversation-a.jsonl');
  });

  it('returns the path of the session\'s last report, not an earlier one', () => {
    // A resumed conversation moves to a new file; the status line names it.
    telemetry.processStatusUpdate('session-a', usageReporting('/home/dev/.claude/projects/first/conversation-a.jsonl'));
    telemetry.processStatusUpdate('session-a', usageReporting('/home/dev/.claude/projects/second/conversation-a.jsonl'));

    expect(telemetry.getReportedTranscriptPath('session-a')).toBe('/home/dev/.claude/projects/second/conversation-a.jsonl');
  });

  it('returns null for a session that is not known', () => {
    telemetry.processStatusUpdate('session-a', usageReporting('/home/dev/.claude/projects/work/conversation-a.jsonl'));

    expect(telemetry.getReportedTranscriptPath('unknown-session')).toBeNull();
  });

  it('returns null for a session whose agent reports no path', () => {
    telemetry.processStatusUpdate('session-a', usageReporting());

    expect(telemetry.getReportedTranscriptPath('session-a')).toBeNull();
  });

  it('keeps each session\'s path separate', () => {
    telemetry.processStatusUpdate('session-a', usageReporting('/home/dev/.claude/projects/work/conversation-a.jsonl'));
    telemetry.processStatusUpdate('session-b', usageReporting('/home/dev/.claude/projects/work/conversation-b.jsonl'));

    expect(telemetry.getReportedTranscriptPath('session-a')).toBe('/home/dev/.claude/projects/work/conversation-a.jsonl');
    expect(telemetry.getReportedTranscriptPath('session-b')).toBe('/home/dev/.claude/projects/work/conversation-b.jsonl');
  });

  it('returns null again after removeSession, so a reused id does not inherit the old path', () => {
    telemetry.processStatusUpdate('session-a', usageReporting('/home/dev/.claude/projects/work/conversation-a.jsonl'));
    expect(telemetry.getReportedTranscriptPath('session-a')).not.toBeNull();

    telemetry.removeSession('session-a');

    expect(telemetry.getReportedTranscriptPath('session-a')).toBeNull();
  });
});
