/**
 * background-shell-hint-bridge.js, the PostToolUse hook that tells an agent its
 * background command keeps the task working and how to mark it as a service
 * (task #857), run as the CLI runs it: a separate Node process fed the hook
 * payload on stdin. The spec is the shipped `CLAUDE_BACKGROUND_SHELL_HINT_SPEC`
 * and the command comes from the same `buildBackgroundShellHintCommand` the
 * Claude adapter registers.
 *
 * The payload shapes are Claude Code's, from a headless probe on 2026-10-20:
 * a `run_in_background` launch's result is `{stdout, stderr, interrupted,
 * backgroundTaskId}` for both the Bash and the PowerShell tool.
 *
 * What it pins: the hook answers a background launch of either tool, puts the
 * shell id in the hint, and prints nothing for a flagged command, a foreground
 * call, another tool, or any malformed or oversized input. It also pins the
 * bridge's own copy of the shell id pattern against `looksLikeShellId`, and
 * replays a stored sample of real payloads
 * (`tests/fixtures/claude-posttooluse-background-launch.jsonl`).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_BACKGROUND_SHELL_HINT_SPEC } from '../../src/main/agent/adapters/claude/hook-manager';
import { buildBackgroundShellHintCommand } from '../../src/main/agent/shared/background-shell-hint-hook';
import { looksLikeShellId } from '../../src/main/activity-engine/background-shell/looks-like-shell-id';
import { MARK_BACKGROUND_SERVICE_TOOL, NO_ACTIVITY_HOLD_FLAG } from '../../src/shared/background-shell-hold';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/background-shell-hint-bridge.js');
const REAL_PAYLOADS = path.resolve(__dirname, '../fixtures/claude-posttooluse-background-launch.jsonl');

function encodedSpec(): string {
  return Buffer.from(JSON.stringify(CLAUDE_BACKGROUND_SHELL_HINT_SPEC), 'utf8').toString('base64');
}

/** Run the bridge, returning what it printed. */
function runBridge(stdin: string, spec: string | null = encodedSpec()): string {
  const args = spec === null ? [BRIDGE] : [BRIDGE, spec];
  return execFileSync(process.execPath, args, { input: stdin, timeout: 5000 }).toString('utf8');
}

/** A PostToolUse payload in the shape Claude Code sends. */
function postToolUse(toolName: string, command: string, toolResponse: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: 'probe-session',
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { command, description: 'probe', run_in_background: true },
    tool_response: toolResponse,
    tool_use_id: 'toolu_probe',
  });
}

function backgroundLaunch(toolName: string, command: string, shellId = 'bmxbwg0ai'): string {
  return postToolUse(toolName, command, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: shellId });
}

