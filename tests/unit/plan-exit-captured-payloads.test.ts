/**
 * Replays REAL plan-exit hook payloads through the real event-bridge.js, with
 * the directives each adapter's buildHooks emits. The fixtures under
 * tests/fixtures/plan-exit/ are live captures from a task 840 preview, with
 * paths and ids made generic:
 *
 * - Qwen Code 0.25.2, an approved plan ("Yes, and auto-accept edits"). A plan
 *   rejected in Qwen's dialog ("No, keep planning") never ran the tool, so it
 *   fired no PostToolUse at all in the same session; there is no rejected
 *   Qwen payload to capture.
 * - GitHub Copilot CLI 1.0.98, a plan rejected with feedback ("Suggest
 *   changes"), then the revised plan approved ("Accept plan and continue in
 *   Interactive execution mode"). Both fired postToolUse with
 *   `resultType: "success"`; only the result text tells them apart.
 *
 * An approved plan exit must reach the engine as `AgentTool.ExitPlanMode`, the
 * plan exit that moves the card; a rejected one must keep its own tool name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Copilot's buildHooks resolves the bridge path itself; only the event type and
// directives of the command it builds are read, so the path can be fake.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: (name: string) => `/fake/scripts/${name}.js`,
}));

import { AgentTool } from '../../src/shared/types';
import { buildHooks as buildQwenHooks } from '../../src/main/agent/adapters/qwen-code';
import { buildHooks as buildCopilotHooks } from '../../src/main/agent/adapters/copilot';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');
const FIXTURES = path.resolve(__dirname, '../fixtures/plan-exit');

let tmpDir: string;
let outputFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-exit-captured-'));
  outputFile = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

/** Run the bridge with a hook command's event type and directives, and return the event it wrote. */
function runCommand(command: string, stdin: string): Record<string, unknown> {
  // `node "<bridge>" "<events>" <eventType> <directive>...`; the mock paths
  // carry no spaces, so token 3 is the event type and the rest are directives.
  const tokens = command.split(' ');
  execFileSync(process.execPath, [BRIDGE, outputFile, tokens[3], ...tokens.slice(4)], { input: stdin, timeout: 5000 });
  return JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim()) as Record<string, unknown>;
}

function qwenPostToolUseCommand(): string {
  const entries = buildQwenHooks('/mock/.kangentic/event-bridge.js', '/mock/.kangentic/events.jsonl', {}).PostToolUse;
  return entries[entries.length - 1].hooks[0].command;
}

function copilotPostToolUseCommand(): string {
  return buildCopilotHooks('/mock/.kangentic/events.jsonl').postToolUse[0].command;
}

describe('captured plan exits through the real event bridge', () => {
  it('Qwen 0.25.2: an approved plan exit reports ExitPlanMode', () => {
    const payload = fixture('qwen-0.25.2-post-tool-use-approved.json');
    expect((JSON.parse(payload) as { tool_response: { llmContent: string } }).tool_response.llmContent).toMatch(/^User approved\./);
    expect(runCommand(qwenPostToolUseCommand(), payload)).toMatchObject({ type: 'tool_end', tool: AgentTool.ExitPlanMode });
  });

  it('Copilot 1.0.98: an approved plan exit reports ExitPlanMode', () => {
    const payload = fixture('copilot-1.0.98-post-tool-use-approved.json');
    expect(runCommand(copilotPostToolUseCommand(), payload)).toMatchObject({ type: 'tool_end', tool: AgentTool.ExitPlanMode });
  });

  it('Copilot 1.0.98: a plan rejected with feedback keeps its own tool name, so the card stays', () => {
    const payload = fixture('copilot-1.0.98-post-tool-use-rejected.json');
    // It fired as a successful tool result: only the text says it was not approved.
    expect((JSON.parse(payload) as { toolResult: { resultType: string } }).toolResult.resultType).toBe('success');
    expect(runCommand(copilotPostToolUseCommand(), payload)).toMatchObject({ type: 'tool_end', tool: 'exit_plan_mode' });
  });
});
