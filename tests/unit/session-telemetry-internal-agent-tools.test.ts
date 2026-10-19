/**
 * SessionTelemetry keeps an internal CLI agent's tool events (an `agent_id`
 * that no `subagent_start` named) in the log and acts on nothing in them
 * (`ActivityEngine.isInternalAgentEvent`).
 *
 * The engine alone is not enough: the telemetry layer runs its own detectors
 * on every tool event. An internal agent's ExitPlanMode end would fire a plan
 * exit (an auto-move), its `gh pr` Bash a PR resolve, its `git push` a branch
 * anchor, and every one would count as one of the user's tool calls.
 *
 * Test tier: Unit (vitest). The bg-shell watcher is disabled so no OS probe
 * is constructed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { UsageAccumulator } from '../../src/main/activity-engine/usage-accumulator';
import { PRCommandDetector } from '../../src/main/activity-engine/pr-command-detector';
import { PushCommandDetector } from '../../src/main/activity-engine/push-command-detector';
import { EventType, AgentTool } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

interface Spies {
  onEvent: ReturnType<typeof vi.fn>;
  onPlanExit: ReturnType<typeof vi.fn>;
  onPRCandidate: ReturnType<typeof vi.fn>;
  onBranchPushed: ReturnType<typeof vi.fn>;
}

function makeTelemetry(spies: Spies): SessionTelemetry {
  return new SessionTelemetry(
    {
      onUsageChange: () => {},
      onActivityChange: () => {},
      onEvent: spies.onEvent,
      onIdleTimeout: () => {},
      onPlanExit: spies.onPlanExit,
      onPRCandidate: spies.onPRCandidate,
      onBranchPushed: spies.onBranchPushed,
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

/** One tool call: its start and its end, under one agent id (or none, for the main agent). */
function toolCall(tool: string, toolId: string, detail: string, subagentId?: string): SessionEvent[] {
  return [
    event({ type: EventType.ToolStart, tool, toolId, detail, subagentId }),
    event({ type: EventType.ToolEnd, tool, toolId, subagentId }),
  ];
}

const ALL_TOOLS = (subagentId?: string): SessionEvent[] => [
  ...toolCall(AgentTool.ExitPlanMode, 'toolu_plan', '', subagentId),
  ...toolCall(AgentTool.Bash, 'toolu_pr', 'gh pr create --fill', subagentId),
  ...toolCall(AgentTool.Bash, 'toolu_push', 'git push -u origin feat/x', subagentId),
];

