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

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (cmd: string) => cmd,
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
import { EventType, IdleReason } from '../../src/shared/types';
import type { ActivityState } from '../../src/shared/types';

// Test-mode engine timings: shrink the production windows so assertions
// don't have to wall-clock-wait. The 50ms stability window lets idle
// transitions resolve within the existing 250ms waitForWatcher buffer.
//
// Every watchdog hold must be kept long enough not to fire during these
// event-driven tests (the watchdog FIRING behaviour is covered separately in
// activity-engine.test.ts with fake timers). `bgShellEscapeHatchMs` is not just
// the bg-shell hatch: it is also the threshold for the stuck-pending-tools and
// stuck-subagent watchdogs (see buildWatchdogHolds). At 500ms it tripped the
// stuck-subagent net mid-test - a nested-subagent sequence holds subagentDepth>0
// across several 250ms waitForWatcher steps with the `signal-or-pty-output`
// anchor frozen (SubagentStop is log-only and does not refresh lastSignalAt),
// so the 500ms hold fired and force-idled a still-live turn. Keep it as long as
// staleThinkingTimeoutMs so no safety net interferes; no test here waits for a
// watchdog to fire.
const TEST_ACTIVITY_ENGINE_OPTIONS = {
  bgShellEscapeHatchMs: 60_000,
  staleThinkingTimeoutMs: 60_000, // long enough not to interfere with most tests
  idleStabilityWindowMs: 50,
};

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
 * Wait for the file watcher debounce (50ms) + activity engine
 * stability window (50ms in tests) + processing slack.
 */
