/**
 * The kind of a permission wait (#452): a question the agent asked, or an
 * approval it wants. Adapters tag the `idle:permission` event with `waitKind`;
 * the engine keeps it beside `permissionPending` and reports it on the
 * permission reason, which is how it reaches the renderer's session store, the
 * desktop notifier and the Agent Monitor.
 *
 * Pins that the kind is set from the event, cleared at every site that clears
 * the wait (so a stale kind never rides into the next wait), reported when it
 * changes inside one permission stay (the reason gate compares kind only
 * otherwise), and absent, not null, when the agent did not report it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityReason, ActivityState, PermissionWaitKind, SessionEvent } from '../../src/shared/types';

const SESSION_ID = 'wait-kind-session';

interface Report {
  activity: ActivityState;
  reason: ActivityReason;
}

function permissionIdle(waitKind?: PermissionWaitKind, extra: Partial<SessionEvent> = {}): SessionEvent {
  return { ts: Date.now(), type: EventType.Idle, detail: IdleReason.Permission, ...(waitKind ? { waitKind } : {}), ...extra };
}

function plain(type: EventType, extra: Partial<SessionEvent> = {}): SessionEvent {
  return { ts: Date.now(), type, ...extra };
}

describe('ActivityEngine: the kind of a permission wait', () => {
  let engine: ActivityEngine;
  let activityChanges: Report[];
  let reasonChanges: Report[];

  beforeEach(() => {
    vi.useFakeTimers();
    activityChanges = [];
    reasonChanges = [];
    engine = new ActivityEngine(
      {
        onActivityChange(_sessionId, activity, reason) { activityChanges.push({ activity, reason }); },
        onReasonChange(_sessionId, activity, reason) { reasonChanges.push({ activity, reason }); },
      },
      { idleStabilityWindowMs: 0, staleThinkingTimeoutMs: 60_000, bgShellEscapeHatchMs: 60_000 },
    );
    engine.initSession(SESSION_ID);
    engine.processEvent(SESSION_ID, plain(EventType.Prompt));
    activityChanges.length = 0;
    reasonChanges.length = 0;
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('reports a question on the permission reason it enters with', () => {
    engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'AskUserQuestion', toolId: 'ask-1' }));
    engine.processEvent(SESSION_ID, permissionIdle('question', { tool: 'AskUserQuestion' }));
    const last = activityChanges[activityChanges.length - 1];
    expect(last.activity).toBe('permission');
    expect(last.reason).toEqual({ kind: 'permission', since: expect.any(Number), waitKind: 'question' });
    expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBe('question');
    expect(engine.getStatsSnapshot(SESSION_ID)?.permissionWaitKind).toBe('question');
  });

  it('reports an approval the same way', () => {
    engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Bash', toolId: 'bash-1' }));
    engine.processEvent(SESSION_ID, permissionIdle('approval', { tool: 'Bash' }));
    expect(activityChanges[activityChanges.length - 1].reason).toMatchObject({ kind: 'permission', waitKind: 'approval' });
  });

  it('leaves the kind ABSENT, not null, for an agent that does not report it', () => {
    engine.processEvent(SESSION_ID, permissionIdle());
    const reason = activityChanges[activityChanges.length - 1].reason;
    expect(reason.kind).toBe('permission');
    expect('waitKind' in reason).toBe(false);
    expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBeNull();
  });

  it('pushes a reason when the kind changes inside one permission stay', () => {
    // A subagent's approval prompt opens while the parent's question is still
    // up: the session stays `permission` throughout, so no activity transition
    // carries the new kind. The reason gate must.
    engine.processEvent(SESSION_ID, plain(EventType.SubagentStart, { subagentId: 'agent-1' }));
    engine.processEvent(SESSION_ID, permissionIdle('question'));
    expect(activityChanges[activityChanges.length - 1].reason).toMatchObject({ waitKind: 'question' });
    const transitionsBefore = activityChanges.length;
    // The subagent's start reported its own reason kind; only what follows the wait counts here.
    reasonChanges.length = 0;

    engine.processEvent(SESSION_ID, permissionIdle('approval'));
    expect(activityChanges).toHaveLength(transitionsBefore);
    expect(reasonChanges).toHaveLength(1);
    expect(reasonChanges[0]).toMatchObject({ activity: 'permission', reason: { kind: 'permission', waitKind: 'approval' } });

    // The same kind again pushes nothing: the gate compares the shape, not every field.
    engine.processEvent(SESSION_ID, permissionIdle('approval'));
    expect(reasonChanges).toHaveLength(1);
  });

  describe('every site that clears the wait clears its kind', () => {
    const clears: Array<[string, (target: ActivityEngine) => void]> = [
      ['a depth-0 tool event', (target) => target.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'AskUserQuestion', toolId: 'ask-1' }))],
      ['a prompt', (target) => target.processEvent(SESSION_ID, plain(EventType.Prompt))],
      ['an interrupt', (target) => target.processEvent(SESSION_ID, plain(EventType.Interrupted))],
      ['a failed turn', (target) => target.processEvent(SESSION_ID, plain(EventType.TurnFailed))],
      ['a finished turn', (target) => target.processEvent(SESSION_ID, plain(EventType.Idle))],
      ['a retry after the turn ended', (target) => {
        // The wait's own idle ended the turn, so the retry takes the terminal
        // branch (the live-retry hold would keep the session thinking). A retry
        // clears the wait nowhere else: updatePermissionFlag ignores it.
        expect(target.getState(SESSION_ID)?.turnActive).toBe(false);
        target.processEvent(SESSION_ID, plain(EventType.TurnRetrying));
        expect(target.getState(SESSION_ID)?.activity).toBe('idle');
      }],
      ['forceThinking', (target) => target.forceThinking(SESSION_ID)],
      ['forceIdle', (target) => target.forceIdle(SESSION_ID)],
      ['a rejection read from the transcript', (target) => target.markPermissionRejected(SESSION_ID, 'ask-1')],
    ];

    for (const [label, clear] of clears) {
      it(label, () => {
        engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'AskUserQuestion', toolId: 'ask-1' }));
        engine.processEvent(SESSION_ID, permissionIdle('question'));
        expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBe('question');

        clear(engine);
        expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
        expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBeNull();

        // A later wait of unknown kind does not inherit the old one.
        engine.processEvent(SESSION_ID, permissionIdle());
        expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBeNull();
      });
    }
  });

  it('a late tool start from the waiting tool clears the wait it lands after, the reason a wait must follow its tool start', () => {
    // The ordering every adapter has to keep: a wait written before its own
    // tool's start is cleared by that start at once (depth 0).
    engine.processEvent(SESSION_ID, permissionIdle('question', { tool: 'request_user_input' }));
    engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'request_user_input', toolId: 'rui-1' }));
    expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBeNull();
  });

  it('a wait written after its tool start holds until that tool ends', () => {
    engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'request_user_input', toolId: 'rui-1' }));
    engine.processEvent(SESSION_ID, permissionIdle('question', { tool: 'request_user_input' }));
    expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
    expect(engine.getState(SESSION_ID)?.permissionAwaitedToolId).toBe('rui-1');

    engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'request_user_input', toolId: 'rui-1' }));
    expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
    expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBeNull();
  });

  it('replays a live Copilot 1.0.100 session: each wait follows its tool start and ends on that tool\'s end', () => {
    // tests/fixtures/copilot-hooks/copilot-1.0.100-waits.jsonl: an ask_user
    // question, an auto-allowed echo, then a shell command that needed approval.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'copilot-hooks', 'copilot-1.0.100-waits.jsonl');
    const replayed = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent)
      .map((event) => {
        engine.processEvent(SESSION_ID, event);
        const state = engine.getState(SESSION_ID);
        return `${state?.activity}:${state?.permissionWaitKind ?? '-'}`;
      });
    expect(replayed).toEqual([
      'thinking:-', 'permission:question', 'thinking:-',
      'thinking:-', 'thinking:-', 'idle:-',
      'thinking:-', 'permission:approval', 'thinking:-', 'idle:-',
    ]);
  });

  it('replays a live Antigravity 1.3.4 question: the wait holds until ask_question ends, then the turn finishes', () => {
    // tests/fixtures/antigravity-hooks/agy-1.3.4-question-waits.jsonl: the
    // PreToolUse entry's start and wait, written in one bridge process.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'antigravity-hooks', 'agy-1.3.4-question-waits.jsonl');
    const replayed = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent)
      .map((event) => {
        engine.processEvent(SESSION_ID, event);
        const state = engine.getState(SESSION_ID);
        return `${state?.activity}:${state?.permissionWaitKind ?? '-'}`;
      });
    expect(replayed).toEqual([
      'thinking:-', 'thinking:-', 'permission:question', 'thinking:-', 'thinking:-', 'idle:-',
    ]);
  });

  describe('a parallel sibling that finishes does not end the wait', () => {
    // Captured from Claude Code (haiku, plan mode) in a /preview run: Claude
    // started a ToolSearch beside AskUserQuestion, the question opened, and the
    // search ended 30 ms later. That end used to clear the question while it
    // was still on screen: the stack top (the search) was taken as the awaited
    // tool, and any depth-0 end cleared anyway.
    const capturedSequence: SessionEvent[] = [
      { ts: 1793324718551, type: EventType.ToolStart, tool: 'AskUserQuestion', toolId: 'toolu_01Djd9eTR9LCB2GwUoBSMm6B' },
      { ts: 1793324718582, type: EventType.ToolStart, tool: 'ToolSearch', toolId: 'toolu_017cVNhQJz8pYdmH74NEBNuM', detail: 'select:WebFetch,ExitPlanMode' },
      { ts: 1793324718702, type: EventType.Idle, detail: IdleReason.Permission, tool: 'AskUserQuestion', waitKind: 'question' },
      { ts: 1793324718732, type: EventType.ToolEnd, tool: 'ToolSearch', toolId: 'toolu_017cVNhQJz8pYdmH74NEBNuM' },
    ];

    it('keeps the question open through the sibling end, awaiting the tool the event names', () => {
      for (const event of capturedSequence) engine.processEvent(SESSION_ID, event);
      const state = engine.getState(SESSION_ID);
      expect(state?.activity).toBe('permission');
      expect(state?.permissionAwaitedToolId).toBe('toolu_01Djd9eTR9LCB2GwUoBSMm6B');
      expect(state?.permissionWaitKind).toBe('question');
      expect(activityChanges[activityChanges.length - 1].reason).toMatchObject({ kind: 'permission', waitKind: 'question' });
    });

    it('ends the question on the awaited tool\'s own end', () => {
      for (const event of capturedSequence) engine.processEvent(SESSION_ID, event);
      engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'AskUserQuestion', toolId: 'toolu_01Djd9eTR9LCB2GwUoBSMm6B' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('thinking');
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      expect(engine.getState(SESSION_ID)?.permissionWaitKind).toBeNull();
    });

    // Task #952: the wait ends on the awaited tool's own end, never on another
    // tool's event. A concurrent batch starts its tools together, so a start
    // after the prompt opened is a sibling as often as the agent moving on, and
    // an early clear let a nudge type into the open prompt. A denied prompt,
    // which ends no tool, is cleared by the transcript's rejection poll, and
    // any wait by the turn's own end.
    it('holds through a new depth-0 tool start with another id: only the awaited tool ends it', () => {
      for (const event of capturedSequence) engine.processEvent(SESSION_ID, event);
      engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Read', toolId: 'read-1' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
      engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'AskUserQuestion', toolId: 'toolu_01Djd9eTR9LCB2GwUoBSMm6B' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    it('holds through a sibling\'s second end with the same id', () => {
      for (const event of capturedSequence) engine.processEvent(SESSION_ID, event);
      engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'ToolSearch', toolId: 'toolu_017cVNhQJz8pYdmH74NEBNuM' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(true);
    });

    it('ends on the turn\'s own end, for a wait whose tool never ends (a denied prompt)', () => {
      for (const event of capturedSequence) engine.processEvent(SESSION_ID, event);
      engine.processEvent(SESSION_ID, plain(EventType.Idle));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    it('a wait that names no tool still awaits the stack top, and its sibling end still holds', () => {
      engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Read', toolId: 'read-1' }));
      engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Bash', toolId: 'bash-1' }));
      engine.processEvent(SESSION_ID, permissionIdle('approval'));
      expect(engine.getState(SESSION_ID)?.permissionAwaitedToolId).toBe('bash-1');

      engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'Read', toolId: 'read-1' }));
      expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
      engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'Bash', toolId: 'bash-1' }));
      expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
    });

    describe('a wait that names a tool with no pending entry falls back to the stack top', () => {
      // Some adapters name the tool the user is asked about under a different
      // spelling than its tool start used (or name a tool whose start never
      // arrived). The wait must still attach to a pending call, not to nothing.
      it('awaits the only pending tool, which is no sibling of itself, and its own end clears the wait', () => {
        engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Read', toolId: 'read-1' }));
        engine.processEvent(SESSION_ID, permissionIdle('approval', { tool: 'Bash' }));

        const waiting = engine.getState(SESSION_ID);
        expect(waiting?.activity).toBe('permission');
        expect(waiting?.permissionAwaitedToolId).toBe('read-1');
        expect(waiting?.permissionSiblingToolIds.size).toBe(0);
        expect(engine.getStatsSnapshot(SESSION_ID)?.permissionAwaitedToolId).toBe('read-1');

        // With no awaited id, read-1 would sit in the sibling set and its own
        // end would be swallowed as a sibling finishing, stranding the wait.
        engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'Read', toolId: 'read-1' }));
        const resolved = engine.getState(SESSION_ID);
        expect(resolved?.permissionPending).toBe(false);
        expect(resolved?.permissionAwaitedToolId).toBeNull();
        expect(resolved?.activity).toBe('thinking');
      });

      it('awaits the newest pending tool, not an older one, and an older sibling finishing holds the wait', () => {
        engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Read', toolId: 'read-1' }));
        engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Grep', toolId: 'grep-1' }));
        engine.processEvent(SESSION_ID, permissionIdle('approval', { tool: 'Bash' }));

        expect(engine.getState(SESSION_ID)?.permissionAwaitedToolId).toBe('grep-1');
        expect([...(engine.getState(SESSION_ID)?.permissionSiblingToolIds ?? [])]).toEqual(['read-1']);

        engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'Read', toolId: 'read-1' }));
        expect(engine.getState(SESSION_ID)?.activity).toBe('permission');
        expect(engine.getState(SESSION_ID)?.permissionAwaitedToolId).toBe('grep-1');

        engine.processEvent(SESSION_ID, plain(EventType.ToolEnd, { tool: 'Grep', toolId: 'grep-1' }));
        expect(engine.getState(SESSION_ID)?.permissionPending).toBe(false);
      });
    });

    it('a sibling set never outlives its wait', () => {
      engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Read', toolId: 'read-1' }));
      engine.processEvent(SESSION_ID, plain(EventType.ToolStart, { tool: 'Bash', toolId: 'bash-1' }));
      engine.processEvent(SESSION_ID, permissionIdle('approval', { tool: 'Bash' }));
      expect([...(engine.getState(SESSION_ID)?.permissionSiblingToolIds ?? [])]).toEqual(['read-1']);
      engine.processEvent(SESSION_ID, plain(EventType.Prompt));
      expect(engine.getState(SESSION_ID)?.permissionSiblingToolIds.size).toBe(0);
    });
  });
});
