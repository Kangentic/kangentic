/**
 * Wiring test for SessionTelemetry's push capture: a Bash ToolStart whose
 * command is a `git push` with an explicit destination is remembered, and the
 * matching Bash ToolEnd fires `onBranchPushed` with that destination. An
 * unrelated Bash call ending first (a parallel or subagent call, identified by
 * a different toolId) must not fire it early.
 *
 * Test tier: Unit (vitest). The bg-shell watcher is disabled so no OS probe
 * is constructed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType, AgentTool } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

function makeTelemetry(onBranchPushed: (sessionId: string, branch: string) => void): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: () => {},
      onEvent: () => {},
      onIdleTimeout: () => {},
      onPlanExit: () => {},
      onPRCandidate: () => {},
      onBranchPushed,
      requestSuspend: () => {},
      isSessionRunning: () => true,
    },
    {
      disableBgShellWatcher: true,
      activityEngineOptions: { idleStabilityWindowMs: 0 },
    },
  );
}

function event(partial: Partial<SessionEvent> & { type: EventType }): SessionEvent {
  return { ts: Date.now(), ...partial };
}

describe('SessionTelemetry: git push capture fires onBranchPushed on the matching ToolEnd', () => {
  let telemetry: SessionTelemetry | null = null;

  afterEach(() => {
    telemetry?.dispose();
    telemetry = null;
  });

  it('fires once with the pushed branch when the push call ends, not when another Bash call ends', () => {
    const onBranchPushed = vi.fn();
    telemetry = makeTelemetry(onBranchPushed);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [
      event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'tool-a', detail: 'git push -u origin feat/x' }),
      event({ type: EventType.ToolEnd, tool: AgentTool.Bash, toolId: 'tool-b' }),
    ]);
    expect(onBranchPushed).not.toHaveBeenCalled();

    telemetry.ingestEvents('s1', [
      event({ type: EventType.ToolEnd, tool: AgentTool.Bash, toolId: 'tool-a' }),
    ]);
    expect(onBranchPushed).toHaveBeenCalledTimes(1);
    expect(onBranchPushed).toHaveBeenCalledWith('s1', 'feat/x');
  });

  it('never fires for a push whose destination is not explicit', () => {
    const onBranchPushed = vi.fn();
    telemetry = makeTelemetry(onBranchPushed);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [
      event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'tool-a', detail: 'git push -u origin HEAD' }),
      event({ type: EventType.ToolEnd, tool: AgentTool.Bash, toolId: 'tool-a' }),
    ]);

    expect(onBranchPushed).not.toHaveBeenCalled();
  });

  it('takePendingPushedBranch hands the exit-time fallback a push whose ToolEnd never came', () => {
    const onBranchPushed = vi.fn();
    telemetry = makeTelemetry(onBranchPushed);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [
      event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'tool-a', detail: 'git push origin HEAD:feat/y' }),
    ]);

    expect(telemetry.takePendingPushedBranch('s1')).toBe('feat/y');
    expect(telemetry.takePendingPushedBranch('s1')).toBeNull();
    expect(onBranchPushed).not.toHaveBeenCalled();
  });

  it('removeSession drops a remembered push', () => {
    const onBranchPushed = vi.fn();
    telemetry = makeTelemetry(onBranchPushed);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [
      event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'tool-a', detail: 'git push origin feat/z' }),
    ]);
    telemetry.removeSession('s1');

    expect(telemetry.takePendingPushedBranch('s1')).toBeNull();
  });
});
