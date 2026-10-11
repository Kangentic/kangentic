/**
 * Replays a real-shape Claude Code UserPromptSubmit hook payload through the
 * real event-bridge.js, using the hook command Kangentic registers for it.
 *
 * Why this exists: a Command Terminal names itself from its first prompt, and
 * the prompt text reaches the namer only as the Prompt event's `detail`. The
 * Claude adapter copies the hook payload's `prompt` into `detail` when
 * `capturePromptText` is set (hook-manager.ts `buildHooks`). hook-manager.test.ts
 * only asserts the command string carries the directive, so nothing proved the
 * directive reads the field a real payload actually uses, or that task sessions
 * keep prompt text out of their events file.
 *
 * The fixture, tests/fixtures/claude-user-prompt-submit.json, is the stdin
 * Claude Code pipes to a UserPromptSubmit command hook, with sanitized values.
 * The shape comes from the UserPromptSubmit section of
 * https://code.claude.com/docs/en/hooks. JSON cannot carry a comment, so the
 * source is named here instead. It is fed to the bridge as the raw file text,
 * not re-serialized, so it stays a replay of the real wire shape.
 *
 * The hook command runs in shell form through the real platform shell, the way
 * Claude Code runs it (see the shell-form block in event-bridge.test.ts), so no
 * directive is parsed back out of the command string here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventType } from '../../src/shared/types';
import { buildHooks, ClaudeAdapter } from '../../src/main/agent/adapters/claude';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/claude-user-prompt-submit.json');

/** The bridge cuts every extracted field at this many characters (FIELD_CAP in event-bridge.js). */
const BRIDGE_FIELD_CAP = 2000;

interface UserPromptSubmitPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  prompt: string;
}

const FIXTURE_TEXT = fs.readFileSync(FIXTURE_PATH, 'utf-8');
const FIXTURE: UserPromptSubmitPayload = JSON.parse(FIXTURE_TEXT);

let tmpDir: string;
let eventsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtbridge-prompt-'));
  eventsPath = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run a hook command string through the platform shell with `stdin` piped in, as Claude Code does. */
function runHookCommand(command: string, stdin: string): void {
  execSync(command, { input: stdin, stdio: ['pipe', 'ignore', 'pipe'], timeout: 10000 });
}

function readEvents(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The single Kangentic UserPromptSubmit command `buildHooks` registers when no user hook exists. */
function userPromptSubmitCommand(hooks: ReturnType<typeof buildHooks>): string {
  const entries = hooks.UserPromptSubmit;
  expect(entries).toHaveLength(1);
  return entries[0].hooks[0].command;
}

describe('UserPromptSubmit replayed through the real event bridge (buildHooks)', () => {
  it('a Command Terminal hook copies the prompt into the Prompt event detail', () => {
    const hooks = buildHooks(BRIDGE, eventsPath, {}, { capturePromptText: true });

    runHookCommand(userPromptSubmitCommand(hooks), FIXTURE_TEXT);

    const events = readEvents(eventsPath);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.Prompt);
    expect(events[0].detail).toBe(FIXTURE.prompt);
    // Only the prompt is lifted out of the payload. The session id, cwd, and
    // transcript path must not leak into the event.
    expect(Object.keys(events[0]).sort()).toEqual(['detail', 'ts', 'type']);
  });

  it('a task session hook leaves the prompt text out of the event', () => {
    const hooks = buildHooks(BRIDGE, eventsPath, {});

    runHookCommand(userPromptSubmitCommand(hooks), FIXTURE_TEXT);

    // The Prompt event must still land (a missing event would also read as "no
    // detail"), it just carries no text from the payload.
    const events = readEvents(eventsPath);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.Prompt);
    expect(events[0].detail).toBeUndefined();
    expect(Object.keys(events[0]).sort()).toEqual(['ts', 'type']);
    expect(fs.readFileSync(eventsPath, 'utf-8')).not.toContain(FIXTURE.prompt);
  });

  it('cuts a prompt longer than the bridge field cap to 2000 characters', () => {
    // ASCII digits in a repeating pattern: the bridge slices UTF-16 units, and a
    // position-bearing pattern pins WHERE the cut lands, not just the length.
    const longPrompt = '0123456789'.repeat(250);
    expect(longPrompt.length).toBeGreaterThan(BRIDGE_FIELD_CAP);
    const hooks = buildHooks(BRIDGE, eventsPath, {}, { capturePromptText: true });

    runHookCommand(
      userPromptSubmitCommand(hooks),
      JSON.stringify({ ...FIXTURE, prompt: longPrompt }),
    );

    const events = readEvents(eventsPath);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.Prompt);
    const detail = events[0].detail as string;
    expect(detail).toHaveLength(BRIDGE_FIELD_CAP);
    expect(detail).toBe(longPrompt.slice(0, BRIDGE_FIELD_CAP));
  });
});

describe('UserPromptSubmit replayed through the hook the Claude adapter writes (buildCommand)', () => {
  // `resolveBridgeScript('event-bridge')` finds the source script through its
  // `process.cwd()` candidate under vitest, so these two need the worktree root
  // as the cwd, which a scoped `npx vitest run` from the repo root gives them.

  /**
   * Build a Claude command the way a spawn does, read the `--settings` file it
   * wrote, and return the Kangentic UserPromptSubmit hook command from it.
   */
  function writtenPromptHookCommand(capturePromptText: boolean): string {
    const sessionDir = path.join(tmpDir, '.kangentic', 'sessions', 'prompt-capture-sess');
    const statusOutputPath = path.join(sessionDir, 'status.json');
    fs.mkdirSync(sessionDir, { recursive: true });

    new ClaudeAdapter().buildCommand({
      agentPath: '/usr/bin/claude',
      taskId: 'prompt-capture-task',
      cwd: tmpDir,
      permissionMode: 'default',
      sessionId: 'prompt-capture-sess',
      statusOutputPath,
      eventsOutputPath: eventsPath,
      capturePromptText,
    });

    const merged = JSON.parse(fs.readFileSync(path.join(sessionDir, 'settings.json'), 'utf-8')) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = merged.hooks.UserPromptSubmit
      .flatMap((entry) => entry.hooks.map((hook) => hook.command))
      .filter((command) => command.includes('event-bridge'));
    expect(commands).toHaveLength(1);
    return commands[0];
  }

  it('a Command Terminal spawn captures the prompt end to end', () => {
    runHookCommand(writtenPromptHookCommand(true), FIXTURE_TEXT);

    const events = readEvents(eventsPath);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.Prompt);
    expect(events[0].detail).toBe(FIXTURE.prompt);
  });

  it('a task spawn keeps the prompt text out of its events file end to end', () => {
    runHookCommand(writtenPromptHookCommand(false), FIXTURE_TEXT);

    const events = readEvents(eventsPath);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.Prompt);
    expect(events[0].detail).toBeUndefined();
  });
});
