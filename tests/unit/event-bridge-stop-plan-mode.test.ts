/**
 * Replays a real-shape Claude Code Stop hook payload through the real
 * event-bridge.js, using the Stop hook command Kangentic registers.
 *
 * Why this exists: the Stop hook reports whether the session was in plan mode
 * when the turn ended (`planMode` on the Idle event), and skips that report for
 * a subagent. The bridge decides both from fields of the payload Claude Code
 * pipes in, which is input from outside the TypeScript boundary. Every other
 * Stop test builds its JSON by hand, so none of them proved the directive reads
 * the field names a real payload uses.
 *
 * The fixture, tests/fixtures/claude-stop.json, is the Stop input example from
 * the Stop section of https://code.claude.com/docs/en/hooks, with the paths
 * sanitized. JSON cannot carry a comment, so the source is named here instead.
 * It is fed to the bridge as the raw file text for the unmodified cases, so
 * they stay a replay of the real wire shape.
 *
 * What the vendor reference says about the fields these tests vary:
 * - `permission_mode` is a common input field present on every hook event. The
 *   Stop example carries `"permission_mode": "default"`.
 * - `agent_id` and `agent_type` are common input fields that appear when a hook
 *   fires inside a subagent. The SubagentStop example carries
 *   `"agent_id": "def456"` and `"agent_type": "Explore"`.
 * - `agent_type` is also present, without `agent_id`, when the session was
 *   started with `--agent`. That is the main agent running as a named agent, so
 *   its Stop must still report plan mode. Keying the skip on `agent_type`
 *   instead of `agent_id` would blind such a session to its own plan mode.
 *
 * The hook command runs in shell form through the shell Claude Code runs it in
 * (see event-bridge-prompt-capture.test.ts), so no directive is parsed back out
 * of the command string here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventType } from '../../src/shared/types';
import { toForwardSlash } from '../../src/shared/paths';
import { buildHooks } from '../../src/main/agent/adapters/claude';
import { installedShOrPowerShellHosts, runAsHookShell } from './helpers/shell-argv-probe';

const BRIDGE = toForwardSlash(path.resolve(__dirname, '../../src/main/agent/event-bridge.js'));
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/claude-stop.json');

interface StopBackgroundTask {
  id: string;
  type: string;
  status: string;
  description: string;
  command: string;
}

interface StopSessionCron {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

interface StopPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
  background_tasks: StopBackgroundTask[];
  session_crons: StopSessionCron[];
  agent_id?: string;
  agent_type?: string;
}

const FIXTURE_TEXT = fs.readFileSync(FIXTURE_PATH, 'utf-8');
const FIXTURE: StopPayload = JSON.parse(FIXTURE_TEXT);

let tmpDir: string;
let eventsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtbridge-stop-'));
  eventsPath = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run a hook command string through the shell Claude Code uses here, with `stdin` piped in. */
function runHookCommand(command: string, stdin: string): void {
  const [host] = installedShOrPowerShellHosts();
  runAsHookShell(host, command, { input: stdin });
}

function readEvents(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The single Kangentic Stop command `buildHooks` registers when no user hook exists. */
function stopCommand(hooks: ReturnType<typeof buildHooks>): string {
  const entries = hooks.Stop;
  expect(entries).toHaveLength(1);
  return entries[0].hooks[0].command;
}

/** Replay `stdin` through the registered Stop command and return the one event it wrote. */
function replayStop(stdin: string): Record<string, unknown> {
  const hooks = buildHooks(BRIDGE, toForwardSlash(eventsPath), {});
  runHookCommand(stopCommand(hooks), stdin);
  const events = readEvents(eventsPath);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe(EventType.Idle);
  return events[0];
}

describe('Stop replayed through the real event bridge (buildHooks)', () => {
  it('reports planMode false for a default-mode turn and leaks nothing else from the payload', () => {
    // A false below only means something if the fixture really is not in plan mode.
    expect(FIXTURE.permission_mode).toBe('default');

    const event = replayStop(FIXTURE_TEXT);

    expect(event.planMode).toBe(false);
    // Only the type, the timestamp, and the plan-mode boolean reach the event.
    expect(Object.keys(event).sort()).toEqual(['planMode', 'ts', 'type']);
    const eventsText = fs.readFileSync(eventsPath, 'utf-8');
    expect(eventsText).not.toContain('permission_mode');
    expect(eventsText).not.toContain(FIXTURE.last_assistant_message);
    expect(eventsText).not.toContain(FIXTURE.background_tasks[0].command);
  });

  it('reports planMode true when the payload permission_mode is plan', () => {
    const event = replayStop(JSON.stringify({ ...FIXTURE, permission_mode: 'plan' }));

    expect(event.planMode).toBe(true);
    expect(Object.keys(event).sort()).toEqual(['planMode', 'ts', 'type']);
  });

  it('reports no planMode for a subagent Stop, which carries agent_id and agent_type', () => {
    // permission_mode is 'plan' so a subagent whose Stop leaked a report would
    // show up as planMode true, not as a false that reads like a default mode.
    const subagentStop: StopPayload = {
      ...FIXTURE,
      permission_mode: 'plan',
      agent_id: 'def456',
      agent_type: 'Explore',
    };

    const event = replayStop(JSON.stringify(subagentStop));

    expect(event).not.toHaveProperty('planMode');
    expect(Object.keys(event).sort()).toEqual(['ts', 'type']);
  });

  it('still reports planMode when only agent_type is present, as in a session started with --agent', () => {
    // The main agent of a `--agent` session carries agent_type but no agent_id.
    // permission_mode is 'plan' so a skip keyed on agent_type would leave the
    // property missing, which is distinct from a plain false.
    const namedAgentStop: StopPayload = {
      ...FIXTURE,
      permission_mode: 'plan',
      agent_type: 'Explore',
    };

    const event = replayStop(JSON.stringify(namedAgentStop));

    expect(event.planMode).toBe(true);
  });
});
