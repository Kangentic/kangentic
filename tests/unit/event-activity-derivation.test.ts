/**
 * Tests for event-derived activity state in SessionManager.
 *
 * When the event watcher reads JSONL events from the event-bridge, it derives
 * the activity state (thinking/idle) from the event type. This is the primary
 * mechanism for task card indicators -- the event-bridge fires for ALL tools.
 *
 * Mapping (via EventTypeActivity):
 *   tool_start      → thinking
 *   prompt          → thinking
 *   subagent_start  → thinking
 *   compact         → thinking
 *   worktree_create → thinking
 *   idle            → idle
 *   interrupted     → idle
 *   notification    → no change (informational, fires unpredictably)
 *   idle_hint       → idle only when no other holder remains (else no change)
 *   subagent_stop   → no change (subagent finishing ≠ main agent active)
 *   tool_end        → no change
 *   session_start   → no change
 *   session_end     → no change
 *   teammate_idle   → no change
 *   task_completed  → no change
 *   config_change   → no change
 *   worktree_remove → no change
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock node-pty before importing SessionManager
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (cmd: string) => cmd,
  buildSpawnClearPrelude: () => '',
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

const claudeAdapter = new ClaudeAdapter();
import { EventType } from '../../src/shared/types';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

// Test-mode engine timings: shrink the production windows so assertions
// don't have to wall-clock-wait. The 50ms stability window lets idle
// transitions commit quickly once the watcher has delivered the event.
//
// Every watchdog hold must be kept long enough not to fire during these
// event-driven tests (the watchdog FIRING behaviour is covered separately in
// activity-engine.test.ts with fake timers). `bgShellEscapeHatchMs` is not just
// the bg-shell hatch: it is also the threshold for the stuck-pending-tools and
// stuck-subagent watchdogs (see buildWatchdogHolds). At 500ms it tripped the
// stuck-subagent net mid-test - a nested-subagent sequence holds subagentDepth>0
// across several steps with the `signal-or-pty-output` anchor frozen
// (SubagentStop is log-only and does not refresh lastSignalAt), so the 500ms
// hold fired and force-idled a still-live turn. Keep it as long as
// staleThinkingTimeoutMs so no safety net interferes, even when a step is slow
// on a loaded CI runner; no test here waits for a watchdog to fire.
const TEST_ACTIVITY_ENGINE_OPTIONS = {
  bgShellEscapeHatchMs: 60_000,
  staleThinkingTimeoutMs: 60_000, // long enough not to interfere with most tests
  idleStabilityWindowMs: 50,
};

// Each wait below polls an observable condition, so a passing step returns as
// soon as the condition holds. The timeout is only the ceiling for a step on a
// starved runner; it stays below the describe's per-test timeout so a stuck
// step fails as its own assertion rather than as a generic test timeout.
const WAIT_OPTIONS = { timeout: 10_000, interval: 10 };
const TEST_TIMEOUT_MS = 30_000;

let tmpDir: string;

function createMockPty() {
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;
  const mockPty = {
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler!({ exitCode: 0 }), 0);
    }),
  };
  return { mockPty, triggerExit: (code = 0) => exitHandler?.({ exitCode: code }) };
}

/** Append one JSONL event to the events file. */
function appendEvent(filePath: string, event: Record<string, unknown>): void {
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
}

/** Collect activity emissions from the manager into an array. */
function collectActivity(manager: SessionManager, sessionId: string): ActivityState[] {
  const states: ActivityState[] = [];
  manager.on('activity', (id: string, state: ActivityState) => {
    if (id === sessionId) states.push(state);
  });
  return states;
}

/**
 * Wait for a real transition: the session's cached activity becomes `expected`.
 * Only use it when the state differs from the one before the event, otherwise
 * the poll passes before the event was delivered. Use `settle` for those steps.
 */
async function waitForActivity(
  manager: SessionManager,
  sessionId: string,
  expected: ActivityState,
): Promise<void> {
  await vi.waitFor(
    () => expect(manager.getActivityCache()[sessionId]).toBe(expected),
    WAIT_OPTIONS,
  );
}

let sentinelCounter = 0;

/**
 * Barrier for a step that must change nothing, or whose full effect must have
 * landed before the next step. A bare sleep cannot prove an event had no effect.
 *
 * It appends a sentinel `notification` (log-only: it moves no counter, no state
 * and no liveness anchor) and waits for the manager to emit that sentinel as an
 * 'event'. The watcher reads the file in order and ingests each batch event by
 * event, so once the sentinel is seen every earlier event has been through the
 * activity engine. It then waits for the engine to have no idle commit armed:
 * an idle is committed one stability window after ingest, so "sentinel seen"
 * alone would still let a wrongly derived idle land after the caller asserted.
 */
