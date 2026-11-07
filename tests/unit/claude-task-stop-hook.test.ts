/**
 * A `TaskStop` ends the background shell it names, through the real hook
 * command, the real event bridge and a real SessionTelemetry.
 *
 * A subagent stopped a command Claude had moved to the background, Claude
 * answered "Successfully stopped task", and nothing told Kangentic. The stop
 * leaves no `<task-notification>` and the call had no PID to watch, so the shell
 * stayed open for 87 minutes, held the card's move, and recovery told the agent
 * to stop a command that no longer existed.
 *
 * The payloads carry the input and result a real transcript recorded for the
 * call (`{"task_id":"..."}` and `{message, task_id, task_type, command}`, its
 * command replaced), with the hook envelope around them that
 * `tests/fixtures/claude-tool-hook-agent-id.jsonl` captured.
 *
 * Test tier: Unit (vitest). Bridge output goes to a directory under
 * `os.tmpdir()`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHooks } from '../../src/main/agent/adapters/claude';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');
const SESSION_ID = 'task-stop-session';
const SHELL_ID = 'b0fpxcat1';

/** `buildHooks` is given paths with no spaces, so the command splits on single spaces. */
const postToolUseArgs = buildHooks('/fake/event-bridge.js', '/fake/events.jsonl', {})
  .PostToolUse[0].hooks[0].command.split(' ').slice(3);

let tmpDir: string;
let telemetry: SessionTelemetry | null = null;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-task-stop-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  telemetry?.dispose();
  telemetry = null;
});

/** What the real bridge writes for one PostToolUse stdin payload. */
function bridgeEvents(payload: Record<string, unknown>): SessionEvent[] {
  const eventsPath = path.join(tmpDir, `${Math.random().toString(36).slice(2)}.jsonl`);
  execFileSync(process.execPath, [BRIDGE, eventsPath, ...postToolUseArgs], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_01Stop', ...payload }),
    timeout: 10_000,
  });
  return fs.readFileSync(eventsPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

function taskStopEvents(taskId: string, extraFields: Record<string, unknown> = {}): SessionEvent[] {
  return bridgeEvents({
    tool_name: 'TaskStop',
    tool_input: { task_id: taskId },
    tool_response: {
      message: `Successfully stopped task: ${taskId} (sleep 600)`,
      task_id: taskId,
      task_type: 'local_bash',
      command: 'sleep 600',
    },
    ...extraFields,
  });
}

function startTelemetry(): SessionTelemetry {
  const started = new SessionTelemetry(
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
    { disableBgShellWatcher: true, activityEngineOptions: { idleStabilityWindowMs: 0 } },
  );
  started.initSession(SESSION_ID);
  telemetry = started;
  return started;
}

/** A turn that ended with one named shell still holding the card. */
function holdShell(started: SessionTelemetry): void {
  const now = Date.now();
  started.ingestEvents(SESSION_ID, [
    { ts: now, type: EventType.Prompt, detail: 'run the build' },
    { ts: now, type: EventType.ToolStart, tool: 'Bash', toolId: 'toolu_01Long', detail: 'npm run build' },
    { ts: now, type: EventType.BackgroundShellStart, tool: 'Bash', toolId: 'toolu_01Long', detail: SHELL_ID },
    { ts: now, type: EventType.Idle },
  ]);
  expect(started.getOpenWork(SESSION_ID).backgroundShells.map((shell) => shell.id)).toEqual([SHELL_ID]);
  expect(started.activityEngine.getState(SESSION_ID)?.activeBackgroundShellIds.has(SHELL_ID)).toBe(true);
}

describe('a TaskStop PostToolUse through the real bridge', () => {
  it('writes an end for the id it names, and keeps the tool\'s own tool_end', () => {
    const events = taskStopEvents(SHELL_ID);

    expect(events.map((event) => event.type)).toEqual([EventType.BackgroundShellEnd, EventType.ToolEnd]);
    expect(events[0]).toMatchObject({ tool: 'TaskStop', detail: SHELL_ID });
    expect(events[1]).toMatchObject({ tool: 'TaskStop', toolId: 'toolu_01Stop' });
  });

  it('ends the shell whichever agent stopped it: the end carries no subagent id', () => {
    const events = taskStopEvents(SHELL_ID, { agent_id: 'ab293e8960000000f' });

    expect(events[0].type).toBe(EventType.BackgroundShellEnd);
    expect(events[0].subagentId).toBeUndefined();
    expect(events[1].subagentId).toBe('ab293e8960000000f');
  });

  it('reads no end from another tool that carries a task_id', () => {
    const events = bridgeEvents({
      tool_name: 'TaskOutput',
      tool_input: { task_id: SHELL_ID },
      tool_response: { retrieval_status: 'success' },
    });

    expect(events.map((event) => event.type)).toEqual([EventType.ToolEnd]);
  });
});

describe('the end, through a real SessionTelemetry', () => {
  it('closes the engine\'s hold and the ledger, so recovery cannot name a stopped command', () => {
    const started = startTelemetry();
    holdShell(started);

    started.ingestEvents(SESSION_ID, taskStopEvents(SHELL_ID));

    expect(started.getOpenWork(SESSION_ID).backgroundShells).toEqual([]);
    expect(started.activityEngine.getState(SESSION_ID)?.activeBackgroundShellIds.size).toBe(0);
    expect(started.getSessionActivity(SESSION_ID)).toBe('idle');
  });

  it('leaves a shell alone when the stop named something else: an agent id ends nothing', () => {
    const started = startTelemetry();
    holdShell(started);

    started.ingestEvents(SESSION_ID, taskStopEvents('a82e5ff400000000f'));

    expect(started.getOpenWork(SESSION_ID).backgroundShells.map((shell) => shell.id)).toEqual([SHELL_ID]);
    expect(started.activityEngine.getState(SESSION_ID)?.activeBackgroundShellIds.has(SHELL_ID)).toBe(true);
  });
});
