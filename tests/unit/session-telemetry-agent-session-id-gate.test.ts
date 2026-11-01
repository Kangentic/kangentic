/**
 * Agent-session-id capture gating in SessionTelemetry.
 *
 * The status-file channel (Claude's statusline -> status.json) is the
 * authoritative, continuous id-report channel: its payload carries the CURRENT
 * session id on every write, so a mid-session move (the user runs /clear,
 * Claude Code continues under a brand-new id) re-reports here.
 *
 * Every parser in this file lacks `statusFile.parseSessionStart`, so these
 * cases pin the channel as such an adapter sees it: every id change is a
 * switch. An adapter that declares it (Claude) switches only once a
 * SessionStart hook that moves the conversation named the id, because more
 * than one process can write one status file; that gate is pinned in
 * session-telemetry-conversation-switch.test.ts.
 *
 * Contract pinned by this file:
 *  - The status-file channel is CHANGE-SENSITIVE: it fires onAgentSessionId on
 *    the first id-bearing write and again whenever the reported id CHANGES,
 *    never on same-id churn (status.json rewrites every ~10s).
 *  - The PTY-output channel (notifyAgentSessionId) and the hook channel
 *    (captureHookSessionIds) stay strictly ONE-SHOT: multi-shot output capture
 *    would reintroduce the OpenCode stale-flag-echo poisoning bug (a PSReadLine
 *    autosuggestion echoing a stale `--session <uuid>` re-captured mid-session).
 *  - A capture on any channel closes the one-shot channels; only the status
 *    file may later revise the id.
 *
 * Test tier: Unit (vitest, no Electron, no processes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { ActivityDetection } from '../../src/shared/types';
import type { AgentParser, SessionUsage } from '../../src/shared/types';

interface CapturedId {
  sessionId: string;
  agentReportedId: string;
}

function makeTelemetry(captured: CapturedId[]): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: () => {},
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      onAgentSessionId: (sessionId, agentReportedId) => {
        captured.push({ sessionId, agentReportedId });
      },
      requestSuspend: () => {},
      isSessionRunning: () => true,
    },
    { disableBgShellWatcher: true },
  );
}

function statusUsage(agentSessionId?: string): SessionUsage {
  return {
    sessionId: agentSessionId,
    contextWindow: {
      usedPercentage: 10,
      usedTokens: 100_000,
      cacheTokens: 0,
      totalInputTokens: 100_000,
      totalOutputTokens: 500,
      contextWindowSize: 1_000_000,
    },
    cost: { totalCostUsd: 0.05, totalDurationMs: 500 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  };
}

/**
 * Minimal parser exposing only what captureHookSessionIds consumes
 * (runtime.sessionId.fromHook). The remaining AgentParser surface is
 * irrelevant to the gate under test.
 */
function makeHookCaptureParser(): AgentParser {
  const partial = {
    detectFirstOutput: () => false,
    runtime: {
      activity: ActivityDetection.hooks(),
      sessionId: {
        fromHook: (hookContext: string): string | null => {
          const parsed = JSON.parse(hookContext) as { session_id?: string };
          return parsed.session_id ?? null;
        },
      },
    },
  };
  return partial as unknown as AgentParser;
}

function sessionStartLine(agentSessionId: string): string {
  return JSON.stringify({
    ts: 1,
    type: 'session_start',
    hookContext: JSON.stringify({ session_id: agentSessionId }),
  });
}

describe('SessionTelemetry: status-file channel id capture is change-sensitive', () => {
  let captured: CapturedId[];
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    captured = [];
    telemetry = makeTelemetry(captured);
    telemetry.initSession('s1');
  });

  afterEach(() => {
    telemetry.dispose();
  });

  it('fires once on the first id-bearing status write', () => {
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    expect(captured).toEqual([{ sessionId: 's1', agentReportedId: 'agent-id-a' }]);
    expect(telemetry.hasAgentSessionId('s1')).toBe(true);
  });

  it('does not re-fire on same-id status churn', () => {
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    expect(captured).toHaveLength(1);
  });

  it('RE-fires when the status file reports a DIFFERENT id (mid-session fork, e.g. /clear)', () => {
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-b'));
    expect(captured).toEqual([
      { sessionId: 's1', agentReportedId: 'agent-id-a' },
      { sessionId: 's1', agentReportedId: 'agent-id-b' },
    ]);
    // A second fork keeps working (repeated /clear).
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-c'));
    expect(captured).toHaveLength(3);
    expect(captured[2].agentReportedId).toBe('agent-id-c');
    expect(telemetry.hasAgentSessionId('s1')).toBe(true);
  });

  it('a first status write WITHOUT a session id does not consume the capture', () => {
    telemetry.processStatusUpdate('s1', statusUsage(undefined));
    expect(captured).toHaveLength(0);
    // Legacy semantics preserved: the session counts as "checked" (this gates
    // the SessionIdManager diagnostic timer and output scanning).
    expect(telemetry.hasAgentSessionId('s1')).toBe(true);
    // A later id-bearing write still captures.
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    expect(captured).toEqual([{ sessionId: 's1', agentReportedId: 'agent-id-a' }]);
  });

  it('removeSession resets the channel so a reused id would capture fresh', () => {
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    telemetry.removeSession('s1');
    telemetry.initSession('s1');
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    expect(captured).toHaveLength(2);
  });
});