function waitForWatcher(): Promise<void> {
  return new Promise((r) => setTimeout(r, 250));
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtactivity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Event-derived activity state (part 2)', () => {
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
    // Let async onExit callbacks settle
    await new Promise((r) => setTimeout(r, 20));
  });

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
    });

    spawnedSessionId = session.id;
    return { session, eventsPath, ...mock };
  }

  it('idle_hint settles a subagent-delegated turn to idle', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // Turn delegated to a subagent; when it stops, turnActive is still true.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    appendEvent(eventsPath, { ts: Date.now() + 1, type: EventType.SubagentStart, detail: 'test-builder' });
    appendEvent(eventsPath, { ts: Date.now() + 2, type: EventType.SubagentStop, detail: 'test-builder' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // "Claude is waiting for your input" -> classified to idle_hint at the
    // source -> engine settles to idle through the stability window.
    appendEvent(eventsPath, { ts: Date.now() + 3, type: EventType.IdleHint, detail: 'Claude is waiting for your input' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    expect(states).toEqual(['thinking', 'idle']);
  });

  it('idle_hint does not force idle while a tool is pending', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.IdleHint, detail: 'Claude is waiting for your input' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('teammate_idle does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.TeammateIdle, detail: 'agent-2' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('task_completed does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.TaskCompleted, detail: 'Done' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('config_change does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ConfigChange });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('worktree_remove does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.WorktreeRemove, detail: '/tmp/wt' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  // --- Subagent-aware transition guard tests ---

  it('idle is not overridden by subagent tool_start', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent starts working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 2. Subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. Stop fires → idle suppressed (depth > 0), pending idle set
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. Subagent fires tool_start -- deduped (already thinking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    // Still thinking -- both idle and subagent tool_start were suppressed
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking']);
  });

  it('idle transitions to thinking when subagents finish and main agent resumes', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 2. Subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. The subagent's inner Stop fires as Idle while it is live (depth > 0).
    //    It is the subagent's stop, not the parent's, so it does not end the
    //    parent turn: the session stays thinking.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. Subagent finishes (depth → 0). The parent turn is still active, so
    //    the session stays thinking - the parent is about to consume the result.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 5. The parent fires its OWN Stop (Idle at depth 0) → idle.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 6. Main agent resumes with tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Edit' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('prompt always overrides idle regardless of subagent depth', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 2. Subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. Stop fires → idle suppressed (depth > 0), pending idle set
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. User sends a new message → prompt is thinking, but already thinking
    //    so it's deduped. However, it clears the pending idle flag.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking']);
  });

  // --- Guard 2: thinking → idle suppression while subagents are active ---

  it('thinking is not overridden by idle while subagent is active', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 2. Subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. Main agent fires Stop → idle suppressed (depth > 0)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();

    // Card stays thinking -- subagent is still working
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking']);
  });

  it('idle emits only when the parent Stops after the last subagent finishes', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 2. Subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. The subagent's inner Stop (Idle at depth > 0) does not end the parent turn.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. Subagent finishes (depth → 0); the parent turn is still active.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 5. The parent's OWN Stop (Idle at depth 0) finally emits idle.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('interrupted overrides thinking even with active subagents', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 2. Subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. User presses Escape → interrupted always goes through
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('pending idle cleared when agent resumes thinking before subagent finishes', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 2. Subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. Stop fires → idle suppressed, pending flag set
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. User sends prompt → clears pending flag (already thinking, deduped)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForWatcher();

    // 5. Subagent finishes -- but pending flag was cleared, so no deferred idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking']);
  });

  it('nested subagents: idle deferred until all subagents finish', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 2. First subagent starts (depth → 1)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. Second subagent starts (depth → 2)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Plan' });
    await waitForWatcher();

    // 4. A subagent's inner Stop (Idle at depth 2) does not end the parent turn.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 5. First subagent finishes (depth → 1) - still > 0, stays thinking.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 6. Second subagent finishes (depth → 0); the parent turn is still active.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Plan' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 7. The parent's OWN Stop (Idle at depth 0) emits idle once all are done.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  // Empirical regression test reproducing a real "stuck Idle" symptom
  // captured from a long-running session. The agent's subagent issued 4
  // parallel Read tool_starts, each one triggered a permission prompt,
  // the user granted them one at a time, then the subagent continued
  // with ~14 more reads and globs across ~70 wall-clock seconds.
  //
  // Before the fix: the activity state machine wedged at `idle` from the
  // first permission event until the user gave up and submitted a fresh
  // prompt 5 minutes later. The wedge happened because Guard 1 suppresses
  // any non-Prompt/non-SubagentStart wake event at depth > 0, so the
  // tool_starts that fired after the user resolved all permissions never
  // unstuck the state.
  //
  // After the fix: at depth == 1 (single subagent), `pendingPermissions`
  // tracks the in-flight permission count. When tool_ends balance the
  // permission events back to zero, `permissionIdle` is cleared and
  // Guard 1 stops suppressing. The next subagent tool_start cleanly wakes
  // the state. At depth >= 2 the conservative sticky behavior is
  // preserved (see 'permission idle at depth >= 2 not overridden by
  // concurrent subagent').
  it('background tool semantics: backgrounded Bash + Stop produces idle (current behavior)', async () => {
    // Documents current engine behavior for ctrl+b backgrounded tools.
    // When the agent backgrounds a long-running Bash, Claude Code fires
    // PostToolUse immediately (control returned to agent), then if the
    // agent has nothing else to do, Stop fires and the activity goes idle.
    // The backgrounded process is still running but the engine has no
    // signal for it. This test pins the current behavior so a future
    // background-tool feature is a deliberate change, not an accidental
    // regression.
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // Agent decides to background a long-running command
    appendEvent(eventsPath, { ts: 1, type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // PostToolUse fires immediately when the bash is backgrounded
    appendEvent(eventsPath, { ts: 2, type: EventType.ToolEnd, tool: 'Bash' });
    await waitForWatcher();
    // Activity stays thinking - tool_end alone does not flip state
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // Agent has nothing else to do. Stop fires.
    appendEvent(eventsPath, { ts: 3, type: EventType.Idle });
    await waitForWatcher();
    // Activity flips to idle even though the backgrounded process is
    // still running. This is a known UX limitation - the engine has no
    // signal that there's a background process. A fix would require
    // explicit background-tool tracking.
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    expect(states).toEqual(['thinking', 'idle']);
  });

  it('prompt overrides idle at depth > 0 (via interrupted)', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. interrupted → idle (bypasses Guard 2)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. prompt → thinking (Guard 1 allows prompt at any depth)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('multiple idle events at depth > 0 are idempotent', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. idle at depth > 0 → does not end the parent turn (stays thinking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. idle again at depth > 0 → idempotent (still thinking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 5. subagent_stop → depth 0; the parent turn is still active (thinking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 6. The parent's OWN Stop (Idle at depth 0) emits idle once.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    expect(states).toEqual(['thinking', 'idle']);
  });

  it('interrupted after suppressed idle does not cause duplicate idle on subagent_stop', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. idle → suppressed (pending set)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. interrupted → idle (bypasses Guard 2, pending NOT cleared)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 5. subagent_stop → depth 0, pending is true, but already idle → no duplicate
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // Only one idle transition, not two
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('orphan subagent_stop at depth 0 does not emit spurious idle', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 2. orphan subagent_stop with no prior subagent_start -- depth clamped to 0
    //    No pending idle flag was ever set, so deferred idle check is skipped
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 3. normal idle → idle (standard transition, not deferred)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // Only two transitions: thinking from step 1, idle from step 3
    // Step 2 (orphan stop) must not produce any state change
    expect(states).toEqual(['thinking', 'idle']);
  });

  // --- Permission idle bypasses Guard 2 ---

  it('normal Stop idle still suppressed at depth > 0 (no regression)', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. normal idle (no detail) → suppressed by Guard 2
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking']);
  });

  it('notification after idle does not change state', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Agent working → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    // 2. Permission request → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 3. Notification fires while idle -- should NOT flip back to thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Notification, detail: 'Context getting full' });
    await waitForWatcher();

    // Still idle -- notification is log-only
    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });
});
