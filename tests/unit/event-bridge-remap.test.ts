/**
 * Unit tests for the setTypeWhen / setTypeWhenDetailContains directives in
 * event-bridge.js, covering the background-shell event type changes for
 * run_in_background / KillBash tracking AND the foreground Agent/Task
 * completion that must NEVER be mis-mapped to a background-shell event.
 *
 * event-bridge.js is a standalone Node script that runs in ~100ms vs the
 * E2E tier's ~3-5s Electron launch, so these run as fast unit tests that
 * feed real-shape Claude hook payloads on stdin and assert the emitted
 * event `type` / `detail`.
 *
 * Directives are built with the same typed builders the Claude adapter uses
 * (src/main/agent/shared/directive-builders.ts), so the tested wire format
 * matches what hook-manager.ts actually emits.
 *
 * Covered scenarios:
 * - PreToolUse: run_in_background -> background_shell_start; KillBash -> background_shell_end
 * - PostToolUse: Agent/Task completion (status:"completed") stays tool_end (NOT bg-shell end)
 * - PostToolUse: backgrounded Bash launch promotes with the real `shellId`
 * - setTypeWhen is tool-scoped (whenTool) and shell-safe (base64 payload)
 *
 * Real Claude Code hook payload shapes are used throughout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventType } from '../../src/shared/types';
import { extractTool, extractToolId, extractDetail, setTypeWhen, setTypeWhenDetailContains, setTypeWhenDetailMatches } from '../../src/main/agent/shared/directive-builders';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');

let tmpDir: string;
let outputFile: string;

function runBridge(stdinContent: string, args: string[]): void {
  execFileSync(process.execPath, [BRIDGE, ...args], {
    input: stdinContent,
    timeout: 5000,
  });
}

function readEvent(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim());
}

/** True when the bridge appended at least one event (file exists, non-empty). */
function outputEmitted(): boolean {
  return fs.existsSync(outputFile) && fs.readFileSync(outputFile, 'utf-8').trim().length > 0;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtbridge-remap-'));
  outputFile = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The exact directive set Claude's PreToolUse hook wires (built via the
 *  same typed builders hook-manager.ts uses). */
const PRETOOLUSE_DIRECTIVES = [
  extractTool('tool_name'),
  // shell_id first so KillBash + future shell-aware events surface
  // their identity. Falls through to file_path/command/etc otherwise.
  extractDetail(['shell_id', 'file_path', 'command', 'query', 'pattern', 'url', 'description'], { nested: 'tool_input' }),
  setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart }),
  setTypeWhen({ field: 'tool_name', equals: 'KillBash', to: EventType.BackgroundShellEnd }),
];

/** The exact directive set Claude's PostToolUse hook wires after the
 *  tool-blind-remap fix. Note: NO status-based remap (those mis-mapped
 *  Agent completions), and the bg-shell id field list is camelCase-first.
 *  The remap keys on the EXTRACTED shell-id detail (not run_in_background) so
 *  a foreground Bash that Claude auto-backgrounds on TIMEOUT - which never
 *  carries run_in_background:true but DOES carry an assigned shell id in
 *  tool_response - still promotes to background_shell_start (#187). */
const POSTTOOLUSE_DIRECTIVES = [
  extractTool('tool_name'),
  extractToolId(['tool_use_id']),
  extractToolId(['tool_use_id'], { nested: 'tool_response' }),
  extractDetail(['shellId', 'shell_id', 'backgroundTaskId', 'bash_id'], { nested: 'tool_response' }),
  setTypeWhenDetailMatches('^[\\w-]{1,64}$', EventType.BackgroundShellStart),
];

