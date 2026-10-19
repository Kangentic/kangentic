/**
 * Runs the REAL event-bridge.js with the directives Copilot's real buildHooks
 * emits, fed with Copilot CLI hook payloads.
 *
 * The last describe replays payloads captured from a live Copilot CLI 1.0.98
 * session (tests/fixtures/copilot-hooks/, paths and ids sanitized). The first
 * builds its payloads from the 1.0.97 bundle instead, not a live capture. Field
 * names come from the SDK's hook input types (copilot-sdk/types.d.ts:
 * PreToolUseHookInput, PostToolUseHookInput with its ToolResultObject,
 * AgentStopHookInput) and the runtime's vendored hooks.rs input structs, which
 * send `cwd` where the SDK says `workingDirectory`. Tool names are Copilot's own
 * runtime names (`view`, `powershell`, `exit_plan_mode`): only a hook
 * registered under a PascalCase event name gets Claude names and snake_case
 * fields (CLI 1.0.21 and 1.0.62), and Kangentic registers camelCase ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// buildHooks resolves the bridge path itself; the command it builds is only
// read for its event type and directives, so the path can be fake.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: (name: string) => `/fake/scripts/${name}.js`,
}));

import { buildHooks } from '../../src/main/agent/adapters/copilot';
import { AgentTool } from '../../src/shared/types';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');

let tmpDir: string;
let outputFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-hook-bridge-'));
  outputFile = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the bridge exactly as Copilot's hook for `event` would: same event type,
 * same directives, with `payload` on stdin. Returns the event it wrote.
 */
function runCopilotHook(event: string, payload: Record<string, unknown>): Record<string, unknown> {
  // `node "<bridge>" "<events>" <eventType> <directive>...`; the mock paths
  // carry no spaces, so token 3 is the event type and the rest are directives.
  const tokens = buildHooks('/mock/.kangentic/events.jsonl')[event][0].command.split(' ');
  execFileSync(process.execPath, [BRIDGE, outputFile, tokens[3], ...tokens.slice(4)], {
    input: JSON.stringify(payload),
    timeout: 5000,
  });
  return JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim()) as Record<string, unknown>;
}

const SESSION_FIELDS = {
  sessionId: '00000000-0000-0000-0000-000000000000',
  timestamp: 1792368000000,
  cwd: 'C:\\Users\\dev\\repo',
};