describe('SessionTelemetry: one-shot channels stay one-shot and close after a status capture', () => {
  let captured: CapturedId[];
  let telemetry: SessionTelemetry;

  beforeEach(() => {
    captured = [];
    telemetry = makeTelemetry(captured);
  });

  afterEach(() => {
    telemetry.dispose();
  });

  it('notifyAgentSessionId (PTY output) fires once and never again', () => {
    telemetry.initSession('s1');
    telemetry.notifyAgentSessionId('s1', 'pty-id-a');
    telemetry.notifyAgentSessionId('s1', 'pty-id-b');
    expect(captured).toEqual([{ sessionId: 's1', agentReportedId: 'pty-id-a' }]);
  });

  it('after a status capture, notifyAgentSessionId does not fire (poisoning pin)', () => {
    telemetry.initSession('s1');
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    telemetry.notifyAgentSessionId('s1', 'stale-echoed-id');
    expect(captured).toEqual([{ sessionId: 's1', agentReportedId: 'agent-id-a' }]);
  });

  it('after a status capture, captureHookSessionIds is inert', () => {
    telemetry.initSession('s1', makeHookCaptureParser());
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    telemetry.captureHookSessionIds('s1', [sessionStartLine('hook-id-c')]);
    expect(captured).toEqual([{ sessionId: 's1', agentReportedId: 'agent-id-a' }]);
  });

  it('a hook capture seeds the status channel: same-id status is quiet, a fork still fires', () => {
    telemetry.initSession('s1', makeHookCaptureParser());
    telemetry.captureHookSessionIds('s1', [sessionStartLine('agent-id-a')]);
    expect(captured).toEqual([{ sessionId: 's1', agentReportedId: 'agent-id-a' }]);
    // The first statusline write reports the SAME id the hook already
    // delivered: no redundant re-fire.
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    expect(captured).toHaveLength(1);
    // A later fork (different id) still fires through the status channel.
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-b'));
    expect(captured).toHaveLength(2);
    expect(captured[1].agentReportedId).toBe('agent-id-b');
  });

  it('a PTY-output capture (notifyAgentSessionId) seeds the status channel: same-id status is quiet, a fork still fires', () => {
    // Mirrors the hook-capture-seeds test above, but for the OTHER one-shot
    // channel: notifyAgentSessionId is called by SessionManager when an
    // adapter's runtime.sessionId.fromOutput scrapes the id from raw PTY
    // output. It seeds lastReportedAgentSessionIds the same way the hook
    // channel does (see the `// Seed the status channel's change detection`
    // comment in notifyAgentSessionId), so a same-id status write is quiet
    // and only a genuine fork re-fires.
    telemetry.initSession('s1');
    telemetry.notifyAgentSessionId('s1', 'agent-id-a');
    expect(captured).toEqual([{ sessionId: 's1', agentReportedId: 'agent-id-a' }]);
    // The first statusline write reports the SAME id the PTY-output channel
    // already delivered: no redundant re-fire.
    // Red: commenting out the `this.lastReportedAgentSessionIds.set(...)`
    // seed line inside notifyAgentSessionId makes this re-fire (length 2).
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-a'));
    expect(captured).toHaveLength(1);
    // A later fork (different id) still fires through the status channel.
    telemetry.processStatusUpdate('s1', statusUsage('agent-id-b'));
    expect(captured).toHaveLength(2);
    expect(captured[1].agentReportedId).toBe('agent-id-b');
  });
});