describe('SessionTelemetry: an internal CLI agent\'s tool events', () => {
  let telemetry: SessionTelemetry | null = null;

  afterEach(() => {
    telemetry?.dispose();
    telemetry = null;
    vi.restoreAllMocks();
  });

  function spies(): Spies {
    return { onEvent: vi.fn(), onPlanExit: vi.fn(), onPRCandidate: vi.fn(), onBranchPushed: vi.fn() };
  }

  it('logs them and acts on nothing in them', () => {
    const callbacks = spies();
    telemetry = makeTelemetry(callbacks);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', ALL_TOOLS('a-internal'));

    expect(callbacks.onEvent).toHaveBeenCalledTimes(6);
    expect(telemetry.getEventsForSession('s1')).toHaveLength(6);
    expect(callbacks.onPlanExit).not.toHaveBeenCalled();
    expect(callbacks.onPRCandidate).not.toHaveBeenCalled();
    expect(callbacks.onBranchPushed).not.toHaveBeenCalled();
    expect(telemetry.getToolCallCount('s1')).toBe(0);
    expect(telemetry.getSessionActivity('s1')).toBe('idle');
    expect(telemetry.getActivityStatsSnapshot('s1')?.compensationCounters.internalAgentToolEvent).toBe(6);
  });

  it('acts on the same calls from the main agent (the control)', () => {
    const callbacks = spies();
    telemetry = makeTelemetry(callbacks);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', ALL_TOOLS());

    expect(callbacks.onPlanExit).toHaveBeenCalledTimes(1);
    expect(callbacks.onPRCandidate).toHaveBeenCalledTimes(1);
    expect(callbacks.onBranchPushed).toHaveBeenCalledWith('s1', 'feat/x');
    expect(telemetry.getToolCallCount('s1')).toBe(3);
  });

  it('acts on the same calls from a subagent that started', () => {
    const callbacks = spies();
    telemetry = makeTelemetry(callbacks);
    telemetry.initSession('s1');

    telemetry.ingestEvents('s1', [
      event({ type: EventType.Prompt }),
      event({ type: EventType.SubagentStart, detail: 'general-purpose', subagentId: 'a-sub' }),
      ...ALL_TOOLS('a-sub'),
    ]);

    expect(callbacks.onPRCandidate).toHaveBeenCalledTimes(1);
    expect(telemetry.getToolCallCount('s1')).toBe(3);
    expect(telemetry.getActivityStatsSnapshot('s1')?.compensationCounters.internalAgentToolEvent).toBe(0);
  });

  describe('an internal agent\'s interrupted tool', () => {
    const PUSH_COMMAND = 'git push -u origin feat/x';

    /**
     * The main agent starts a `git push`, a tool is interrupted under `subagentId`
     * (the main agent's own when it is undefined), and the push call then ends.
     * The two phases are ingested separately so the engine can be read in between.
     */
    function ingestPushWithInterrupt(subagentId: string | undefined): void {
      telemetry!.ingestEvents('s1', [
        event({ type: EventType.Prompt, ts: 1000 }),
        event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'toolu_push', detail: PUSH_COMMAND, ts: 1100 }),
        event({ type: EventType.Interrupted, tool: AgentTool.Bash, toolId: 'toolu_interrupted', subagentId, ts: 1200 }),
      ]);
    }
    function endPush(): void {
      telemetry!.ingestEvents('s1', [event({ type: EventType.ToolEnd, tool: AgentTool.Bash, toolId: 'toolu_push', ts: 1600 })]);
    }

    it('is logged, counted by the engine, and leaves the main agent\'s turn, push and usage alone', () => {
      const callbacks = spies();
      telemetry = makeTelemetry(callbacks);
      telemetry.initSession('s1');

      ingestPushWithInterrupt('a-internal');

      // The interrupt did not reach the engine as one: no bypass, the push call is still in flight.
      expect(telemetry.getSessionActivity('s1')).toBe('thinking');
      expect(telemetry.getActivityStatsSnapshot('s1')?.pendingToolCount).toBe(1);
      expect(telemetry.getActivityStatsSnapshot('s1')?.compensationCounters.internalAgentToolEvent).toBe(1);

      endPush();

      // The push detector did not see the interrupt (it would have dropped the pending push).
      expect(callbacks.onBranchPushed).toHaveBeenCalledWith('s1', 'feat/x');
      // The usage count did not see it either: the Bash row has one clean call and no interrupt.
      const bashRow = telemetry.getToolBreakdown('s1').find((row) => row.toolName === AgentTool.Bash);
      expect(bashRow).toMatchObject({ callCount: 1, interruptedCount: 0, totalDurationMs: 500 });
      // And it stayed in the log.
      expect(callbacks.onEvent).toHaveBeenCalledTimes(4);
      expect(telemetry.getEventsForSession('s1').map((logged) => logged.type)).toContain(EventType.Interrupted);
      expect(telemetry.getActivityStatsSnapshot('s1')?.compensationCounters.internalAgentToolEvent).toBe(1);
    });

    it('does end the turn, drop the push and count as an interrupt when the main agent sends it (the control)', () => {
      const callbacks = spies();
      telemetry = makeTelemetry(callbacks);
      telemetry.initSession('s1');

      ingestPushWithInterrupt(undefined);

      expect(telemetry.getSessionActivity('s1')).toBe('idle');
      expect(telemetry.getActivityStatsSnapshot('s1')?.compensationCounters.internalAgentToolEvent).toBe(0);

      endPush();

      expect(callbacks.onBranchPushed).not.toHaveBeenCalled();
      const bashRow = telemetry.getToolBreakdown('s1').find((row) => row.toolName === AgentTool.Bash);
      expect(bashRow).toMatchObject({ interruptedCount: 1 });
    });
  });

  describe('an internal agent\'s background shell start', () => {
    /** A background Bash as the hooks report it: the PreToolUse command, then the PostToolUse shell id. */
    function backgroundShellStarts(subagentId: string | undefined): SessionEvent[] {
      return [
        event({ type: EventType.BackgroundShellStart, tool: AgentTool.Bash, toolId: 'toolu_bg', detail: 'npm run dev', subagentId }),
        event({ type: EventType.BackgroundShellStart, tool: AgentTool.Bash, toolId: 'toolu_bg', detail: 'b9wh3dhov', subagentId }),
      ];
    }

    it('is logged and counted by the engine, which tracks no shell for it', () => {
      const callbacks = spies();
      telemetry = makeTelemetry(callbacks);
      telemetry.initSession('s1');

      telemetry.ingestEvents('s1', backgroundShellStarts('a-internal'));

      expect(callbacks.onEvent).toHaveBeenCalledTimes(2);
      expect(telemetry.getEventsForSession('s1')).toHaveLength(2);
      const snapshot = telemetry.getActivityStatsSnapshot('s1');
      expect(snapshot?.compensationCounters.internalAgentToolEvent).toBe(2);
      expect(snapshot?.anonymousBackgroundShellCount).toBe(0);
      expect(snapshot?.backgroundShellIds).toEqual([]);
      expect(telemetry.getSessionActivity('s1')).toBe('idle');
    });

    it('is tracked as a shell, and holds the session active, when the main agent starts it (the control)', () => {
      const callbacks = spies();
      telemetry = makeTelemetry(callbacks);
      telemetry.initSession('s1');

      telemetry.ingestEvents('s1', backgroundShellStarts(undefined));

      const snapshot = telemetry.getActivityStatsSnapshot('s1');
      expect(snapshot?.compensationCounters.internalAgentToolEvent).toBe(0);
      expect(snapshot?.backgroundShellIds).toEqual(['b9wh3dhov']);
      expect(snapshot?.anonymousBackgroundShellCount).toBe(0);
      expect(telemetry.getSessionActivity('s1')).toBe('thinking');
    });
  });

  describe('what an internal agent\'s interrupted and background shell events are never handed to', () => {
    // The usage count and the PR and push detectors each have one entry point
    // the ingest loop calls per event. For these two event types the effect of
    // a leak is not always visible in the telemetry's output (a background shell
    // start moves no detector and no usage row unless a tool id collides), so
    // this watches the entry points themselves.
    it.each([
      ['interrupted', EventType.Interrupted],
      ['background_shell_start', EventType.BackgroundShellStart],
    ] as const)('%s reaches none of them from an internal agent, and each of them from the main agent', (_name, type) => {
      const recordToolEvent = vi.spyOn(UsageAccumulator.prototype, 'recordToolEvent');
      const detectPRCommand = vi.spyOn(PRCommandDetector.prototype, 'detect');
      const detectPush = vi.spyOn(PushCommandDetector.prototype, 'detect');
      telemetry = makeTelemetry(spies());
      telemetry.initSession('s1');

      telemetry.ingestEvents('s1', [event({ type, tool: AgentTool.Bash, toolId: 'toolu_internal', detail: 'b9wh3dhov', subagentId: 'a-internal' })]);

      expect(recordToolEvent).not.toHaveBeenCalled();
      expect(detectPRCommand).not.toHaveBeenCalled();
      expect(detectPush).not.toHaveBeenCalled();

      telemetry.ingestEvents('s1', [event({ type, tool: AgentTool.Bash, toolId: 'toolu_main', detail: 'b9wh3dhov' })]);

      expect(recordToolEvent).toHaveBeenCalledTimes(1);
      expect(detectPRCommand).toHaveBeenCalledTimes(1);
      expect(detectPush).toHaveBeenCalledTimes(1);
    });
  });

  describe('SessionTelemetry.isInternalAgentEvent', () => {
    const TOOL_EVENT_TYPES = [EventType.ToolStart, EventType.ToolEnd, EventType.Interrupted, EventType.BackgroundShellStart];

    it('is true for a tool event from an agent that never started, and false for the main agent\'s', () => {
      telemetry = makeTelemetry(spies());
      telemetry.initSession('s1');
      for (const type of TOOL_EVENT_TYPES) {
        expect(telemetry.isInternalAgentEvent('s1', event({ type, tool: AgentTool.Bash, toolId: 'toolu_x', subagentId: 'a-internal' })), `${type} under an unstarted id`).toBe(true);
        expect(telemetry.isInternalAgentEvent('s1', event({ type, tool: AgentTool.Bash, toolId: 'toolu_x' })), `${type} with no id`).toBe(false);
      }
    });

    it('is false for a tool event from a subagent that started in this session', () => {
      telemetry = makeTelemetry(spies());
      telemetry.initSession('s1');
      telemetry.ingestEvents('s1', [
        event({ type: EventType.Prompt }),
        event({ type: EventType.SubagentStart, detail: 'general-purpose', subagentId: 'a-sub' }),
      ]);

      expect(telemetry.isInternalAgentEvent('s1', event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'toolu_x', subagentId: 'a-sub' }))).toBe(false);
      expect(telemetry.isInternalAgentEvent('s1', event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'toolu_x', subagentId: 'a-internal' }))).toBe(true);
    });

    it('answers per session: an id one session started is still unstarted in another', () => {
      telemetry = makeTelemetry(spies());
      telemetry.initSession('s1');
      telemetry.initSession('s2');
      telemetry.ingestEvents('s1', [
        event({ type: EventType.Prompt }),
        event({ type: EventType.SubagentStart, detail: 'general-purpose', subagentId: 'a-sub' }),
      ]);
      const toolUnderSub = event({ type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'toolu_x', subagentId: 'a-sub' });

      expect(telemetry.isInternalAgentEvent('s1', toolUnderSub)).toBe(false);
      expect(telemetry.isInternalAgentEvent('s2', toolUnderSub)).toBe(true);
    });
  });
});
