/**
 * Runs the REAL event-bridge.js with the directives Qwen's real `buildHooks`
 * emits, fed with hook payloads shaped like Qwen Code 0.24.0's.
 *
 * The payloads are built from the 0.24.0 bundle, NOT a live capture: field
 * names from `HookEventHandler.createBaseInput` and the `fire*Event` methods
 * (packages/core/src/hooks/hookEventHandler.ts), the PostToolUse
 * `tool_response` from the scheduler (`{ llmContent, returnDisplay }`), and
 * the plan exit texts from `ExitPlanModeToolInvocation`
 * (packages/core/src/tools/exitPlanMode.ts). Paths are placeholders.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentTool, EventType } from '../../src/shared/types';
import { buildHooks, QwenHookEvent } from '../../src/main/agent/adapters/qwen-code';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');

let tmpDir: string;
let outputFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-hook-bridge-'));
  outputFile = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The event type and directives of the Kangentic entry Qwen's buildHooks writes for `hookEvent`. */
function wiringOf(hookEvent: QwenHookEvent): { eventType: string; directives: string[] } {
  const hooks = buildHooks('/mock/.kangentic/event-bridge.js', '/mock/.kangentic/events.jsonl', {});
  const entries = hooks[hookEvent];
  // `node "<bridge>" "<events>" <eventType> <directive> ...`, with no spaces in the paths.
  const tokens = entries[entries.length - 1].hooks[0].command.split(' ');
  return { eventType: tokens[3], directives: tokens.slice(4) };
}

/** Run the bridge the way Qwen runs the hook for `hookEvent`, and return the event it appended. */
function runHook(hookEvent: QwenHookEvent, payload: Record<string, unknown>): Record<string, unknown> {
  const { eventType, directives } = wiringOf(hookEvent);
  execFileSync(process.execPath, [BRIDGE, outputFile, eventType, ...directives], {
    input: JSON.stringify(payload),
    timeout: 5000,
  });
  return JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim());
}

/** `createBaseInput` in 0.24.0: every payload starts with these. */
function baseInput(hookEventName: string, permissionMode: string): Record<string, unknown> {
  return {
    session_id: '00000000-0000-0000-0000-000000000000',
    transcript_path: 'C:\\Users\\dev\\.qwen\\projects\\c--users-dev-repo\\chats\\00000000-0000-0000-0000-000000000000.jsonl',
    cwd: 'C:\\Users\\dev\\repo',
    hook_event_name: hookEventName,
    timestamp: '2026-10-18T12:00:00.000Z',
    permission_mode: permissionMode,
  };
}

const PLAN = '1. Add a greeting line to hello.txt\n2. Run the tests';

/**
 * A PostToolUse for `exit_plan_mode`. `permissionMode` is the scheduler's
 * `getApprovalMode()` read after the tool ran, so an approved plan reports the
 * mode it switched to ("default" for proceed once, "auto-edit" for always).
 */
function planExitPayload(llmContent: string, returnDisplay: unknown, permissionMode: string): Record<string, unknown> {
  return {
    ...baseInput('PostToolUse', permissionMode),
    tool_name: 'exit_plan_mode',
    tool_input: { plan: PLAN },
    tool_response: { llmContent, returnDisplay },
    tool_use_id: 'toolu_1760788800000_k3j9x2m1q',
    tool_call_id: 'call_7f3c2a91',
    duration_ms: 4210,
  };
}

// The texts exitPlanMode.ts returns, verbatim from the 0.24.0 bundle.
const APPROVED = 'User approved. You can now start coding. Start with updating your todo list if applicable.';
const NOT_APPROVED = 'Plan execution was not approved. Remaining in plan mode.';
const STALE = 'Plan approval is stale because the approval mode changed. No action was taken.';
const LEADER_APPROVED = 'Leader approved. You can now start coding. Start with updating your todo list if applicable.';

