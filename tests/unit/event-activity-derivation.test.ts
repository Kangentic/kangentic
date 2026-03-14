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

vi.mock('../../src/main/pty/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (cmd: string) => cmd,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { EventType } from '../../src/shared/types';
import type { ActivityState } from '../../src/shared/types';

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

/** Wait for the file watcher debounce (50ms) + processing time. */
function waitForWatcher(): Promise<void> {
  return new Promise((r) => setTimeout(r, 200));
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtactivity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Event-derived activity state', () => {
  let manager: SessionManager;
  let spawnedSessionId: string | null = null;

  beforeEach(() => {
    manager = new SessionManager(tmpDir);
  });

  afterEach(async () => {
    // Close file watchers to prevent EBUSY/EPERM on Windows cleanup
    if (spawnedSessionId) {
      manager.suspend(spawnedSessionId);
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
    });

    spawnedSessionId = session.id;
    return { session, eventsPath, ...mock };
  }

  it('default activity is idle on spawn', async () => {
    const states: ActivityState[] = [];
    manager.on('activity', (_id: string, state: ActivityState) => {
      states.push(state);
    });

    await spawnWithEvents();

    // SessionManager emits idle immediately on spawn (default state)
    expect(states).toContain('idle');

    const cache = manager.getActivityCache();
    const values = Object.values(cache);
    expect(values).toContain('idle');
  });

  it('tool_start event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('prompt event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForWatcher();

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('idle event emits idle activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // First set thinking so we can verify transition to idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // Now write idle event
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
  });

  it('tool_end does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking via tool_start
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // Collect emissions AFTER tool_start has been processed
    const statesAfter = collectActivity(manager, session.id);

    // tool_end should NOT emit any activity change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Read' });
    await waitForWatcher();

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
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 2. AskUserQuestion → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 3. User responds, new tool starts → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Edit' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('permission stall: tool_start → idle (PermissionRequest) → resumes thinking', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Bash tool starts → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 2. PermissionRequest fires → idle (permission dialog shown)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 3. User approves → tool_end + new tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('interrupted event emits idle activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // First set thinking so we can verify transition to idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // Now write interrupted event (user pressed Escape)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
  });

  it('tool_start → interrupted → prompt: full interrupt-resume cycle', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. Bash tool starts → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 2. User presses Escape → interrupted → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 3. Claude resumes with a prompt → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('AskUserQuestion answer: idle → tool_end (no change) → prompt → thinking', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so the idle transition is observable
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const states = collectActivity(manager, session.id);

    // 1. Stop hook fires → idle (AskUserQuestion waiting for input)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 2. User answers → PostToolUse fires tool_end (no change) + prompt (thinking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'AskUserQuestion' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForWatcher();
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
    await waitForWatcher();

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
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // Collect emissions after thinking is set
    const states = collectActivity(manager, session.id);

    // Write two idle events back-to-back (e.g. PermissionRequest + Stop both firing)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    appendEvent(eventsPath, { ts: Date.now() + 1, type: EventType.Idle });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    // Dedup: only one emission despite two idle events
    expect(states).toEqual(['idle']);
  });

  it('tool_failure non-interrupt maps to tool_end (no activity change)', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking via tool_start
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // Collect emissions AFTER tool_start processed
    const states = collectActivity(manager, session.id);

    // PostToolUseFailure non-interrupt: event-bridge converts to tool_end
    // (tool error, not user Escape). Should NOT change activity state.
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toHaveLength(0);
  });

  it('interrupted then idle (mixed types) emits only one idle', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const states = collectActivity(manager, session.id);

    // PostToolUseFailure(interrupt) fires interrupted, then Stop fires idle
    // Both map to 'idle' -- dedup should suppress the second emission
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Interrupted, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now() + 1, type: EventType.Idle });
    await waitForWatcher();

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
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    // Dedup: only one emission despite two tool_start events
    expect(states).toEqual(['thinking']);
  });

  // --- New event types: thinking triggers ---

  it('session_start does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so we can verify no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    // session_start should NOT change activity -- agent may be idle at prompt
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SessionStart });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('subagent_start event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('subagent_stop event does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so we can verify no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    // subagent_stop is log-only -- should NOT change activity
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('compact event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Compact });
    await waitForWatcher();

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  it('worktree_create event emits thinking activity', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.WorktreeCreate, detail: 'feature-x' });
    await waitForWatcher();

    expect(states).toContain('thinking');
    expect(manager.getActivityCache()[session.id]).toBe('thinking');
  });

  // --- New event types: no activity change ---

  it('session_end does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SessionEnd });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(statesAfter).toHaveLength(0);
  });

  it('notification event does not change activity state', async () => {
    const { session, eventsPath } = await spawnWithEvents();

    // Set thinking first so we can verify no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    const statesAfter = collectActivity(manager, session.id);

    // Notification is informational -- should NOT change activity
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Notification, detail: 'Context getting full' });
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

    // 3. Stop fires → idle suppressed (depth > 0), pending idle set
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. Subagent finishes (depth → 0) → deferred idle emits
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 5. Main agent resumes with tool_start → thinking
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

  it('deferred idle emits when last subagent finishes', async () => {
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

    // 4. Subagent finishes (depth → 0) → deferred idle emits
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
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

    // 4. Stop fires → idle suppressed
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 5. First subagent finishes (depth → 1) -- still > 0, no deferred idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 6. Second subagent finishes (depth → 0) → deferred idle emits
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Plan' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('full bug scenario: idle suppressed during 77s of subagent work', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // Reproduces the exact sequence from the bug report (events.jsonl lines 136-149)
    // 136: tool_start Agent → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();
    expect(states).toEqual(['thinking']);

    // 137: subagent_start → depth 1 (deduped, already thinking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 138: tool_start Bash (subagent's tool) → deduped
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 139: idle (Stop fires on main agent) → SUPPRESSED (depth > 0)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 140: notification → no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Notification, detail: 'Context getting full' });
    await waitForWatcher();

    // 141-147: subagent tools (Bash end, Grep, Bash, Read) -- all deduped
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Grep' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Grep' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Read' });
    await waitForWatcher();

    // Still thinking -- all subagent work was correctly suppressed/deduped
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 148: subagent_stop → depth 0, deferred idle emits
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 149: tool_end Agent → no change
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Agent' });
    await waitForWatcher();

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

  it('subagent_start clears pending idle flag', async () => {
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

    // 4. subagent_start → depth 2 (clears pending flag)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 5. subagent_stop → depth 1 (no deferred idle -- flag was cleared)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 6. subagent_stop → depth 0 (no deferred idle -- flag was cleared)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    expect(states).toEqual(['thinking']);
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

    // 3. idle → suppressed (pending = true)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. idle → suppressed again (pending still true, idempotent)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 5. subagent_stop → depth 0 → deferred idle emits once
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
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

  it('permission idle bypasses Guard 2 at depth > 0', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. permission idle → emitted immediately (bypasses Guard 2)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('permission idle stays sticky -- subagent tool_start suppressed at depth > 0', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. permission idle → emitted (bypasses Guard 2)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. tool_start at depth > 0 → suppressed (permission idle is sticky)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('permission idle suppresses all tool_starts at depth > 0', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. permission idle → emitted
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();

    // 4. tool_start at depth > 0 → suppressed (permission idle is sticky)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 5. Another tool_start → still suppressed
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Grep' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('permission idle stays through subagent_stop, recovers on depth-0 tool_start', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. permission idle → emitted
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();

    // 4. subagent_stop → depth 0, but no special recovery → stays idle
    //    (correct: permission prompt may still be blocking)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 5. User approves → tool_end (no change), then agent starts next tool
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 6. tool_start at depth 0 → Guard 1 allows → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('permission idle clears pending flag -- no stale deferred idle on subagent_stop', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. normal idle → suppressed, pending flag set
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 4. permission idle → emitted, clears pending flag
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 5. User approves, agent resumes → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    // 6. subagent_stop → depth 0, but pending flag was cleared -- no stale deferred idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

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

  it('full bug reproduction: permission idle stays sticky through all subagent events', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // Reproduces the exact sequence from the bug report (sessions 34e2fa27, 53cdfadb)
    // 1. Agent starts tool → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();
    expect(states).toEqual(['thinking']);

    // 2. Subagent starts → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. Permission prompt fires (Bash needs approval) → idle with detail='permission'
    //    Bypasses Guard 2 → UI shows idle badge immediately
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. Concurrent subagent tool_start (295ms later in real life) → suppressed
    //    OLD behavior: lastIdleWasPermission flag allowed recovery → showed green
    //    NEW behavior: Guard 1 suppresses at depth > 0 → stays idle (amber)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 5. Subagent finishes → depth 0 → no special recovery → stays idle
    //    (permission prompt may still be blocking -- don't show green!)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 6. User approves (352s later in real life) → tool_end, then next tool_start
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Edit' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('thinking');

    expect(states).toEqual(['thinking', 'idle', 'thinking']);
  });

  it('permission idle at depth >= 2 not overridden by concurrent subagent', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. Two subagents start → depth 2
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Plan' });
    await waitForWatcher();

    // 3. Permission idle → emitted (bypasses Guard 2)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. Concurrent subagent tool_start (from the other subagent) → suppressed
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 5. More subagent tool events → still suppressed
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Read' });
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Grep' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    expect(states).toEqual(['thinking', 'idle']);
  });

  it('permission idle persists through SubagentStop to depth 0', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Agent' });
    await waitForWatcher();

    // 2. subagent_start → depth 1
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStart, detail: 'Explore' });
    await waitForWatcher();

    // 3. permission idle → emitted
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. subagent_stop → depth 0 → stays idle (permission prompt may still block)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });

  it('permission idle at depth 0 recovers on next tool_start', async () => {
    const { session, eventsPath } = await spawnWithEvents();
    const states = collectActivity(manager, session.id);

    // 1. tool_start → thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
    await waitForWatcher();

    // 2. permission idle at depth 0 (no subagents)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle, detail: 'permission' });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 3. tool_start at depth 0 → Guard 1 allows (depth = 0) → recovers to thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    expect(manager.getActivityCache()[session.id]).toBe('thinking');
    expect(states).toEqual(['thinking', 'idle', 'thinking']);
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

  describe('stale thinking safety timer', () => {
    // These tests use fake timers to control the stale thinking check interval.
    // The SessionManager constructor starts a setInterval(checkStaleThinking, 15_000).
    // We use vi.useFakeTimers() so we can advance time precisely.

    let fakeManager: SessionManager;
    let fakeSpawnedSessionId: string | null = null;

    async function spawnWithEventsFake(taskId = 'task-stale') {
      const eventsPath = path.join(tmpDir, `${taskId}-events.jsonl`);
      const statusPath = path.join(tmpDir, `${taskId}-status.json`);
      const mock = createMockPty();
      vi.mocked(pty.spawn).mockReturnValue(mock.mockPty as unknown as pty.IPty);

      const session = await fakeManager.spawn({
        taskId,
        command: '',
        cwd: tmpDir,
        eventsOutputPath: eventsPath,
        statusOutputPath: statusPath,
      });

      fakeSpawnedSessionId = session.id;
      return { session, eventsPath, statusPath, ...mock };
    }

    /** Create a valid status.json string with specified total token counts. */
    function makeStatus(totalInputTokens: number, totalOutputTokens: number): string {
      return JSON.stringify({
        context_window: {
          context_window_size: 200000,
          used_percentage: 5,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          current_usage: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        cost: { total_cost_usd: 0.01 },
        model: { model_id: 'claude-sonnet-4-20250514' },
      });
    }

    function triggerUsageUpdate(
      sessionManager: SessionManager,
      sessionId: string,
      statusPath: string,
      inputTokens: number,
      outputTokens: number,
    ): void {
      fs.writeFileSync(statusPath, makeStatus(inputTokens, outputTokens));
      const internals = sessionManager as unknown as {
        sessions: Map<string, { id: string; statusOutputPath: string | null }>;
        readAndEmitUsage: (session: { id: string; statusOutputPath: string | null }) => void;
      };
      const session = internals.sessions.get(sessionId);
      if (session) internals.readAndEmitUsage(session);
    }

    function triggerEventRead(sessionManager: SessionManager, sessionId: string): void {
      const internals = sessionManager as unknown as {
        sessions: Map<string, { id: string; eventsOutputPath: string | null }>;
        readAndProcessEvents: (session: { id: string; eventsOutputPath: string | null; eventsFileOffset: number }) => void;
      };
      const session = internals.sessions.get(sessionId);
      if (session) internals.readAndProcessEvents(session as Parameters<typeof internals.readAndProcessEvents>[0]);
    }

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      fakeManager = new SessionManager();
    });

    afterEach(async () => {
      if (fakeSpawnedSessionId) {
        fakeManager.suspend(fakeSpawnedSessionId);
        fakeSpawnedSessionId = null;
      }
      fakeManager.dispose();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
    });

    it('thinking with no signals for >45s transitions to idle', async () => {
      const { session, eventsPath, statusPath } = await spawnWithEventsFake();
      const states = collectActivity(fakeManager, session.id);

      // Populate usageCache so the stale timer applies (simulates post-nucleation)
      triggerUsageUpdate(fakeManager, session.id, statusPath, 100, 50);

      // Transition to thinking via a complete tool cycle (start + end)
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Read' });
      triggerEventRead(fakeManager, session.id);
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');

      // Advance past threshold (45s) + check interval (15s)
      vi.advanceTimersByTime(60_000);

      expect(fakeManager.getActivityCache()[session.id]).toBe('idle');
      expect(states).toEqual(['thinking', 'idle']);
    });

    it('pending tool prevents stale thinking transition to idle', async () => {
      const { session, eventsPath, statusPath } = await spawnWithEventsFake();
      const states = collectActivity(fakeManager, session.id);

      // Populate usageCache so the stale timer applies (simulates post-nucleation)
      triggerUsageUpdate(fakeManager, session.id, statusPath, 100, 50);

      // Start a long-running tool (no ToolEnd yet)
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Bash' });
      triggerEventRead(fakeManager, session.id);
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');

      // Advance well past threshold -- should NOT transition to idle
      vi.advanceTimersByTime(120_000);
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');
      expect(states).toEqual(['thinking']);

      // Tool completes
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolEnd, tool: 'Bash' });
      triggerEventRead(fakeManager, session.id);

      // Now the stale thinking timer should work again
      vi.advanceTimersByTime(60_000);
      expect(fakeManager.getActivityCache()[session.id]).toBe('idle');
      expect(states).toEqual(['thinking', 'idle']);
    });

    it('event resets the stale thinking timer', async () => {
      const { session, eventsPath, statusPath } = await spawnWithEventsFake();
      const states = collectActivity(fakeManager, session.id);

      // Populate usageCache so the stale timer applies (simulates post-nucleation)
      triggerUsageUpdate(fakeManager, session.id, statusPath, 100, 50);

      // Transition to thinking
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
      triggerEventRead(fakeManager, session.id);
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');

      // Advance 40s (within threshold)
      vi.advanceTimersByTime(40_000);

      // Fire another event, resetting the timer
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Write' });
      triggerEventRead(fakeManager, session.id);

      // Advance another 40s (80s total, but only 40s since last signal)
      vi.advanceTimersByTime(40_000);

      // Should still be thinking since the timer was reset
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');
      expect(states).toEqual(['thinking']);
    });

    it('usage update resets the stale thinking timer', async () => {
      const { session, eventsPath, statusPath } = await spawnWithEventsFake();
      const states = collectActivity(fakeManager, session.id);

      // Transition to thinking
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
      triggerEventRead(fakeManager, session.id);
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');

      // Advance 40s
      vi.advanceTimersByTime(40_000);

      // Fire a usage update, resetting the timer
      triggerUsageUpdate(fakeManager, session.id, statusPath, 200, 100);

      // Advance another 40s
      vi.advanceTimersByTime(40_000);

      // Should still be thinking since usage update reset the timer
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');
      expect(states).toEqual(['thinking']);
    });

    it('timer ignores idle sessions', async () => {
      const { session } = await spawnWithEventsFake();
      const states = collectActivity(fakeManager, session.id);

      // Session starts idle (default). Advance well past the threshold.
      vi.advanceTimersByTime(120_000);

      // Should still be idle, no extra emissions
      expect(fakeManager.getActivityCache()[session.id]).toBe('idle');
      expect(states).toEqual([]);
    });

    it('normal thinking with steady signals stays thinking', async () => {
      const { session, eventsPath, statusPath } = await spawnWithEventsFake();
      const states = collectActivity(fakeManager, session.id);

      // Populate usageCache so the stale timer applies (simulates post-nucleation)
      triggerUsageUpdate(fakeManager, session.id, statusPath, 100, 50);

      // Transition to thinking
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
      triggerEventRead(fakeManager, session.id);

      // Fire events every 10s for 2 minutes
      for (let elapsed = 0; elapsed < 120_000; elapsed += 10_000) {
        vi.advanceTimersByTime(10_000);
        appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
        triggerEventRead(fakeManager, session.id);
      }

      // Should have stayed thinking throughout, no idle transitions
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');
      expect(states).toEqual(['thinking']);
    });

    it('does not mark pre-usage sessions as stale during nucleation', async () => {
      const { session, eventsPath } = await spawnWithEventsFake();
      const states = collectActivity(fakeManager, session.id);

      // Transition to thinking via prompt (simulates UserPromptSubmit during startup)
      appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
      triggerEventRead(fakeManager, session.id);
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');

      // Advance well past threshold -- should NOT go idle (no usage data yet = nucleating)
      vi.advanceTimersByTime(120_000);
      expect(fakeManager.getActivityCache()[session.id]).toBe('thinking');
      expect(states).toEqual(['thinking']);
    });
  });
});