describe('event-bridge background-shell events (PreToolUse)', () => {
  it('retypes tool_start to background_shell_start when tool_input.run_in_background is true', () => {
    // Real-shape Claude Code PreToolUse hook payload for a backgrounded
    // Bash invocation. The Bash-scoped setTypeWhen fires on run_in_background.
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: {
        command: 'npx playwright test --project=ui',
        description: 'Run UI tests in the background',
        run_in_background: true,
      },
    });

    runBridge(stdinContent, [outputFile, 'tool_start', ...PRETOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_start');
    expect(emitted.tool).toBe('Bash');
    // extractDetail still extracts the command because extractDetail and
    // setTypeWhen operate on the same object without interfering.
    expect(emitted.detail).toBe('npx playwright test --project=ui');
  });

  it('does NOT retype when run_in_background is absent (foreground Bash)', () => {
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la', description: 'List files' },
    });

    runBridge(stdinContent, [outputFile, 'tool_start', ...PRETOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('tool_start');
    expect(emitted.tool).toBe('Bash');
    expect(emitted.detail).toBe('ls -la');
  });

  it('does NOT retype when run_in_background is false', () => {
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git status', run_in_background: false },
    });

    runBridge(stdinContent, [outputFile, 'tool_start', ...PRETOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('tool_start');
    expect(emitted.tool).toBe('Bash');
  });

  it('retypes tool_start to background_shell_end for KillBash', () => {
    const stdinContent = JSON.stringify({
      tool_name: 'KillBash',
      tool_input: { shell_id: 'bash_1' },
    });

    runBridge(stdinContent, [outputFile, 'tool_start', ...PRETOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_end');
    expect(emitted.tool).toBe('KillBash');
    // shell_id is extracted as detail so the engine can match it
    // against tracked background shell ids (Set-based path).
    expect(emitted.detail).toBe('bash_1');
  });

  it('extracts shell_id as detail when KillBash payload includes it', () => {
    const stdinContent = JSON.stringify({
      tool_name: 'KillBash',
      tool_input: { shell_id: 'bash_42' },
    });
    runBridge(stdinContent, [outputFile, 'tool_start', ...PRETOOLUSE_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_end');
    expect(emitted.detail).toBe('bash_42');
  });

  it('falls through to command when shell_id is absent (foreground Bash)', () => {
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la', description: 'List files' },
    });
    runBridge(stdinContent, [outputFile, 'tool_start', ...PRETOOLUSE_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('tool_start');
    // shell_id absent, falls through to command
    expect(emitted.detail).toBe('ls -la');
  });

  it('tool-scopes run_in_background to Bash: a KillBash carrying it still ends, never starts', () => {
    // A KillBash with an incidental run_in_background:true. The
    // run_in_background setTypeWhen is gated on whenTool:'Bash', so it does NOT
    // fire for KillBash; the tool_name=KillBash rule does -> end. This is
    // the structural protection against tool-blind remaps.
    const stdinContent = JSON.stringify({
      tool_name: 'KillBash',
      tool_input: { shell_id: 'bash_1', run_in_background: true },
    });

    runBridge(stdinContent, [outputFile, 'tool_start', ...PRETOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_end');
    expect(emitted.tool).toBe('KillBash');
    expect(emitted.detail).toBe('bash_1');
  });
});

describe('event-bridge tool completions (PostToolUse)', () => {
  it('T1: a foreground Agent/Task completion (status:"completed") stays tool_end, never background_shell_end', () => {
    // THE BUG: a tool-blind status remap mapped this to background_shell_end,
    // draining a real bg-shell count -> premature idle / false "task done".
    // The Agent tool reports status:"completed" in tool_response on normal
    // foreground completion; it must remain a plain tool_end.
    const stdinContent = JSON.stringify({
      tool_name: 'Agent',
      tool_input: { description: 'Explore prompt template code', subagent_type: 'Explore' },
      tool_response: { status: 'completed', content: '...summary...' },
      tool_use_id: 'toolu_agent_1',
    });

    runBridge(stdinContent, [outputFile, 'tool_end', ...POSTTOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('tool_end');
    expect(emitted.tool).toBe('Agent');
  });

  it('T2: a backgrounded Bash launch promotes with the real camelCase shellId', () => {
    // PostToolUse for Bash(run_in_background:true). tool_response carries
    // the assigned shell id as `shellId` (camelCase). The bridge emits a
    // second background_shell_start with that id so the engine promotes the
    // anonymous slot (from PreToolUse) to a named slot -> count stays 1.
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npx playwright test --project=electron', run_in_background: true },
      tool_response: { shellId: 'bash_1', exitCode: null },
      tool_use_id: 'toolu_bash_1',
    });

    runBridge(stdinContent, [outputFile, 'tool_end', ...POSTTOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_start');
    expect(emitted.tool).toBe('Bash');
    expect(emitted.detail).toBe('bash_1');
  });

  it('T3: a foreground Bash completion stays tool_end with no spurious detail', () => {
    // Foreground Bash: tool_response has output/exitCode/killed, no shellId,
    // no status. The PostToolUse directive set has no command fallback, so
    // detail stays undefined and the type stays tool_end.
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: { stdout: 'file1\nfile2', exitCode: 0, killed: false },
      tool_use_id: 'toolu_bash_fg',
    });

    runBridge(stdinContent, [outputFile, 'tool_end', ...POSTTOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('tool_end');
    expect(emitted.tool).toBe('Bash');
    expect(emitted.detail).toBeUndefined();
  });

  it('T4: a BashOutput poll completion (status:"completed") stays tool_end, never background_shell_end', () => {
    // BashOutput polling a still-running shell can report status:"completed".
    // It must NOT decrement the engine's count - real termination is owned
    // by the process-tree watcher and KillBash, not a status remap.
    const stdinContent = JSON.stringify({
      tool_name: 'BashOutput',
      tool_input: { bash_id: 'bash_1' },
      tool_response: { status: 'completed', stdout: 'done', exitCode: 0 },
      tool_use_id: 'toolu_bashoutput_1',
    });

    runBridge(stdinContent, [outputFile, 'tool_end', ...POSTTOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('tool_end');
    expect(emitted.tool).toBe('BashOutput');
  });

  it('T5: older-CLI snake_case shell_id still promotes (field fallback)', () => {
    // Version skew: an older Claude CLI emits tool_response.shell_id
    // (snake_case). The multi-candidate field list still extracts it.
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'sleep 60', run_in_background: true },
      tool_response: { shell_id: 'bash_1' },
      tool_use_id: 'toolu_bash_old',
    });

    runBridge(stdinContent, [outputFile, 'tool_end', ...POSTTOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_start');
    expect(emitted.detail).toBe('bash_1');
  });

  it('T6: a foreground Bash auto-backgrounded on TIMEOUT promotes via the shell id, with NO run_in_background (#187)', () => {
    // Empirical shape from session 3fc0dca7, events.jsonl line 20: a
    // foreground `npx playwright test --project=electron` exceeded Claude
    // Code's 10-min Bash ceiling and was auto-promoted to a background shell.
    // Its PostToolUse tool_input has NO run_in_background, but tool_response
    // carries the assigned shell id `bjosycg6w`. The old run_in_background
    // remap missed this and false-idled the task; keying on the extracted
    // shell-id detail promotes it to background_shell_start.
    const stdinContent = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npx playwright test --project=electron' },
      tool_response: { shellId: 'bjosycg6w' },
      tool_use_id: 'toolu_01JLj1ZAx1vs4d1qbAP3J7t1',
    });

    runBridge(stdinContent, [outputFile, 'tool_end', ...POSTTOOLUSE_DIRECTIVES]);

    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_start');
    expect(emitted.tool).toBe('Bash');
    expect(emitted.detail).toBe('bjosycg6w');
    expect(emitted.toolId).toBe('toolu_01JLj1ZAx1vs4d1qbAP3J7t1');
  });

  it('captures the tool_use_id correlation from tool_response on PostToolUse', () => {
    const stdinContent = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: 'C:\\Users\\dev\\repo\\file.ts' },
      tool_response: { tool_use_id: 'toolu_nested_read' },
    });
    runBridge(stdinContent, [outputFile, 'tool_end', ...POSTTOOLUSE_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('tool_end');
    expect(emitted.toolId).toBe('toolu_nested_read');
  });
});

describe('event-bridge setTypeWhen directive (tool-scoping + shell safety)', () => {
  it('whenTool gates the remap: a non-Bash tool with run_in_background does not remap', () => {
    // Defensive: a hypothetical tool carrying an incidental
    // run_in_background:true must NOT be mis-typed to background_shell_start
    // because the rule is scoped to whenTool:'Bash'.
    const directive = setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart });
    const stdinContent = JSON.stringify({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com', run_in_background: true },
    });
    runBridge(stdinContent, [outputFile, 'tool_start', extractTool('tool_name'), directive]);
    const emitted = readEvent();
    expect(emitted.type).toBe('tool_start');
    expect(emitted.tool).toBe('WebFetch');
  });

  it('applies a top-level (non-nested) field remap', () => {
    const directive = setTypeWhen({ field: 'tool_name', equals: 'KillBash', to: EventType.BackgroundShellEnd });
    runBridge(JSON.stringify({ tool_name: 'KillBash' }), [outputFile, 'tool_start', extractTool('tool_name'), directive]);
    expect(readEvent().type).toBe('background_shell_end');
  });

  it('is shell-safe: a value containing ":" and spaces round-trips through the base64 payload', () => {
    // The legacy colon-split remap forms could silently misparse a value with
    // ':', and a value with spaces would be split by the shell. The base64
    // payload makes the directive a single shell token, so any value survives.
    const directive = setTypeWhen({ field: 'mode', equals: 'a:b c:d', to: EventType.Interrupted });
    runBridge(JSON.stringify({ mode: 'a:b c:d' }), [outputFile, 'tool_end', directive]);
    expect(readEvent().type).toBe('interrupted');
  });

  it('is a no-op when the addressed field does not equal the value', () => {
    const directive = setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart });
    runBridge(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), [outputFile, 'tool_start', extractTool('tool_name'), directive]);
    expect(readEvent().type).toBe('tool_start');
  });
});

describe('event-bridge setTypeWhenDetailContains (substring classification on extracted detail)', () => {
  // The exact directive set the Claude adapter wires for the Notification
  // hook. The Claude-specific substring lives here / in the adapter, never in
  // the engine. The match runs on the already-extracted detail, so it is
  // robust to which payload field carried the text.
  const NOTIFICATION_DIRECTIVES = [
    extractDetail(['message', 'notification']),
    setTypeWhenDetailContains('waiting for your input', EventType.IdleHint),
  ];

  it('retypes a "waiting for your input" notification to idle_hint and keeps the text', () => {
    // Empirical shape from session 2d75b9e3-4ebb-420c-9d63-7ec48ba46c4b.
    const stdinContent = JSON.stringify({ message: 'Claude is waiting for your input' });
    runBridge(stdinContent, [outputFile, 'notification', ...NOTIFICATION_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('idle_hint');
    expect(emitted.detail).toBe('Claude is waiting for your input');
  });

  it('classifies regardless of which source field carried the text (message vs notification)', () => {
    // The whole point of matching on the extracted detail: we do NOT assume
    // the payload field name. Same text under `notification` must also classify.
    const stdinContent = JSON.stringify({ notification: 'Claude is waiting for your input' });
    runBridge(stdinContent, [outputFile, 'notification', ...NOTIFICATION_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('idle_hint');
    expect(emitted.detail).toBe('Claude is waiting for your input');
  });

  it('matches case-insensitively', () => {
    const stdinContent = JSON.stringify({ message: 'CLAUDE IS WAITING FOR YOUR INPUT' });
    runBridge(stdinContent, [outputFile, 'notification', ...NOTIFICATION_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('idle_hint');
  });

  // Every distinct non-waiting notification text observed across 221 real
  // Claude sessions on this machine. Empirically, each of these fires ~6s
  // AFTER a PermissionRequest already drove the engine to 'permission'
  // (tool permission, ExitPlanMode plan approval, or AskUserQuestion). They
  // must stay log-only `notification` - reclassifying any of them as
  // idle_hint would conflate the distinct 'permission' state with 'idle'.
  const NOT_IDLE_HINT_NOTIFICATIONS = [
    'Claude needs your permission',
    'Claude needs your permission to use PowerShell',
    'Claude needs your permission to use Bash',
    'Claude needs your permission to use Fetch',
    'Claude Code needs your approval for the plan',
    'Claude Code needs your attention',
  ];

  it.each(NOT_IDLE_HINT_NOTIFICATIONS)('leaves %j as a log-only notification (permission/attention family)', (message) => {
    runBridge(JSON.stringify({ message }), [outputFile, 'notification', ...NOTIFICATION_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('notification');
    expect(emitted.detail).toBe(message);
  });

  it('is a no-op when no detail was extracted', () => {
    const stdinContent = JSON.stringify({ some_other_field: 'irrelevant' });
    runBridge(stdinContent, [outputFile, 'notification', ...NOTIFICATION_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('notification');
    expect(emitted.detail).toBeUndefined();
  });
});

describe('event-bridge setTypeWhenDetailMatches (regex classification on extracted detail)', () => {
  // The exact pattern Claude's PostToolUse hook wires to detect the shell id
  // assigned by Claude Code when a foreground Bash is auto-backgrounded on
  // timeout (bug #187). The shell id is a word-char/dash slug of 1-64 chars
  // (e.g. 'bjosycg6w', 'bash_1', 'bash-e2e-run'). This describe block covers
  // the directive in isolation, independent of the full PostToolUse fixture
  // set in the 'tool completions' describe above (T6).
  const SHELL_ID_PATTERN = '^[\\w-]{1,64}$';
  const SHELL_ID_DIRECTIVES = [
    extractDetail(['shellId', 'shell_id'], { nested: 'tool_response' }),
    setTypeWhenDetailMatches(SHELL_ID_PATTERN, EventType.BackgroundShellStart),
  ];

  it('retypes tool_end to background_shell_start when the extracted detail matches the pattern', () => {
    // Empirical shell id from session 3fc0dca7 (bug #187 trigger event).
    const stdinContent = JSON.stringify({
      tool_response: { shellId: 'bjosycg6w' },
    });
    runBridge(stdinContent, [outputFile, 'tool_end', ...SHELL_ID_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_start');
    expect(emitted.detail).toBe('bjosycg6w');
  });

  it('does NOT retype when the extracted detail does not match the pattern', () => {
    // A tool_response with output text rather than a shell id. The pattern
    // requires 1-64 word-chars/dashes with no spaces or punctuation; output
    // text fails that and must stay tool_end.
    const stdinContent = JSON.stringify({
      tool_response: { shellId: 'file1.ts\nfile2.ts' },
    });
    runBridge(stdinContent, [outputFile, 'tool_end', ...SHELL_ID_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('tool_end');
    // The detail is truncated to 200 chars by the bridge but the key point
    // is that it did NOT match the shell-id pattern.
    expect(emitted.detail).toBeDefined();
  });

  it('does NOT retype when detail is absent (no tool_response.shellId in the payload)', () => {
    // A foreground Bash completion whose tool_response has stdout/exitCode but
    // no shellId. The typeof guard prevents the regex from even being evaluated.
    // This is structurally guaranteed but worth asserting explicitly for clarity.
    const stdinContent = JSON.stringify({
      tool_response: { stdout: 'ok', exitCode: 0 },
    });
    runBridge(stdinContent, [outputFile, 'tool_end', ...SHELL_ID_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('tool_end');
    expect(emitted.detail).toBeUndefined();
  });

  it('is shell-safe: the pattern round-trips through the base64 payload without being split by the shell', () => {
    // The pattern '^[\\w-]{1,64}$' contains '{', ',', '}' which are shell
    // metacharacters on some shells. Because the payload is base64-encoded,
    // the directive is a single shell token - these characters cannot split it.
    // Feed args directly (not via the real shell) to confirm the wire form
    // encodes correctly, then verify the match fires as expected.
    const stdinContent = JSON.stringify({
      tool_response: { shellId: 'valid-shell-id-123' },
    });
    runBridge(stdinContent, [outputFile, 'tool_end', ...SHELL_ID_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('background_shell_start');
    expect(emitted.detail).toBe('valid-shell-id-123');
  });
});

describe('event-bridge StopFailure -> turn_failed / turn_retrying (retryable-error classification)', () => {
  // The exact directive set the Claude adapter wires for StopFailure: extract
  // the error type, then reclassify to the generic turn_retrying event for a
  // transient/auto-retried error class, leaving turn_failed for everything
  // else (a terminal abort). detail is populated identically either way.
  const STOPFAILURE_DIRECTIVES = [
    extractDetail(['error', 'error_details']),
    setTypeWhenDetailContains('overloaded', EventType.TurnRetrying),
    setTypeWhenDetailContains('server_error', EventType.TurnRetrying),
    setTypeWhenDetailContains('rate_limit', EventType.TurnRetrying),
    setTypeWhenDetailContains('api_error', EventType.TurnRetrying),
  ];

  it.each([
    ['overloaded_error', 'overloaded_error'],
    ['server_error', 'server_error'],
    ['rate_limit_error', 'rate_limit_error'],
    ['api_error', 'api_error'],
  ])('retypes to turn_retrying for a transient error (%s)', (errorValue) => {
    const stdinContent = JSON.stringify({ error: errorValue });
    runBridge(stdinContent, [outputFile, 'turn_failed', ...STOPFAILURE_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('turn_retrying');
    expect(emitted.detail).toBe(errorValue);
  });

  it('stays turn_failed for a terminal error class (authentication_error)', () => {
    const stdinContent = JSON.stringify({ error: 'authentication_error' });
    runBridge(stdinContent, [outputFile, 'turn_failed', ...STOPFAILURE_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('turn_failed');
    expect(emitted.detail).toBe('authentication_error');
  });

  it('falls back to error_details and still classifies correctly', () => {
    const stdinContent = JSON.stringify({ error_details: 'server_error: upstream connect error' });
    runBridge(stdinContent, [outputFile, 'turn_failed', ...STOPFAILURE_DIRECTIVES]);
    const emitted = readEvent();
    expect(emitted.type).toBe('turn_retrying');
    expect(emitted.detail).toBe('server_error: upstream connect error');
  });
});

describe('event-bridge setTypeWhenDetailMatches: malformed regex is a no-op (event type unchanged)', () => {
  it('logs the error and emits the event with type UNCHANGED when the pattern is invalid', () => {
    // setTypeWhenDetailMatches wraps new RegExp(payload.pattern) in try/catch.
    // On throw it calls logBridgeError('invalid setTypeWhenDetailMatches pattern:
    // ...') and does NOT set event.type. The event is still appended because
    // setTypeWhenDetailMatches is a no-op on error (not a gate directive).
    // This is the inverse polarity of emitOnlyWhenDetailMatches (which is
    // fail-closed). Confirm the error-log and confirm the type is the initial
    // value passed on the command line.
    //
    // Hand-encode the directive with a broken pattern.
    const badMatcher = `setTypeWhenDetailMatches:${Buffer.from(JSON.stringify({ pattern: '([', to: 'background_shell_start' }), 'utf8').toString('base64')}`;
    const stdinContent = JSON.stringify({
      tool_response: { shellId: 'bash_1' },
    });
    // extractDetail so there is a detail string for the directive to operate on.
    const extractDirective = extractDetail(['shellId'], { nested: 'tool_response' });
    runBridge(stdinContent, [outputFile, 'tool_end', extractDirective, badMatcher]);
    // Event IS still appended.
    expect(outputEmitted()).toBe(true);
    const emitted = readEvent();
    // Type must remain 'tool_end' (unchanged, not the attempted remap).
    expect(emitted.type).toBe('tool_end');
    // detail was extracted successfully - only the type-remap was skipped.
    expect(emitted.detail).toBe('bash_1');
    const errorLog = path.join(tmpDir, 'events-bridge.error.log');
    expect(fs.existsSync(errorLog)).toBe(true);
    expect(fs.readFileSync(errorLog, 'utf-8')).toContain('invalid setTypeWhenDetailMatches pattern');
  });
});