describe('background-shell-hint-bridge', () => {
  it.each(['Bash', 'PowerShell'])('answers a %s background launch with the hint, naming the shell and the tool', (toolName) => {
    const printed = runBridge(backgroundLaunch(toolName, 'npm run dev'));
    const reply = JSON.parse(printed) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(reply.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const context = reply.hookSpecificOutput.additionalContext;
    expect(context).toContain('background shell bmxbwg0ai exits');
    expect(context).toContain(`${MARK_BACKGROUND_SERVICE_TOOL} with shellIds ["bmxbwg0ai"]`);
    expect(context).not.toContain('{{shellId}}');
  });

  it('reads the id from the other field names Claude has used', () => {
    for (const field of ['shellId', 'shell_id']) {
      const printed = runBridge(postToolUse('Bash', 'npm run dev', { [field]: 'bolder01' }));
      expect(printed).toContain('bolder01');
    }
  });

  it('prints nothing for a command that already carries the no-activity-hold flag', () => {
    expect(runBridge(backgroundLaunch('PowerShell', `node scripts/worktree-preview.js --wait --port=5175 ${NO_ACTIVITY_HOLD_FLAG}`))).toBe('');
    expect(runBridge(backgroundLaunch('Bash', `npm run dev # ${NO_ACTIVITY_HOLD_FLAG}`))).toBe('');
  });

  it('prints nothing for a foreground call, another tool, or an id that is not id-shaped', () => {
    expect(runBridge(postToolUse('Bash', 'echo done', { stdout: 'done', stderr: '', interrupted: false }))).toBe('');
    expect(runBridge(backgroundLaunch('Read', 'npm run dev'))).toBe('');
    expect(runBridge(backgroundLaunch('Bash', 'npm run dev', 'not a shell id'))).toBe('');
  });

  it('prints nothing for malformed or oversized stdin, or a missing or malformed spec', () => {
    expect(runBridge('{not json')).toBe('');
    expect(runBridge('')).toBe('');
    const oversized = postToolUse('Bash', 'npm run dev', { backgroundTaskId: 'bbig0001', stdout: 'x'.repeat(1_100_000) });
    expect(runBridge(oversized)).toBe('');
    expect(runBridge(backgroundLaunch('Bash', 'npm run dev'), null)).toBe('');
    expect(runBridge(backgroundLaunch('Bash', 'npm run dev'), Buffer.from('{"reply":', 'utf8').toString('base64'))).toBe('');
  });

  it('builds a command whose single trailing token is the spec', () => {
    const command = buildBackgroundShellHintCommand('sh-or-powershell', '/fake/.kangentic/background-shell-hint-bridge.js', CLAUDE_BACKGROUND_SHELL_HINT_SPEC);
    const lastToken = command.split(' ').at(-1) ?? '';
    expect(lastToken).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(JSON.parse(Buffer.from(lastToken, 'base64').toString('utf8'))).toEqual(CLAUDE_BACKGROUND_SHELL_HINT_SPEC);
  });
});

// The bridge is a bare Node script that imports nothing, so it keeps its own copy
// of `looksLikeShellId`'s pattern (`SHELL_ID_PATTERN`). Nothing links the two but
// this test: a shell id the engine would track by name must get a hint, and an id
// it would track anonymously must not, or the hint names a shell the
// `kangentic_mark_background_service` tool then cannot find.
describe('background-shell-hint-bridge shell id shape', () => {
  const BOUNDARY_IDS: Array<{ label: string; shellId: string }> = [
    { label: '1 character', shellId: 'a' },
    { label: 'exactly 64 characters', shellId: 'a'.repeat(64) },
    { label: '65 characters', shellId: 'a'.repeat(65) },
    { label: 'a hyphen and an underscore', shellId: 'b-x_1' },
    { label: 'a lone hyphen', shellId: '-' },
    { label: 'a lone underscore', shellId: '_' },
    { label: 'a space', shellId: 'has space' },
    { label: 'a dot', shellId: 'has.dot' },
  ];

  it('covers both sides of the 64 character limit, so the table cannot go vacuous', () => {
    const accepted = BOUNDARY_IDS.filter(({ shellId }) => looksLikeShellId(shellId)).map(({ label }) => label);
    expect(accepted).toContain('exactly 64 characters');
    expect(accepted).not.toContain('65 characters');
    expect(accepted).not.toContain('a space');
    expect(accepted).not.toContain('a dot');
  });

  it.each(BOUNDARY_IDS)('prints a hint for an id of $label exactly when looksLikeShellId accepts it', ({ shellId }) => {
    const printed = runBridge(backgroundLaunch('Bash', 'npm run dev', shellId));
    if (looksLikeShellId(shellId)) {
      expect(printed).toContain(`background shell ${shellId} exits`);
    } else {
      expect(printed).toBe('');
    }
  });
});

// Real PostToolUse payloads from Claude Code, captured by a headless probe on
// 2026-10-20 and sanitized: paths and session ids are placeholders, every field
// name and every tool_input / tool_response value is as Claude sent it. The
// sample holds a Bash and a PowerShell run_in_background launch and two Bash
// foreground calls, so both tools' background result shape is replayed as it
// ships, not only as the hand-built payloads above model it.
describe('background-shell-hint-bridge replaying real Claude payloads', () => {
  // Written out by hand, not read back through `backgroundTaskId` the way the
  // bridge reads it, so a re-captured sample whose shape changed fails here.
  const EXPECTED_LINES: Array<{ tool: string; shellId: string | null }> = [
    { tool: 'Bash', shellId: 'b3kfzb1g3' },
    { tool: 'PowerShell', shellId: 'bmxbwg0ai' },
    { tool: 'Bash', shellId: null },
    { tool: 'Bash', shellId: null },
  ];
  // Split on either line ending: a Windows checkout may rewrite the fixture's.
  const payloadLines = fs.readFileSync(REAL_PAYLOADS, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);

  it('holds exactly the sample payloads this test expects', () => {
    expect(payloadLines).toHaveLength(EXPECTED_LINES.length);
    expect(payloadLines.map((line) => (JSON.parse(line) as { tool_name: string }).tool_name)).toEqual(
      EXPECTED_LINES.map(({ tool }) => tool),
    );
  });

  it.each(EXPECTED_LINES.map((expected, index) => ({ ...expected, index })))(
    'line $index ($tool): hint for $shellId',
    ({ index, shellId }) => {
      const printed = runBridge(payloadLines[index]);
      if (shellId === null) {
        expect(printed).toBe('');
        return;
      }
      expect(printed, 'a background launch prints the hint').not.toBe('');
      const reply = JSON.parse(printed) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(reply.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      const context = reply.hookSpecificOutput.additionalContext;
      expect(context).toContain(`background shell ${shellId} exits`);
      expect(context).toContain(`${MARK_BACKGROUND_SERVICE_TOOL} with shellIds ["${shellId}"]`);
      expect(context).not.toContain('{{shellId}}');
    },
  );
});