async function settle(manager: SessionManager, sessionId: string, eventsPath: string): Promise<void> {
  sentinelCounter += 1;
  const sentinelMarker = `settle-sentinel-${sentinelCounter}`;
  let sentinelSeen = false;
  const onEvent = (eventSessionId: string, event: SessionEvent): void => {
    if (
      eventSessionId === sessionId
      && event.type === EventType.Notification
      && event.detail === sentinelMarker
    ) {
      sentinelSeen = true;
    }
  };
  manager.on('event', onEvent);
  try {
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Notification, detail: sentinelMarker });
    await vi.waitFor(() => expect(sentinelSeen).toBe(true), WAIT_OPTIONS);
    await vi.waitFor(
      () => expect(manager.getActivityStatsSnapshot(sessionId)?.pendingIdleArmed).toBe(false),
      WAIT_OPTIONS,
    );
  } finally {
    manager.off('event', onEvent);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtactivity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Event-derived activity state (part 1)', { timeout: TEST_TIMEOUT_MS }, () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager({ activityEngineOptions: TEST_ACTIVITY_ENGINE_OPTIONS });
  });

  afterEach(async () => {
    // Close file watchers to prevent EBUSY/EPERM on Windows cleanup
    if (spawnedSessionId) {
      await manager.suspend(spawnedSessionId);
      spawnedSessionId = null;
    }
    // Let async onExit callbacks settle (teardown, not an assertion wait)
    await new Promise((r) => setTimeout(r, 20));
  });

  // Spawn as a resume so the session starts from a known IDLE baseline. A fresh
  // spawn now seeds the activity engine as 'thinking' (the agent is already
  // processing its initial prompt); that seed is covered by the engine and
  // spawn-flow unit tests. These tests exercise the EVENT -> activity pipeline,
  // which needs an idle starting point to observe idle->thinking transitions.
  async function spawnWithEvents(taskId = 'task-1') {
    const eventsPath = path.join(tmpDir, `${taskId}-events.jsonl`);
    const mock = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

    const session = await manager.spawn({
      taskId,
      command: '',
      cwd: tmpDir,
      eventsOutputPath: eventsPath,
      agentParser: claudeAdapter,
      resuming: true,
    });

    spawnedSessionId = session.id;
    return { session, eventsPath, ...mock };
  }

  it('default activity is idle on a resumed spawn', async () => {
    const states: ActivityState[] = [];
    manager.on('activity', (_id: string, state: ActivityState) => {
      states.push(state);
    });

    await spawnWithEvents();

    // A resume carries no fresh prompt, so SessionManager emits idle immediately
    // on spawn (a FRESH spawn seeds thinking instead - covered by the engine and
    // spawn-flow unit tests).
    expect(states).toContain('idle');

    const cache = manager.getActivityCache();
    const values = Object.values(cache);
    expect(values).toContain('idle');
  });

  it('tool_start event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('prompt event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForActivity(manager, session.id, 'thinking');

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('idle event emits idle activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // First set thinking so we can verify transition to idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    // Now write idle event
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForActivity(manager, session.id, 'idle');

    expect(manager.getActivityCache()[session.id]).toBe('idle');
  });

  it('tool_end does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking via tool_start
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    // Collect emissions AFTER tool_start has been processed
    const statesAfter = collectActivity(manager, session.id);

    // tool_end should NOT emit any activity change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Read' });
    await settle(manager, session.id, eventsPath);

    // Activity should still be thinking -- tool_end doesn't change it
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    // No activity emissions from tool_end
    expect(statesAfter).toHaveLength(0);
  });

  it('thinking → idle → thinking cycle', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Tool starts → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    // 2. AskUserQuestion → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForActivity(manager, session.id, 'idle');

    // 3. User responds, new tool starts → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Edit' });
    await waitForActivity(manager, session.id, 'thinking');
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('permission stall: tool_start → idle (PermissionRequest) → resumes thinking', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Bash tool starts → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForActivity(manager, session.id, 'thinking');

    // 2. PermissionRequest fires → idle (permission dialog shown)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForActivity(manager, session.id, 'idle');

    // 3. User approves → tool_end + new tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('interrupted event emits idle activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // First set thinking so we can verify transition to idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForActivity(manager, session.id, 'thinking');

    // Now write interrupted event (user pressed Escape)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    await waitForActivity(manager, session.id, 'idle');

    expect(manager.getActivityCache()[session.id]).toBe('idle');
  });

  it('tool_start → interrupted → prompt: full interrupt-resume cycle', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Bash tool starts → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForActivity(manager, session.id, 'thinking');

    // 2. User presses Escape → interrupted → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    await waitForActivity(manager, session.id, 'idle');

    // 3. Claude resumes with a prompt → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForActivity(manager, session.id, 'thinking');
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('AskUserQuestion answer: idle → tool_end (no change) → prompt → thinking', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so the idle transition is observable
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    const states = collectActivity(manager, session.id);

    // 1. Stop hook fires → idle (AskUserQuestion waiting for input)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForActivity(manager, session.id, 'idle');

    // 2. User answers → PostToolUse fires tool_end (no change) + prompt (thinking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'AskUserQuestion' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForActivity(manager, session.id, 'thinking');
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['idle', 'thinking']);
  });

  it('multiple events in single write batch', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // Write multiple events at once (simulates rapid tool execution)
    const events = [
      { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' },
      { ts: Date.now() + 1, type: EventType.ToolEnd, tool: 'Read' },
      { ts: Date.now() + 2, type: EventType.ToolStart, tool: 'Grep' },
      { ts: Date.now() + 3, type: EventType.ToolEnd, tool: 'Grep' },
      { ts: Date.now() + 4, type: EventType.Idle },
    ];
    const chunk = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(eventsPath, chunk);
    // The session starts idle and ends idle, so the cache cannot tell the
    // batch apart from no delivery. Wait on the emissions instead.
    await vi.waitFor(() => expect(states).toEqual(['thinking', 'idle']), WAIT_OPTIONS);
    await settle(manager, session.id, eventsPath);

    // Final state should be idle (last event)
    expect(manager.getActivityCache()[session.id]).toBe('idle');
    // Activity emissions: tool_start(thinking), idle -- dedup suppresses
    // the second tool_start since state is already 'thinking'
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('consecutive idle events emit only one activity change', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so we can verify transition to idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    // Collect emissions after thinking is set
    const states = collectActivity(manager, session.id);

    // Write two idle events back-to-back (e.g. PermissionRequest + Stop both firing)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    appendEvent(eventsPath, { ts: Date.now() + 1, type: EventType.Idle });
    await waitForActivity(manager, session.id, 'idle');
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    // Dedup: only one emission despite two idle events
    expect(states).toEqual(['idle']);
  });

  it('tool_failure non-interrupt maps to tool_end (no activity change)', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking via tool_start
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForActivity(manager, session.id, 'thinking');

    // Collect emissions AFTER tool_start processed
    const states = collectActivity(manager, session.id);

    // PostToolUseFailure non-interrupt: event-bridge converts to tool_end
    // (tool error, not user Escape). Should NOT change activity state.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toHaveLength(0);
  });

  it('interrupted then idle (mixed types) emits only one idle', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForActivity(manager, session.id, 'thinking');

    const states = collectActivity(manager, session.id);

    // PostToolUseFailure(interrupt) fires interrupted, then Stop fires idle
    // Both map to 'idle' -- dedup should suppress the second emission
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now() + 1, type: EventType.Idle });
    await waitForActivity(manager, session.id, 'idle');
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    // Only one emission despite two events mapping to idle
    expect(states).toEqual(['idle']);
  });

  it('consecutive thinking events emit only one activity change', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // Write two tool_start events back-to-back (rapid tool execution)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    appendEvent(eventsPath, { ts: Date.now() + 1, type: EventType.ToolStart, tool: 'Grep' });
    await waitForActivity(manager, session.id, 'thinking');
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    // Dedup: only one emission despite two tool_start events
    expect(states).toEqual(['thinking']);
  });

  // --- New event types: thinking triggers ---

  it('session_start does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so we can verify no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    const statesAfter = collectActivity(manager, session.id);

    // session_start should NOT change activity -- agent may be idle at prompt
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SessionStart });
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('subagent_start event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForActivity(manager, session.id, 'thinking');

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('subagent_stop event does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so we can verify no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    const statesAfter = collectActivity(manager, session.id);

    // subagent_stop is log-only -- should NOT change activity
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('compact event with no turn active changes nothing: an idle compaction is not a turn', async () => {
    // The CLI compacts an idle session on its own. Counted as a turn it showed
    // the session working for minutes and moved the turn a workflow's recovery
    // had to read.
    const { session, eventsPath } = await spawnWithEvents();
    const before = manager.getActivityCache()[session.id];
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Compact });
    await settle(manager, session.id, eventsPath);

    expect(states).not.toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe(before);
  });

  it('compact event inside a turn keeps the session thinking', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Compact });
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('worktree_create event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.WorktreeCreate, detail: 'feature-x' });
    await waitForActivity(manager, session.id, 'thinking');

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  // --- New event types: no activity change ---

  it('session_end does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    const statesAfter = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SessionEnd });
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('notification event does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so we can verify no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForActivity(manager, session.id, 'thinking');

    const statesAfter = collectActivity(manager, session.id);

    // Notification is informational -- should NOT change activity
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Notification, detail: 'Context getting full' });
    await settle(manager, session.id, eventsPath);

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

});
