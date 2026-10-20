/**
 * Codex's hook payloads, replayed through the real event bridge (task #859).
 *
 * The payloads in tests/fixtures/codex-hooks/ are real hook payloads from
 * codex-cli 0.154.0 (the model field is a stand-in, and paths and ids are
 * sanitized). Each run below does what Codex does for a hook. It
 * takes the hook's command from `codexHookDefinitions()` (the exact tokens the
 * `-c hooks.<Event>=...` override carries), tokenizes it on whitespace, and runs
 * it with the working directory set to the workspace, the payload on stdin, and
 * `KANGENTIC_EVENTS_PATH` in the environment. The bridge is the shipped
 * `src/main/agent/event-bridge.js`, byte-copied to the relative path the command
 * names (`.kangentic/codex-event-bridge.cjs`), so a command that named another
 * path would fail to run at all.
 *
 * PermissionRequest and PreCompact have no captured payload yet, so they are
 * not replayed here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexHookDefinitions, CODEX_EVENT_BRIDGE_COPY_NAME } from '../../src/main/agent/adapters/codex/hook-manager';

const EVENT_BRIDGE_SOURCE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');
const FIXTURES = path.resolve(__dirname, '../fixtures/codex-hooks');

interface CodexHookPayload {
  hook_event_name: string;
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string };
}

/** One line the bridge appended to events.jsonl. */
interface BridgedEvent {
  ts?: number;
  type?: string;
  tool?: string;
  toolId?: string;
  detail?: string;
  hookContext?: string;
}

let workspace: string;
let eventsPath: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-replay-'));
  eventsPath = path.join(workspace, 'events.jsonl');
  fs.mkdirSync(path.join(workspace, '.kangentic'));
  fs.copyFileSync(EVENT_BRIDGE_SOURCE, path.join(workspace, '.kangentic', CODEX_EVENT_BRIDGE_COPY_NAME));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function readFixture(file: string): { raw: string; payload: CodexHookPayload } {
  const raw = fs.readFileSync(path.join(FIXTURES, file), 'utf-8');
  return { raw, payload: JSON.parse(raw) as CodexHookPayload };
}

/** A fixture field that must be a real value, so comparing the event to it cannot pass on two undefineds. */
function presentString(value: string | undefined, description: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`the fixture has no ${description}`);
  return value;
}

/** The hook Kangentic registers for a Codex hook event, found by the `hooks.<Event>=` name of its override. */
function commandFor(hookEventName: string): string {
  const definition = codexHookDefinitions().find((candidate) => /^hooks\.(\w+)=/.exec(candidate.override)?.[1] === hookEventName);
  if (!definition) throw new Error(`Kangentic registers no hook for ${hookEventName}`);
  return definition.command;
}

/** Run the hook for a captured payload the way Codex does, and return every event the bridge wrote. */
function replay(file: string): { payload: CodexHookPayload; events: BridgedEvent[] } {
  const { raw, payload } = readFixture(file);
  const tokens = commandFor(payload.hook_event_name).split(' ');
  expect(tokens[0]).toBe('node');
  // The first token is the program. The rest is argv as the shell form passes it:
  // the relative bridge path, the events path sentinel, the event type, the directives.
  execFileSync(process.execPath, tokens.slice(1), {
    cwd: workspace,
    input: raw,
    timeout: 10_000,
    env: { ...process.env, KANGENTIC_EVENTS_PATH: eventsPath },
  });
  // The bridge logs a malformed or unknown directive here instead of failing.
  expect(fs.existsSync(path.join(workspace, 'events-bridge.error.log'))).toBe(false);
  const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as BridgedEvent);
  return { payload, events };
}

describe('Codex hook payloads, replayed through the real event bridge', () => {
  it('SessionStart writes session_start, carrying the payload so the session id can be read from it', () => {
    const { payload, events } = replay('codex-0.154.0-session-start.json');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('session_start');
    const sessionId = presentString(payload.session_id, 'session_id');
    expect((JSON.parse(events[0].hookContext ?? '{}') as CodexHookPayload).session_id).toBe(sessionId);
  });

  it('UserPromptSubmit writes prompt, without copying the prompt text into the event', () => {
    const { events } = replay('codex-0.154.0-user-prompt-submit.json');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('prompt');
    expect(events[0]).not.toHaveProperty('hookContext');
  });

  it('PreToolUse writes tool_start with the tool, the tool use id and the command as the detail', () => {
    const { payload, events } = replay('codex-0.154.0-pre-tool-use-yielded-launch.json');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].tool).toBe(presentString(payload.tool_name, 'tool_name'));
    expect(events[0].toolId).toBe(presentString(payload.tool_use_id, 'tool_use_id'));
    expect(events[0].detail).toBe(presentString(payload.tool_input?.command, 'tool_input.command'));
  });

  it('PostToolUse writes tool_end with the tool use id of its own call, so the engine closes that tool', () => {
    const { payload, events } = replay('codex-0.154.0-post-tool-use-foreground.json');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_end');
    expect(events[0].tool).toBe(presentString(payload.tool_name, 'tool_name'));
    expect(events[0].toolId).toBe(presentString(payload.tool_use_id, 'tool_use_id'));
  });

  it('Stop writes a plain idle, with no permission detail', () => {
    const { events } = replay('codex-0.154.0-stop.json');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('idle');
    // A permission prompt is the idle that carries a detail; a turn end is not.
    expect(events[0]).not.toHaveProperty('detail');
  });
});