describe('Copilot hooks through the real event bridge (1.0.97 payload shapes)', () => {
  it('preToolUse reports a tool_start with Copilot\'s tool name', () => {
    const emitted = runCopilotHook('preToolUse', {
      ...SESSION_FIELDS,
      toolName: 'view',
      toolArgs: { path: 'C:\\Users\\dev\\repo\\README.md' },
    });
    expect(emitted).toMatchObject({ type: 'tool_start', tool: 'view' });
  });

  it('postToolUse reports a tool_end and writes none of the tool result into events.jsonl', () => {
    const emitted = runCopilotHook('postToolUse', {
      ...SESSION_FIELDS,
      toolName: 'powershell',
      toolArgs: { command: 'git status', description: 'Show status' },
      toolResult: { resultType: 'success', textResultForLlm: 'On branch main\nnothing to commit' },
    });
    expect(emitted).toMatchObject({ type: 'tool_end', tool: 'powershell' });
    expect(emitted.detail).toBeUndefined();
  });

  it('agentStop reports the turn end as idle with its stop reason', () => {
    const emitted = runCopilotHook('agentStop', {
      ...SESSION_FIELDS,
      transcriptPath: 'C:\\Users\\dev\\.copilot\\session-state\\00000000-0000-0000-0000-000000000000\\events.jsonl',
      stopReason: 'end_turn',
      stopHookActive: false,
    });
    expect(emitted).toMatchObject({ type: 'idle', detail: 'end_turn' });
  });

  it('preCompact reports a compact', () => {
    const emitted = runCopilotHook('preCompact', { ...SESSION_FIELDS, trigger: 'auto' });
    expect(emitted).toMatchObject({ type: 'compact' });
  });

  it('a rejected plan exit stays Copilot\'s own tool, so the card does not move', () => {
    // The rejection text exit_plan_mode.rs builds in 1.0.97. A live 1.0.98
    // rejection sent it as a `success` postToolUse
    // (tests/fixtures/plan-exit/copilot-1.0.98-post-tool-use-rejected.json).
    const emitted = runCopilotHook('postToolUse', {
      ...SESSION_FIELDS,
      toolName: 'exit_plan_mode',
      toolArgs: { summary: 'Add a greeting line', recommendedAction: 'interactive' },
      toolResult: {
        resultType: 'success',
        textResultForLlm: 'Plan not approved. User feedback:\n\nAlso add a second line.\n\nPlease update the plan based on this feedback and try again.',
      },
    });
    expect(emitted).toMatchObject({ type: 'tool_end', tool: 'exit_plan_mode' });
  });

  it('an approved plan exit reports ExitPlanMode, which moves the card', () => {
    // The approval text exit_plan_mode.rs builds in 1.0.97 ("You are now in
    // <mode>" then the implementation instruction for that mode).
    const emitted = runCopilotHook('postToolUse', {
      ...SESSION_FIELDS,
      toolName: 'exit_plan_mode',
      toolArgs: { summary: 'Add a greeting line', recommendedAction: 'interactive' },
      toolResult: {
        resultType: 'success',
        textResultForLlm: 'Plan approved! Exited plan mode.\n\nYou are now in interactive mode. Proceed with implementing the plan.',
      },
    });
    expect(emitted).toMatchObject({ type: 'tool_end', tool: AgentTool.ExitPlanMode });
  });

  it('renames no other tool whose result happens to start the same way', () => {
    const emitted = runCopilotHook('postToolUse', {
      ...SESSION_FIELDS,
      toolName: 'create',
      toolArgs: { path: 'C:\\Users\\dev\\repo\\notes.md' },
      toolResult: { resultType: 'success', textResultForLlm: 'Plan approved! Exited plan mode.' },
    });
    expect(emitted).toMatchObject({ type: 'tool_end', tool: 'create' });
  });
});

/** A payload captured from a live Copilot CLI 1.0.98 session. */
function livePayload(fileName: string): Record<string, unknown> {
  const fixture = path.resolve(__dirname, '../fixtures/copilot-hooks', fileName);
  return JSON.parse(fs.readFileSync(fixture, 'utf-8')) as Record<string, unknown>;
}

/**
 * One Copilot CLI 1.0.98 session in Manual Approval: a prompt that read a file
 * with `view` and ended its turn, then `/compact`.
 */
describe('Copilot live 1.0.98 payloads (tests/fixtures/copilot-hooks/)', () => {
  it('preToolUse reports a tool_start with Copilot\'s tool name', () => {
    expect(runCopilotHook('preToolUse', livePayload('copilot-1.0.98-pre-tool-use.json')))
      .toMatchObject({ type: 'tool_start', tool: 'view' });
  });

  it('agentStop reports the turn end as idle with its stop reason', () => {
    // 1.0.98 sends `stop_hook_active` in snake_case beside camelCase fields.
    // The bridge reads only `stopReason`, so the mix changes nothing.
    const payload = livePayload('copilot-1.0.98-agent-stop.json');
    expect(payload.stop_hook_active).toBe(false);
    expect(runCopilotHook('agentStop', payload)).toMatchObject({ type: 'idle', detail: 'end_turn' });
  });

  it('preCompact from /compact reports a compact', () => {
    const payload = livePayload('copilot-1.0.98-pre-compact.json');
    expect(payload.trigger).toBe('manual');
    expect(runCopilotHook('preCompact', payload)).toMatchObject({ type: 'compact' });
  });
});
