/**
 * Tests for event-derived activity state in SessionManager.
 *
 * When the event watcher reads JSONL events from the event-bridge, it derives
 * the activity state (thinking/idle) from the event type. This is the primary
 * mechanism for task card indicators — the event-bridge fires for ALL tools.
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

    // Activity should still be thinking — tool_end doesn't change it
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
    // Activity emissions: tool_start(thinking), idle — dedup suppresses
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
    // Both map to 'idle' — dedup should suppress the second emission
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

    // session_start should NOT change activity — agent may be idle at prompt
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

    // subagent_stop is log-only — should NOT change activity
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

    // Notification is informational — should NOT change activity
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

    // 3. Permission request fires → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. Subagent fires tool_start while main agent is idle — should be suppressed
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.ToolStart, tool: 'Read' });
    await waitForWatcher();

    // Still idle — subagent tool_start was suppressed
    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
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

    // 3. Permission request → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. Subagent finishes (depth → 0)
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.SubagentStop, detail: 'Explore' });
    await waitForWatcher();

    // 5. Main agent resumes with tool_start — now allowed (depth 0)
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

    // 3. Permission request → idle
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Idle });
    await waitForWatcher();
    expect(manager.getActivityCache()[session.id]).toBe('idle');

    // 4. User sends a new message → prompt always transitions regardless of depth
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Prompt });
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

    // 3. Notification fires while idle — should NOT flip back to thinking
    appendEvent(eventsPath, { ts: Date.now(), type: EventType.Notification, detail: 'Context getting full' });
    await waitForWatcher();

    // Still idle — notification is log-only
    expect(manager.getActivityCache()[session.id]).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']);
  });
});