describe('Qwen plan exit (PostToolUse, setToolWhen)', () => {
  it('reports an approved plan exit as ExitPlanMode, which moves the card', () => {
    const event = runHook(QwenHookEvent.PostToolUse, planExitPayload(
      APPROVED,
      { type: 'plan_summary', message: 'User approved.', plan: PLAN },
      'default',
    ));
    expect(event).toMatchObject({ type: EventType.ToolEnd, tool: AgentTool.ExitPlanMode, toolId: 'toolu_1760788800000_k3j9x2m1q' });
  });

  it('reports a plan approved into Auto Edit the same way', () => {
    const event = runHook(QwenHookEvent.PostToolUse, planExitPayload(
      APPROVED,
      { type: 'plan_summary', message: 'User approved.', plan: PLAN },
      'auto-edit',
    ));
    expect(event).toMatchObject({ type: EventType.ToolEnd, tool: AgentTool.ExitPlanMode });
  });

  it('leaves a plan exit that was not approved as Qwen\'s own tool, so the card stays', () => {
    const event = runHook(QwenHookEvent.PostToolUse, planExitPayload(NOT_APPROVED, NOT_APPROVED, 'plan'));
    expect(event).toMatchObject({ type: EventType.ToolEnd, tool: 'exit_plan_mode' });
  });

  it('leaves a stale approval as Qwen\'s own tool', () => {
    const event = runHook(QwenHookEvent.PostToolUse, planExitPayload(STALE, STALE, 'default'));
    expect(event).toMatchObject({ type: EventType.ToolEnd, tool: 'exit_plan_mode' });
  });

  it('leaves a teammate\'s plan approved by the leader as Qwen\'s own tool, since the session still plans', () => {
    const event = runHook(QwenHookEvent.PostToolUse, planExitPayload(
      LEADER_APPROVED,
      { type: 'plan_summary', message: 'Leader approved.', plan: PLAN },
      'default',
    ));
    expect(event).toMatchObject({ type: EventType.ToolEnd, tool: 'exit_plan_mode' });
  });

  it('renames no other tool whose response happens to start the same way', () => {
    const payload = planExitPayload(APPROVED, APPROVED, 'default');
    payload.tool_name = 'run_shell_command';
    payload.tool_input = { command: 'echo "User approved."' };
    const event = runHook(QwenHookEvent.PostToolUse, payload);
    expect(event).toMatchObject({ type: EventType.ToolEnd, tool: 'run_shell_command' });
  });
});

describe('Qwen tool and turn hooks', () => {
  it('PreToolUse starts the tool with its id and detail', () => {
    const event = runHook(QwenHookEvent.PreToolUse, {
      ...baseInput('PreToolUse', 'auto-edit'),
      tool_name: 'run_shell_command',
      tool_input: { command: 'npm test', description: 'Run the tests' },
      tool_use_id: 'toolu_1760788800000_a1b2c3d4e',
      tool_call_id: 'call_5b1e0c2d',
    });
    expect(event).toMatchObject({
      type: EventType.ToolStart,
      tool: 'run_shell_command',
      toolId: 'toolu_1760788800000_a1b2c3d4e',
      detail: 'npm test',
    });
  });

  it('PostToolUseFailure ends the tool, and an interrupt ends the turn', () => {
    const failure = {
      ...baseInput('PostToolUseFailure', 'auto-edit'),
      tool_use_id: 'toolu_1760788800000_a1b2c3d4e',
      tool_call_id: 'call_5b1e0c2d',
      tool_name: 'run_shell_command',
      tool_input: { command: 'npm test' },
      error: 'Command exited with code 1',
      is_interrupt: false,
      duration_ms: 812,
    };
    expect(runHook(QwenHookEvent.PostToolUseFailure, failure)).toMatchObject({
      type: EventType.ToolEnd,
      tool: 'run_shell_command',
      toolId: 'toolu_1760788800000_a1b2c3d4e',
      detail: 'Command exited with code 1',
    });

    fs.rmSync(outputFile, { force: true });
    expect(runHook(QwenHookEvent.PostToolUseFailure, { ...failure, is_interrupt: true })).toMatchObject({
      type: EventType.Interrupted,
      tool: 'run_shell_command',
    });
  });

  it('PermissionRequest is the permission idle, naming the tool that waits', () => {
    const event = runHook(QwenHookEvent.PermissionRequest, {
      ...baseInput('PermissionRequest', 'plan'),
      tool_name: 'exit_plan_mode',
      tool_input: { plan: PLAN },
    });
    // Qwen's own tool name, so the plan approval gate (which waits on
    // ExitPlanMode) leaves it alone: Qwen declares no plan auto-approval.
    expect(event).toMatchObject({ type: EventType.Idle, detail: 'permission', tool: 'exit_plan_mode' });
  });

  it('UserPromptSubmit and Stop report the session\'s plan mode', () => {
    expect(runHook(QwenHookEvent.UserPromptSubmit, {
      ...baseInput('UserPromptSubmit', 'plan'),
      prompt: 'Plan a greeting change',
    })).toMatchObject({ type: EventType.Prompt, planMode: true });

    fs.rmSync(outputFile, { force: true });
    expect(runHook(QwenHookEvent.Stop, {
      ...baseInput('Stop', 'default'),
      stop_hook_active: false,
      last_assistant_message: 'Done.',
      background_tasks: [],
      crons: [],
    })).toMatchObject({ type: EventType.Idle, planMode: false });
  });

  it('a subagent\'s Stop reports no plan mode', () => {
    const event = runHook(QwenHookEvent.Stop, {
      ...baseInput('Stop', 'plan'),
      agent_id: 'agent-3f2a',
      stop_hook_active: false,
      last_assistant_message: 'Done.',
    });
    expect(event.type).toBe(EventType.Idle);
    expect(event.planMode).toBeUndefined();
  });

  it('StopFailure fails the turn with the error type', () => {
    const event = runHook(QwenHookEvent.StopFailure, {
      ...baseInput('StopFailure', 'default'),
      error: 'rate_limit',
      error_details: '429 Too Many Requests',
      last_assistant_message: '',
    });
    expect(event).toMatchObject({ type: EventType.TurnFailed, detail: 'rate_limit' });
  });
});
