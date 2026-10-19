/**
 * Unit tests for event-bridge.js - generic directive-based hook-to-JSONL bridge.
 *
 * Directives are produced by the typed builders in
 * src/main/agent/shared/directive-builders.ts and carried as
 * `<kind>:<base64(JSON)>` so they survive shell tokenization unchanged. These
 * tests build directives with the same builders the adapters use and assert
 * the emitted event shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventType } from '../../src/shared/types';
import {
  buildBridgeCommand,
  EVENTS_PATH_FROM_ENVIRONMENT,
  isKangenticHookCommand,
  quoteBridgePath,
  type HookShell,
} from '../../src/main/agent/shared/hook-utils';
import { buildPlanApprovalCommand } from '../../src/main/agent/shared/plan-approval-hook';
import { toForwardSlash } from '../../src/shared/paths';
import {
  CLI_ENVIRONMENT_REFERENCE,
  HOOK_PROBE_SEGMENT,
  installedShOrPowerShellHosts,
  runAsHookShell,
  writeArgvPrinter,
  type HookShellHost,
} from './helpers/shell-argv-probe';
import {
  captureHookContext,
  extractTool,
  extractToolId,
  extractSubagentId,
  extractPlanMode,
  extractToolPath,
  extractDetail,
  extractDetailPath,
  setDetail,
  setTypeWhen,
  setTypeWhenDetailContains,
  setTypeWhenDetailMatches,
} from '../../src/main/agent/shared/directive-builders';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');

let tmpDir: string;
let outputFile: string;

function runBridge(stdin: string, args: string[], env?: Record<string, string>): void {
  execFileSync(process.execPath, [BRIDGE, ...args], {
    input: stdin,
    timeout: 5000,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function readEvent(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim());
}

function readErrorLog(): string {
  const errorPath = outputFile.replace(/events\.jsonl$/, 'events-bridge.error.log');
  return fs.existsSync(errorPath) ? fs.readFileSync(errorPath, 'utf-8') : '';
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtbridge-'));
  outputFile = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('event-bridge', () => {
  // --- Core behavior ---

  it('writes event with type and timestamp', () => {
    runBridge('{}', [outputFile, 'idle']);
    const line = readEvent();
    expect(line.type).toBe('idle');
    expect(typeof line.ts).toBe('number');
    expect(line.tool).toBeUndefined();
    expect(line.detail).toBeUndefined();
  });

  it('appends to existing file', () => {
    runBridge('{}', [outputFile, 'idle']);
    runBridge('{}', [outputFile, 'prompt']);
    const lines = fs.readFileSync(outputFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).type).toBe('idle');
    expect(JSON.parse(lines[1]).type).toBe('prompt');
  });

  it('no output path does not crash', () => {
    runBridge('{}', []);
    expect(fs.existsSync(outputFile)).toBe(false);
  });

  // --- env: sentinel (per-session routing for static per-cwd hook files) ---
  // Adapters whose CLI has no per-session settings mechanism (Grok) write ONE
  // static hook file whose commands carry `env:<NAME>`; each spawn supplies
  // its own value through the PTY env, and a session without the variable
  // (the user's own manual CLI run in that cwd) must be a silent no-op.

  it('env: sentinel resolves the events path from the process environment', () => {
    runBridge('{}', ['env:KANGENTIC_EVENTS_PATH_TEST', 'idle'], {
      KANGENTIC_EVENTS_PATH_TEST: outputFile,
    });
    expect(readEvent().type).toBe('idle');
  });

  it('env: sentinel with the variable unset is a silent no-op', () => {
    runBridge('{}', ['env:KANGENTIC_EVENTS_PATH_UNSET_TEST', 'idle']);
    expect(fs.existsSync(outputFile)).toBe(false);
  });

  it('env: sentinel with an empty variable is a silent no-op', () => {
    runBridge('{}', ['env:KANGENTIC_EVENTS_PATH_TEST', 'idle'], {
      KANGENTIC_EVENTS_PATH_TEST: '',
    });
    expect(fs.existsSync(outputFile)).toBe(false);
  });

  it('malformed JSON stdin produces event without extracted fields', () => {
    runBridge('not json', [outputFile, 'tool_start', extractTool('tool_name')]);
    const line = readEvent();
    expect(line.type).toBe('tool_start');
    expect(line.tool).toBeUndefined();
    expect(line.detail).toBeUndefined();
  });

  // --- tool directive ---

  it('tool directive extracts tool name', () => {
    const stdin = JSON.stringify({ tool_name: 'Read' });
    runBridge(stdin, [outputFile, 'tool_start', extractTool('tool_name')]);
    const line = readEvent();
    expect(line.tool).toBe('Read');
  });

  it('tool directive with missing field produces no tool', () => {
    const stdin = JSON.stringify({ other: 'data' });
    runBridge(stdin, [outputFile, 'tool_end', extractTool('tool_name')]);
    const line = readEvent();
    expect(line.tool).toBeUndefined();
  });

  // --- detail directive (top-level) ---

  it('detail directive extracts first non-null field', () => {
    const stdin = JSON.stringify({ message: 'Context getting full' });
    runBridge(stdin, [outputFile, 'notification', extractDetail(['message', 'notification'])]);
    const line = readEvent();
    expect(line.detail).toBe('Context getting full');
  });

  it('detail directive falls through to second field', () => {
    const stdin = JSON.stringify({ notification: 'Alert' });
    runBridge(stdin, [outputFile, 'notification', extractDetail(['message', 'notification'])]);
    const line = readEvent();
    expect(line.detail).toBe('Alert');
  });

  it('detail directive truncates at the field cap (2000 chars)', () => {
    // Sized for a Bash `command`, which the git push capture reads for its
    // content; tests/unit/hook-detail-cap-parity.test.ts pins the value.
    const stdin = JSON.stringify({ name: 'a'.repeat(2500) });
    runBridge(stdin, [outputFile, 'task_completed', extractDetail(['name'])]);
    const line = readEvent();
    expect((line.detail as string).length).toBe(2000);
  });

  // --- detail directive (nested) ---

  it('nested detail extracts from nested object', () => {
    const stdin = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: 'src/main.ts' },
    });
    runBridge(stdin, [outputFile, 'tool_start', extractTool('tool_name'), extractDetail(['file_path', 'command'], { nested: 'tool_input' })]);
    const line = readEvent();
    expect(line.tool).toBe('Read');
    expect(line.detail).toBe('src/main.ts');
  });

  it('nested detail falls through to second field', () => {
    const stdin = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    runBridge(stdin, [outputFile, 'tool_start', extractTool('tool_name'), extractDetail(['file_path', 'command'], { nested: 'tool_input' })]);
    const line = readEvent();
    expect(line.tool).toBe('Bash');
    expect(line.detail).toBe('npm test');
  });

  it('nested detail with missing parent produces no detail', () => {
    const stdin = JSON.stringify({ tool_name: 'Read' });
    runBridge(stdin, [outputFile, 'tool_start', extractDetail(['file_path'], { nested: 'tool_input' })]);
    const line = readEvent();
    expect(line.detail).toBeUndefined();
  });

  // --- toolId directive (correlation ids) ---

  it('toolId extracts a top-level correlation id', () => {
    const stdin = JSON.stringify({ tool_name: 'Bash', tool_use_id: 'tu_abc' });
    runBridge(stdin, [outputFile, 'tool_start', extractToolId(['tool_use_id'])]);
    expect(readEvent().toolId).toBe('tu_abc');
  });

  it('toolId extracts a nested correlation id', () => {
    const stdin = JSON.stringify({ tool_input: { tool_use_id: 'tu_nested' } });
    runBridge(stdin, [outputFile, 'tool_start', extractToolId(['tool_use_id'], { nested: 'tool_input' })]);
    expect(readEvent().toolId).toBe('tu_nested');
  });

  it('toolId: first directive to resolve wins (top-level before nested)', () => {
    const stdin = JSON.stringify({ tool_use_id: 'tu_top', tool_input: { tool_use_id: 'tu_nested' } });
    runBridge(stdin, [outputFile, 'tool_start', extractToolId(['tool_use_id']), extractToolId(['tool_use_id'], { nested: 'tool_input' })]);
    expect(readEvent().toolId).toBe('tu_top');
  });

  // --- subagentId directive (task #759) ---

  it('subagentId extracts the subagent correlation id alongside the type', () => {
    // Shape captured from a real SubagentStop payload on CLI 2.1.290.
    const stdin = JSON.stringify({
      hook_event_name: 'SubagentStop',
      agent_id: 'a0a114181178d1064',
      agent_type: 'general-purpose',
      stop_hook_active: false,
    });
    runBridge(stdin, [outputFile, 'subagent_stop', extractDetail(['agent_type', 'subagent_type']), extractSubagentId(['agent_id'])]);
    const line = readEvent();
    expect(line.detail).toBe('general-purpose');
    expect(line.subagentId).toBe('a0a114181178d1064');
    // Never written into the tool correlation field.
    expect(line).not.toHaveProperty('toolId');
  });

  it('subagentId is absent when the payload carries no id', () => {
    const stdin = JSON.stringify({ agent_type: 'Explore' });
    runBridge(stdin, [outputFile, 'subagent_stop', extractSubagentId(['agent_id'])]);
    expect(readEvent()).not.toHaveProperty('subagentId');
  });

  it('subagentId: the first directive to resolve wins', () => {
    const stdin = JSON.stringify({ agent_id: 'a_first', subagent_id: 'a_second' });
    runBridge(stdin, [outputFile, 'subagent_start', extractSubagentId(['agent_id']), extractSubagentId(['subagent_id'])]);
    expect(readEvent().subagentId).toBe('a_first');
  });

  it('extractSubagentId rejects an empty field list', () => {
    expect(() => extractSubagentId([])).toThrow('extractSubagentId requires at least one field');
  });

  // --- planMode: whether the agent was in plan mode, as a boolean ---

  const PLAN_MODE = extractPlanMode('permission_mode', ['plan']);

  it('planMode is true when the mode field names plan mode', () => {
    runBridge(JSON.stringify({ hook_event_name: 'UserPromptSubmit', permission_mode: 'plan' }), [outputFile, 'prompt', PLAN_MODE]);
    expect(readEvent().planMode).toBe(true);
  });

  it('planMode is false for any other mode, and the mode string never reaches the event', () => {
    runBridge(JSON.stringify({ hook_event_name: 'Stop', permission_mode: 'auto' }), [outputFile, 'idle', PLAN_MODE]);
    const line = readEvent();
    expect(line.planMode).toBe(false);
    expect(JSON.stringify(line)).not.toContain('auto');
  });

  it('planMode is absent when the payload carries no mode, so the engine reads it as unknown', () => {
    runBridge(JSON.stringify({ hook_event_name: 'SessionStart' }), [outputFile, 'idle', PLAN_MODE]);
    expect(readEvent()).not.toHaveProperty('planMode');
  });

  it('planMode is absent when the mode field is not a string', () => {
    runBridge(JSON.stringify({ permission_mode: { name: 'plan' } }), [outputFile, 'idle', PLAN_MODE]);
    expect(readEvent()).not.toHaveProperty('planMode');
  });

  // The bridge writes an event whatever stdin held: empty stdin leaves its parsed
  // context null (the `input.length` check), and the JSON text `null` parses to
  // null. Both reach the `!ctx` guard in the extractPlanMode arm, which must
  // report nothing instead of reading a field off null and crashing before the
  // event is written. readEvent() throws when no event file exists, so reading
  // it is what proves the event landed.
  it('planMode is absent and the event still writes when stdin is empty', () => {
    runBridge('', [outputFile, 'idle', PLAN_MODE]);
    const line = readEvent();
    expect(line.type).toBe('idle');
    expect(line).not.toHaveProperty('planMode');
  });

  it('planMode is absent and the event still writes when stdin is the JSON null', () => {
    runBridge('null', [outputFile, 'idle', PLAN_MODE]);
    const line = readEvent();
    expect(line.type).toBe('idle');
    expect(line).not.toHaveProperty('planMode');
  });

  // Claude's Stop fires for a subagent too, carrying its agent_id, and a
  // subagent can run in its own mode while the session plans.
  const MAIN_AGENT_PLAN_MODE = extractPlanMode('permission_mode', ['plan'], { unlessField: 'agent_id' });

  it('planMode is absent on a payload that carries the unlessField, such as a subagent\'s Stop', () => {
    runBridge(JSON.stringify({ hook_event_name: 'Stop', agent_id: 'a0a114181178d1064', permission_mode: 'default' }), [outputFile, 'idle', MAIN_AGENT_PLAN_MODE]);
    expect(readEvent()).not.toHaveProperty('planMode');
  });

  it('planMode is still read from a payload without the unlessField, such as the main agent\'s Stop', () => {
    runBridge(JSON.stringify({ hook_event_name: 'Stop', permission_mode: 'plan' }), [outputFile, 'idle', MAIN_AGENT_PLAN_MODE]);
    expect(readEvent().planMode).toBe(true);
  });

  it('extractPlanMode rejects an empty value list', () => {
    expect(() => extractPlanMode('permission_mode', [])).toThrow('extractPlanMode requires at least one plan value');
  });

  // --- remap directive (top-level field) ---

  const INTERRUPT_REMAP = setTypeWhen({ field: 'is_interrupt', equals: 'true', to: EventType.Interrupted });

  it('remap changes event type when a top-level field matches value', () => {
    const stdin = JSON.stringify({ tool_name: 'Bash', is_interrupt: true, error: 'User cancelled' });
    runBridge(stdin, [outputFile, 'tool_end', extractTool('tool_name'), INTERRUPT_REMAP, extractDetail(['error'])]);
    const line = readEvent();
    expect(line.type).toBe('interrupted');
    expect(line.tool).toBe('Bash');
    expect(line.detail).toBe('User cancelled');
  });

  it('remap keeps original type when field does not match', () => {
    const stdin = JSON.stringify({ tool_name: 'Read', is_interrupt: false });
    runBridge(stdin, [outputFile, 'tool_end', extractTool('tool_name'), INTERRUPT_REMAP]);
    const line = readEvent();
    expect(line.type).toBe('tool_end');
    expect(line.tool).toBe('Read');
  });

  it('remap keeps original type with malformed stdin JSON', () => {
    runBridge('not json', [outputFile, 'tool_end', INTERRUPT_REMAP]);
    const line = readEvent();
    expect(line.type).toBe('tool_end');
  });

  // --- setTypeWhenDetailContains directive (shell-safe value with spaces) ---

  it('setTypeWhenDetailContains retypes on an extracted detail substring containing spaces', () => {
    // The substring "waiting for your input" has spaces. Because the directive
    // payload is base64-encoded, the whole directive is a single shell token,
    // so the spaces cannot split it (the bug this encoding fixes). Here we feed
    // args directly, but the value with spaces must still round-trip the wire.
    const stdin = JSON.stringify({ message: 'Claude is waiting for your input' });
    runBridge(stdin, [outputFile, 'notification',
      extractDetail(['message', 'notification']),
      setTypeWhenDetailContains('waiting for your input', EventType.IdleHint)]);
    const line = readEvent();
    expect(line.type).toBe('idle_hint');
    expect(line.detail).toBe('Claude is waiting for your input');
  });

  // --- setDetail directive ---

  it('setDetail sets a fixed detail value', () => {
    runBridge('{}', [outputFile, 'idle', setDetail('permission')]);
    const line = readEvent();
    expect(line.type).toBe('idle');
    expect(line.detail).toBe('permission');
  });

  // --- diagnostics: malformed / unknown directives ---

  it('a malformed directive payload is a no-op and is logged, the event still writes', () => {
    // Valid base64 of invalid JSON -> payload undefined -> skipped + logged.
    const malformed = 'setTypeWhen:' + Buffer.from('not json', 'utf8').toString('base64');
    runBridge(JSON.stringify({ is_interrupt: true }), [outputFile, 'tool_end', malformed]);
    const line = readEvent();
    expect(line.type).toBe('tool_end');
    expect(readErrorLog()).toContain('malformed directive');
  });

  it('a valid-JSON non-object payload (null, number) is a no-op and is logged, the event still writes', () => {
    // JSON.parse('null') and JSON.parse('42') succeed but yield non-objects.
    // The guard `payload === null || typeof payload !== 'object'` must reject
    // both without crashing the bridge - the switch case would otherwise
    // dereference a non-object and throw before the event is written.
    const nullPayload = 'setTypeWhen:' + Buffer.from('null', 'utf8').toString('base64');
    runBridge(JSON.stringify({ is_interrupt: true }), [outputFile, 'tool_end', nullPayload]);
    const lineAfterNull = readEvent();
    expect(lineAfterNull.type).toBe('tool_end');
    expect(readErrorLog()).toContain('malformed directive');

    // Also verify with a numeric payload; re-use the same tmpDir (append to the log).
    const numericPayload = 'setTypeWhen:' + Buffer.from('42', 'utf8').toString('base64');
    runBridge(JSON.stringify({ is_interrupt: true }), [outputFile, 'tool_end', numericPayload]);
    // Two events now in the file - both must have type tool_end (no crash, no retype).
    const allLines = fs.readFileSync(outputFile, 'utf-8').trim().split('\n');
    expect(allLines.length).toBe(2);
    expect(JSON.parse(allLines[1]).type).toBe('tool_end');
    expect(readErrorLog()).toContain('malformed directive');
  });

  it('an unknown directive kind is a no-op and is logged, the event still writes', () => {
    const unknown = 'bogusKind:' + Buffer.from(JSON.stringify({ x: 1 }), 'utf8').toString('base64');
    runBridge('{}', [outputFile, 'tool_start', extractTool('tool_name'), unknown]);
    const line = readEvent();
    expect(line.type).toBe('tool_start');
    expect(readErrorLog()).toContain('unknown directive kind: bogusKind');
  });

  it('setTypeWhenDetailMatches: an invalid regex pattern is a logged no-op and the event still writes with unchanged type', () => {
    // The builder encodes the pattern as a JSON string without validation.
    // At bridge execution time, `new RegExp('[invalid')` throws a SyntaxError.
    // The catch block must: (a) log the error to the sibling error log, and
    // (b) NOT crash the bridge before the event write - so the event still lands
    // with its original type unchanged.
    // A detail value is pre-extracted so the remap path is reached and only
    // the regex compile step is what stops the retype.
    const invalidPatternDirective = setTypeWhenDetailMatches('[invalid', EventType.BackgroundShellStart);
    runBridge(
      JSON.stringify({ tool_response: { shellId: 'bash_1' } }),
      [outputFile, 'tool_end',
        extractDetail(['shellId'], { nested: 'tool_response' }),
        invalidPatternDirective,
      ],
    );
    const line = readEvent();
    // Type must be unchanged (the regex threw, no retype fired).
    expect(line.type).toBe('tool_end');
    // Detail was extracted correctly before the remap was attempted.
    expect(line.detail).toBe('bash_1');
    // The error log must record the bad pattern so it is discoverable.
    expect(readErrorLog()).toContain('invalid setTypeWhenDetailMatches pattern: [invalid');
  });

  // --- session_start hookContext ---

  it('session_start captures stdin JSON as hookContext', () => {
    const stdin = JSON.stringify({
      session_id: '4231e6aa-5409-4749-9272-270e9aab079b',
      cwd: '/home/dev/project',
    });
    runBridge(stdin, [outputFile, 'session_start']);
    const line = readEvent();
    const hookCtx = JSON.parse(line.hookContext as string);
    expect(hookCtx.session_id).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
  });

  it('session_start omits hookContext when stdin is empty', () => {
    runBridge('', [outputFile, 'session_start']);
    const line = readEvent();
    expect(line.type).toBe('session_start');
    expect(line.hookContext).toBeUndefined();
  });

  it('hookContext is only captured on session_start, not other events (without the opt-in directive)', () => {
    runBridge(JSON.stringify({ session_id: 'abc' }), [outputFile, 'tool_start', extractTool('tool_name')]);
    expect(readEvent().hookContext).toBeUndefined();
  });

  // --- captureHookContext directive (agents with no once-per-session hook) ---

  it('captureHookContext captures stdin JSON on a non-session_start event', () => {
    const stdin = JSON.stringify({ conversationId: '3db42741-6af4-4632-99cf-e5f230f7bc94', modelName: 'gemini-3.7-flash-high' });
    runBridge(stdin, [outputFile, 'prompt', captureHookContext()]);
    const line = readEvent();
    expect(line.type).toBe('prompt');
    const hookCtx = JSON.parse(line.hookContext as string);
    expect(hookCtx.conversationId).toBe('3db42741-6af4-4632-99cf-e5f230f7bc94');
  });

  it('captureHookContext omits hookContext when stdin is empty or not JSON', () => {
    runBridge('', [outputFile, 'prompt', captureHookContext()]);
    expect(readEvent().hookContext).toBeUndefined();
  });

  // --- extractToolPath / extractDetailPath (nested-payload agents) ---

  it('extractToolPath extracts a nested tool name (Antigravity PostToolUse pattern)', () => {
    const stdin = JSON.stringify({
      toolCall: { name: 'write_to_file', args: { TargetFile: 'C:/ws/probe.txt' } },
    });
    runBridge(stdin, [outputFile, 'tool_end',
      extractToolPath(['toolCall', 'name']),
      extractDetailPath(['toolCall', 'args'], ['TargetFile', 'CommandLine'])]);
    const line = readEvent();
    expect(line.tool).toBe('write_to_file');
    expect(line.detail).toBe('C:/ws/probe.txt');
  });

  it('extractToolPath with a missing segment produces no tool', () => {
    runBridge(JSON.stringify({ other: 'data' }), [outputFile, 'tool_end', extractToolPath(['toolCall', 'name'])]);
    expect(readEvent().tool).toBeUndefined();
  });

  it('extractDetailPath falls through fields and skips a missing parent chain', () => {
    const stdin = JSON.stringify({ toolCall: { args: { CommandLine: 'npm test' } } });
    runBridge(stdin, [outputFile, 'tool_end',
      extractDetailPath(['toolCall', 'args'], ['TargetFile', 'CommandLine'])]);
    expect(readEvent().detail).toBe('npm test');

    fs.writeFileSync(outputFile, '');
    runBridge(JSON.stringify({}), [outputFile, 'tool_end',
      extractDetailPath(['toolCall', 'args'], ['TargetFile'])]);
    expect(readEvent().detail).toBeUndefined();
  });

  it('extractDetailPath: first directive to resolve wins (extractDetail before extractDetailPath)', () => {
    // extractDetail resolves event.detail from the top-level `message` field
    // first. The later extractDetailPath's own nested container also has a
    // matching field (`TargetFile`) with a DIFFERENT value - first-extraction-
    // wins must keep the extractDetail value, not overwrite it.
    const stdin = JSON.stringify({
      message: 'first value',
      toolCall: { args: { TargetFile: 'second value' } },
    });
    runBridge(stdin, [outputFile, 'tool_end',
      extractDetail(['message']),
      extractDetailPath(['toolCall', 'args'], ['TargetFile'])]);
    expect(readEvent().detail).toBe('first value');
  });

  // --- extractToolPath / extractDetailPath: non-object values mid-path ---
  //
  // Antigravity's own payload shape (`ctx.toolCall.name`,
  // `ctx.toolCall.args.TargetFile`) is exactly what extractToolPath /
  // extractDetailPath walk. If a future agy release ever sends a STRING or
  // an ARRAY where the bridge expects an object partway down the path, the
  // walk must degrade to "no extraction" rather than crash the hook process
  // (which would silently break the whole activity pipeline for that
  // session) or read through the primitive's own properties as if they were
  // the nested payload (e.g. a string's `.length`).

  it('extractToolPath with a primitive mid-path value does not crash and does not read through it', () => {
    // ctx.toolCall is a STRING, not an object. Without the walk's
    // `typeof value === 'object'` guard, `'hello'['length']` resolves to 5
    // and would leak as a bogus tool value - this is what pins the guard,
    // not just the absence of a crash.
    const stdin = JSON.stringify({ toolCall: 'hello' });
    runBridge(stdin, [outputFile, 'tool_end', extractToolPath(['toolCall', 'length'])]);
    expect(readEvent().tool).toBeUndefined();
  });

  it('extractToolPath walking into an array segment does not crash and produces no bogus tool', () => {
    // Arrays ARE objects in JS, so the walk's typeof guard admits them; the
    // no-extraction outcome here comes from the array simply having no
    // 'name' property, not from a type guard. Pinned as current behavior:
    // no crash, no bogus extraction.
    const stdin = JSON.stringify({ toolCall: ['first', 'second'] });
    runBridge(stdin, [outputFile, 'tool_end', extractToolPath(['toolCall', 'name'])]);
    expect(readEvent().tool).toBeUndefined();
  });

  it('extractDetailPath with a primitive at the parent segment produces no detail and does not crash', () => {
    // The walk lands on ctx.toolCall (a STRING) as the final "container".
    // The walk's own guard only rejects INTERMEDIATE non-objects, so it is
    // firstNonNull's separate `typeof container !== 'object'` check that
    // must reject this container - without it, 'hello'['length'] would leak
    // as detail: '5'.
    const stdin = JSON.stringify({ toolCall: 'hello' });
    runBridge(stdin, [outputFile, 'tool_end', extractDetailPath(['toolCall'], ['length'])]);
    expect(readEvent().detail).toBeUndefined();
  });

  // --- extractToolPath / extractTool: a non-primitive leaf must be bounded,
  // never embedded raw ---
  //
  // Both arms now match firstNonNull's own contract: `String(value).slice(0,
  // FIELD_CAP)`. Before that, `event.tool` was assigned the raw walked/looked-up
  // value with no stringify/cap - so a leaf that resolves to a nested OBJECT
  // (e.g. a future agy payload shape whose `toolCall.name` is itself a
  // structured value, or any adapter whose top-level field is an object)
  // would embed that object directly into `event`, and JSON.stringify(event)
  // would serialize it as an unbounded nested JSON blob inside the JSONL line
  // instead of a bounded string. Pinned here as the '[object Object]' string
  // coercion, exactly what `String({...})` produces.

  it('extractToolPath with a non-primitive leaf stringifies and bounds it, never embedding a raw object', () => {
    const stdin = JSON.stringify({ toolCall: { name: { nested: 'object' } } });
    runBridge(stdin, [outputFile, 'tool_end', extractToolPath(['toolCall', 'name'])]);
    const line = readEvent();
    expect(line.tool).toBe('[object Object]');
    expect(typeof line.tool).toBe('string');
  });

  it('extractTool with a top-level non-primitive field stringifies and bounds it the same way', () => {
    const stdin = JSON.stringify({ tool_name: { nested: 'object' } });
    runBridge(stdin, [outputFile, 'tool_start', extractTool('tool_name')]);
    const line = readEvent();
    expect(line.tool).toBe('[object Object]');
    expect(typeof line.tool).toBe('string');
  });

  it('extractToolPath with a normal string leaf is unchanged', () => {
    const stdin = JSON.stringify({ toolCall: { name: 'write_to_file' } });
    runBridge(stdin, [outputFile, 'tool_end', extractToolPath(['toolCall', 'name'])]);
    expect(readEvent().tool).toBe('write_to_file');
  });

  // --- No directives (events that need no extraction) ---

  it('event with no directives writes type only', () => {
    runBridge('{}', [outputFile, 'session_end']);
    const line = readEvent();
    expect(line.type).toBe('session_end');
  });

  it('prompt event with no directives', () => {
    runBridge('{}', [outputFile, 'prompt']);
    const line = readEvent();
    expect(line.type).toBe('prompt');
  });

  it('compact event with no directives', () => {
    runBridge('{}', [outputFile, 'compact']);
    const line = readEvent();
    expect(line.type).toBe('compact');
  });

  // --- Combined directives (real-world patterns) ---

  it('tool + nested detail combined (Claude PreToolUse pattern)', () => {
    const stdin = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: 'src/main.ts' },
    });
    runBridge(stdin, [outputFile, 'tool_start', extractTool('tool_name'), extractDetail(['file_path', 'command', 'query'], { nested: 'tool_input' })]);
    const line = readEvent();
    expect(line.type).toBe('tool_start');
    expect(line.tool).toBe('Read');
    expect(line.detail).toBe('src/main.ts');
  });

  it('detail with multiple candidates (subagent pattern)', () => {
    const stdin = JSON.stringify({ agent_type: 'Explore' });
    runBridge(stdin, [outputFile, 'subagent_start', extractDetail(['agent_type', 'subagent_type'])]);
    const line = readEvent();
    expect(line.type).toBe('subagent_start');
    expect(line.detail).toBe('Explore');
  });
});

describe('event-bridge directives survive real shell execution (shell form)', () => {
  // Every test above invokes the script with an ARGS ARRAY (execFileSync),
  // which bypasses the shell. But the agent CLIs run the hook `command` in
  // SHELL form - the whole string is handed to a shell that tokenizes on
  // whitespace. These tests run the FULL command string produced by
  // buildBridgeCommand through the real platform shell (execSync defaults to
  // the shell), which is the only thing that proves base64 keeps a directive
  // a single token. A regression to a plaintext wire (e.g. a value with
  // spaces like "waiting for your input") would split here, exactly the bug
  // the encoding fixes.
  let tmpDir: string;
  let outputFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtbridge-shell-'));
    outputFile = path.join(tmpDir, 'events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runViaShell(stdin: string, eventType: string, directives: string[]): Record<string, unknown> {
    // execSync runs `cmd /d /s /c "<command>"` verbatim on Windows and sh elsewhere.
    const command = buildBridgeCommand('cmd', BRIDGE, outputFile, eventType, ...directives);
    execSync(command, { input: stdin, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10000 });
    return JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim());
  }

  it('a directive whose value contains spaces is NOT split by the shell', () => {
    const emitted = runViaShell(
      JSON.stringify({ message: 'Claude is waiting for your input' }),
      'notification',
      [
        extractDetail(['message', 'notification']),
        setTypeWhenDetailContains('waiting for your input', EventType.IdleHint),
      ],
    );
    expect(emitted.type).toBe('idle_hint');
    expect(emitted.detail).toBe('Claude is waiting for your input');
  });

  it('a plain extract directive round-trips through the shell', () => {
    const emitted = runViaShell(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }),
      'tool_start',
      [extractTool('tool_name'), extractDetail(['command'], { nested: 'tool_input' })],
    );
    expect(emitted.tool).toBe('Bash');
    expect(emitted.detail).toBe('ls -la');
  });

  it('a tool-scoped setTypeWhen round-trips through the shell', () => {
    const emitted = runViaShell(
      JSON.stringify({ tool_name: 'Bash', tool_input: { run_in_background: true, command: 'sleep 5' } }),
      'tool_start',
      [
        extractTool('tool_name'),
        setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart }),
      ],
    );
    expect(emitted.type).toBe('background_shell_start');
  });
});

describe('bridge paths reach the bridge as written through each hook shell', () => {
  // Each agent CLI hands a hook or status-line command to a shell of its own
  // (measured per CLI in docs/agent-integration.md, "Paths in hook commands").
  // The probe run sets KNG_PROBE, so a shell that expands `$KNG_PROBE`,
  // `${KNG_PROBE}` or `%KNG_PROBE%` shows up as EXPANDED, and Gemini, Qwen and
  // grok's own `$NAME` replacement is what CLI_ENVIRONMENT_REFERENCE matches.
  const WINDOWS_SEGMENT = HOOK_PROBE_SEGMENT;
  // `"` and `\` cannot appear in a Windows file name, only in a POSIX one.
  const POSIX_SEGMENT = `${WINDOWS_SEGMENT} "dq" back\\slash \\"$`;
  const PLAN_SPEC = { toolField: 'tool_name', tool: 'ExitPlanMode', inputField: 'tool_input', reply: {} };
  const HOOK_SHELLS: readonly HookShell[] = ['sh-or-powershell', 'cmd', 'bare-tokens'];
  let stubRoot: string;

  beforeEach(() => {
    stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-path-'));
  });

  afterEach(() => {
    fs.rmSync(stubRoot, { recursive: true, force: true });
  });

  describe('string pins', () => {
    const singleQuotedRun = (characters: string): string => `'${characters}'`;

    it('puts $, a backtick, a quote and a backslash in single quotes on macOS and Linux', () => {
      const expected = [
        '"/home/dev/"', singleQuotedRun('$'), '"work/a"', singleQuotedRun('`'), '"b"',
        singleQuotedRun('"'), '"c"', singleQuotedRun('\\'), '"d.js"',
      ].join('');
      for (const platform of ['linux', 'darwin'] as const) {
        // Off Windows every CLI runs sh or bash, whatever shell the adapter declares.
        for (const shell of HOOK_SHELLS) {
          expect(quoteBridgePath('/home/dev/$work/a`b"c\\d.js', shell, platform)).toBe(expected);
        }
      }
    });

    it('keeps the Windows drive bare in front of the quoted runs, and leaves a plain path in plain quotes', () => {
      expect(quoteBridgePath('C:/Users/dev/$repo/events.jsonl', 'sh-or-powershell', 'win32'))
        .toBe(`C:"/Users/dev/"${singleQuotedRun('$')}"repo/events.jsonl"`);
      expect(quoteBridgePath('//server/share/$x.js', 'sh-or-powershell', 'win32'))
        .toBe(`//"server/share/"${singleQuotedRun('$')}"x.js"`);
      expect(quoteBridgePath('C:/Users/dev/repo/events.jsonl', 'sh-or-powershell', 'win32')).toBe('"C:/Users/dev/repo/events.jsonl"');
      expect(quoteBridgePath(EVENTS_PATH_FROM_ENVIRONMENT, 'sh-or-powershell', 'win32')).toBe(`"${EVENTS_PATH_FROM_ENVIRONMENT}"`);
    });

    // PowerShell reads `''` inside single quotes as a quote, so `'$''$'` would
    // reach the bridge as `$'$`. Measured on Windows PowerShell 5.1 and pwsh.
    it('puts characters that need single quotes and sit side by side in one pair', () => {
      const quotedTail = `"b/c"${singleQuotedRun('`$')}"d/"${singleQuotedRun('\u201C\u201D')}"e.js"`;
      expect(quoteBridgePath('C:/a$$b/c`$d/\u201C\u201De.js', 'sh-or-powershell', 'win32'))
        .toBe(`C:"/a"${singleQuotedRun('$$')}${quotedTail}`);
      expect(quoteBridgePath('/home/a$$b/c`$d/\u201C\u201De.js', 'sh-or-powershell', 'linux'))
        .toBe(`"/home/a"${singleQuotedRun('$$')}${quotedTail}`);
      expect(quoteBridgePath('/home/dev/a\\"$b.js', 'sh-or-powershell', 'linux'))
        .toBe(`"/home/dev/a"${singleQuotedRun('\\"$')}"b.js"`);
    });

    it('puts each PowerShell curly double quote in single quotes', () => {
      expect(quoteBridgePath('C:/a\u201Cb\u201Dc\u201Ed.js', 'sh-or-powershell', 'win32'))
        .toBe(`C:"/a"${singleQuotedRun('\u201C')}"b"${singleQuotedRun('\u201D')}"c"${singleQuotedRun('\u201E')}"d.js"`);
    });

    it('refuses a Windows path with no drive that needs quoting, which PowerShell would split', () => {
      expect(() => quoteBridgePath('relative/$x.js', 'sh-or-powershell', 'win32')).toThrow(/no drive/);
    });

    it('escapes % and steps $ outside the quotes for verbatim cmd', () => {
      expect(quoteBridgePath('C:/a%KNG_PROBE%/$x.js', 'cmd', 'win32')).toBe('"C:/a"^%"KNG_PROBE"^%"/"$"x.js"');
      expect(quoteBridgePath('C:/plain dir/x.js', 'cmd', 'win32')).toBe('"C:/plain dir/x.js"');
      expect(quoteBridgePath('C:/a$$b.js', 'cmd', 'win32')).toBe('"C:/a"$""$"b.js"');
    });

    // A backslash run in front of an inserted quote escapes it under the C
    // runtime's rules unless the run is doubled, as escapePercentForCmd does for `%`.
    it('doubles a backslash run in front of a $ that steps outside the quotes for cmd', () => {
      expect(quoteBridgePath('C:\\a\\$x.js', 'cmd', 'win32')).toBe('"C:\\a\\\\"$"x.js"');
    });

    it('passes a bare token through for bare-tokens, and refuses anything that would need a quote', () => {
      expect(quoteBridgePath('.kangentic/qwen-event-bridge.cjs', 'bare-tokens', 'win32')).toBe('.kangentic/qwen-event-bridge.cjs');
      expect(quoteBridgePath(EVENTS_PATH_FROM_ENVIRONMENT, 'bare-tokens', 'win32')).toBe(EVENTS_PATH_FROM_ENVIRONMENT);
      expect(() => quoteBridgePath('C:/plain dir/x.js', 'bare-tokens', 'win32')).toThrow(/bare-tokens/);
    });

    it('never leaves a $NAME or ${NAME} for a CLI to replace, on any platform or shell', () => {
      for (const platform of ['win32', 'linux', 'darwin'] as const) {
        for (const shell of ['sh-or-powershell', 'cmd'] as const) {
          const quoted = quoteBridgePath(`C:/k/${WINDOWS_SEGMENT}/$HOME/\${HOME:-x}/events.jsonl`, shell, platform);
          expect(CLI_ENVIRONMENT_REFERENCE.test(quoted), `${shell} on ${platform}: ${quoted}`).toBe(false);
        }
      }
    });

    it('keeps every quoted command recognizable as Kangentic\'s, so cleanup still finds it', () => {
      const bridge = `C:/Users/dev/${WINDOWS_SEGMENT}/.kangentic/build/event-bridge.js`;
      for (const shell of ['sh-or-powershell', 'cmd'] as const) {
        const command = quoteBridgePath(bridge, shell, 'win32');
        expect(isKangenticHookCommand(`node ${command} "x" tool_start`), command).toBe(true);
      }
      expect(isKangenticHookCommand(`node .kangentic/qwen-event-bridge.cjs ${EVENTS_PATH_FROM_ENVIRONMENT} tool_start`)).toBe(true);
    });
  });

  describe.runIf(process.platform === 'win32')('real Windows shells', () => {
    let trickyDirectory: string;
    let stub: string;

    beforeEach(() => {
      trickyDirectory = path.join(stubRoot, WINDOWS_SEGMENT);
      // Forward-slashed, as every builder passes a Windows path.
      stub = toForwardSlash(writeArgvPrinter(trickyDirectory));
    });

    it('a sh-or-powershell command delivers every path intact through Git Bash and both PowerShells', () => {
      const eventsPath = toForwardSlash(path.join(trickyDirectory, 'events.jsonl'));
      const decisionPath = toForwardSlash(path.join(trickyDirectory, 'plan-approval.json'));
      const eventCommand = buildBridgeCommand('sh-or-powershell', stub, eventsPath, 'tool_start');
      const planCommand = buildPlanApprovalCommand('sh-or-powershell', stub, decisionPath, eventsPath, PLAN_SPEC);
      const hosts = installedShOrPowerShellHosts();
      expect(hosts.length).toBeGreaterThan(0);
      for (const host of hosts) {
        expect(runAsHookShell(host, eventCommand).printed, host).toEqual([[eventsPath, 'tool_start']]);
        expect(runAsHookShell(host, planCommand).printed[0]?.slice(0, 2), host).toEqual([decisionPath, eventsPath]);
      }
    }, 60_000);

    it('a cmd command delivers every path intact through verbatim cmd', () => {
      const statusPath = toForwardSlash(path.join(trickyDirectory, 'status.json'));
      const command = `node ${quoteBridgePath(stub, 'cmd')} ${quoteBridgePath(statusPath, 'cmd')}`;
      expect(runAsHookShell('cmd-verbatim', command).printed).toEqual([[statusPath]]);
    }, 30_000);

    it('a bare-tokens command runs from the hook cwd in every shell, wherever that cwd is', () => {
      writeArgvPrinter(path.join(trickyDirectory, '.kangentic'), 'qwen-event-bridge.cjs');
      const command = buildBridgeCommand('bare-tokens', '.kangentic/qwen-event-bridge.cjs', EVENTS_PATH_FROM_ENVIRONMENT, 'tool_start');
      const hosts: HookShellHost[] = ['cmd-escaped', ...installedShOrPowerShellHosts()];
      for (const host of hosts) {
        expect(runAsHookShell(host, command, { cwd: trickyDirectory }).printed, host)
          .toEqual([[EVENTS_PATH_FROM_ENVIRONMENT, 'tool_start']]);
      }
    }, 60_000);

    // Why `bare-tokens` exists: the escaped cmd line Qwen builds turns every
    // `"` into `\"`, and node keeps those as part of the argument. The printer
    // runs by a bare relative name, so what it prints is that mangled argv
    // rather than a failure to start.
    it('a quoted path does not survive escaped cmd, even with no special character in it', () => {
      const printerDirectory = path.join(stubRoot, 'printer');
      writeArgvPrinter(printerDirectory);
      const command = `node print-argv.cjs ${quoteBridgePath('C:/plain dir/events.jsonl', 'sh-or-powershell')}`;
      expect(runAsHookShell('cmd-escaped', command, { cwd: printerDirectory }).printed)
        .toEqual([['"C:/plain', 'dir/events.jsonl"']]);
    }, 30_000);
  });

  // The builders quote for the platform they run on, so this runs where that is
  // POSIX (CI's Linux tier). The stub itself sits under a directory with the
  // same characters, so the bridge path is checked as well as the data paths.
  describe.runIf(process.platform !== 'win32')('real POSIX shells', () => {
    it('both hook builders deliver every path intact through sh -c and bash -c', () => {
      const trickyDirectory = path.join(stubRoot, POSIX_SEGMENT);
      const stub = writeArgvPrinter(trickyDirectory);
      const eventsPath = path.join(trickyDirectory, 'events.jsonl');
      const decisionPath = path.join(trickyDirectory, 'plan-approval.json');
      const eventCommand = buildBridgeCommand('sh-or-powershell', stub, eventsPath, 'tool_start');
      const planCommand = buildPlanApprovalCommand('sh-or-powershell', stub, decisionPath, eventsPath, PLAN_SPEC);
      const hosts = installedShOrPowerShellHosts();
      expect(hosts).toContain('sh');
      for (const host of hosts) {
        expect(runAsHookShell(host, eventCommand).printed, host).toEqual([[eventsPath, 'tool_start']]);
        expect(runAsHookShell(host, planCommand).printed[0]?.slice(0, 2), host).toEqual([decisionPath, eventsPath]);
      }
    }, 30_000);
  });
});
