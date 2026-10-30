/**
 * The event bridge's wait-kind directives (#452): `setWaitKind`,
 * `setWaitKindWhen` and `appendPermissionWaitForTool`, and the hook entries
 * that use them to tell a question from an approval.
 *
 * Runs the real `transformHookEvent` that both the bridge process and main's
 * WSL hook inbox use, so the assertions are about the lines events.jsonl gets.
 *
 * Where the payloads come from. Copilot 1.0.100 and Antigravity 1.3.4 replay
 * live captures (`tests/fixtures/copilot-hooks/`, `antigravity-hooks/`).
 * Claude's `tool_name` on PermissionRequest is pinned by its real captures in
 * `tests/fixtures/plan-exit/`, and `AskUserQuestion` by the real session in
 * `tests/fixtures/replay/session-006-ask-user-question-resume.jsonl`. Droid
 * 0.218.0's PreToolUse and PostToolUse replay live captures
 * (`tests/fixtures/droid-hooks/`). The Codex `request_user_input`, Qwen
 * `ask_user_question` and Droid Notification payloads are built from each
 * CLI's docs or source: no capture of a question wait exists for them yet, so
 * a renamed field or value would pass here.
 * Gemini 0.66.0's captured `ask_user` and `exec` Notifications are replayed in
 * `event-bridge-remap.test.ts` (`tests/fixtures/gemini-hooks/`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { transformHookEvent, hookReplyFrom } from '../../src/main/agent/event-bridge';
import { buildHooks as buildClaudeHooks } from '../../src/main/agent/adapters/claude';
import { buildHooks as buildCopilotHooks } from '../../src/main/agent/adapters/copilot/hook-manager';
import { buildHooks as buildAntigravityHooks, KANGENTIC_HOOK_NAME } from '../../src/main/agent/adapters/antigravity/hook-manager';
import { buildHooks as buildQwenHooks } from '../../src/main/agent/adapters/qwen-code/hook-manager';
import { codexHookDefinitions } from '../../src/main/agent/adapters/codex/hook-manager';
import { buildDroidHookSettings } from '../../src/main/agent/adapters/droid/hook-manager';
import {
  appendPermissionWaitForTool, extractTool, replyJson, setDetail, setWaitKind, setWaitKindWhen,
} from '../../src/main/agent/shared/directive-builders';

interface BridgeRun {
  lines: Array<Record<string, unknown>>;
  errors: string[];
}

function run(eventType: string, directives: string[], payload: unknown): BridgeRun {
  const errors: string[] = [];
  const lines = transformHookEvent({
    eventType,
    directives,
    input: JSON.stringify(payload),
    now: 1_700_000_000_000,
    logError: (message: string) => errors.push(message),
  }).map((line: string) => JSON.parse(line) as Record<string, unknown>);
  return { lines, errors };
}

function readFixture(name: string, folder = 'copilot-hooks'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', folder, name), 'utf8')) as Record<string, unknown>;
}

/** `node "<bridge>" "<events>" <eventType> <directive>...` with space-free mock paths. */
function directivesOf(command: string): string[] {
  return command.split(' ').slice(4);
}

/**
 * A directive hand-encoded the way the builders do (`<kind>:<base64(JSON)>`),
 * for the payloads the builders refuse to emit: it is the bridge's own guard
 * against a stale or hand-written hook command that these tests reach.
 */
function forgedDirective(kind: string, payload: unknown): string {
  return `${kind}:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

describe('setWaitKind', () => {
  it('tags the event with a known kind', () => {
    const { lines } = run('idle', [setDetail('permission'), setWaitKind('approval')], {});
    expect(lines).toEqual([{ ts: 1_700_000_000_000, type: 'idle', detail: 'permission', waitKind: 'approval' }]);
  });

  it('refuses a kind the engine does not know, and logs it', () => {
    const forged = forgedDirective('setWaitKind', { kind: 'plan' });
    const { lines, errors } = run('idle', [forged], {});
    expect(lines[0]).not.toHaveProperty('waitKind');
    expect(errors).toHaveLength(1);
  });
});

describe('setWaitKindWhen', () => {
  const rule = setWaitKindWhen({ path: ['details', 'type'], equals: 'ask_user', to: 'question' });

  it('overrides the default when the nested value matches', () => {
    const { lines } = run('idle', [setWaitKind('approval'), rule], { details: { type: 'ask_user' } });
    expect(lines[0]).toMatchObject({ waitKind: 'question' });
  });

  it('keeps the default for any other value, or none', () => {
    expect(run('idle', [setWaitKind('approval'), rule], { details: { type: 'exec' } }).lines[0]).toMatchObject({ waitKind: 'approval' });
    expect(run('idle', [setWaitKind('approval'), rule], {}).lines[0]).toMatchObject({ waitKind: 'approval' });
    // An object at the path never stringifies into a match.
    expect(run('idle', [setWaitKind('approval'), rule], { details: { type: { nested: 'ask_user' } } }).lines[0]).toMatchObject({ waitKind: 'approval' });
  });

  it('refuses a rule whose builder would never emit it', () => {
    expect(() => setWaitKindWhen({ path: [], equals: 'x', to: 'question' })).toThrow();
  });
});

describe('appendPermissionWaitForTool', () => {
  const directive = appendPermissionWaitForTool({ toolPath: ['tool_name'], tool: 'request_user_input', waitKind: 'question' });

  it('writes the question wait AFTER the tool start, so the start cannot clear it', () => {
    const { lines } = run('tool_start', [extractTool('tool_name'), directive], { tool_name: 'request_user_input' });
    expect(lines.map((line) => line.type)).toEqual(['tool_start', 'idle']);
    expect(lines[1]).toEqual({
      ts: 1_700_000_000_000,
      type: 'idle',
      detail: 'permission',
      tool: 'request_user_input',
      waitKind: 'question',
    });
  });

  it('writes nothing extra for any other tool', () => {
    const { lines } = run('tool_start', [extractTool('tool_name'), directive], { tool_name: 'shell' });
    expect(lines.map((line) => line.type)).toEqual(['tool_start']);
  });

  it('reads a nested tool name', () => {
    const nested = appendPermissionWaitForTool({ toolPath: ['toolCall', 'name'], tool: 'ask_question', waitKind: 'question' });
    const { lines } = run('tool_start', [nested], { toolCall: { name: 'ask_question' } });
    expect(lines.map((line) => line.type)).toEqual(['tool_start', 'idle']);
  });

  it('writes no wait for a payload it cannot trust, and logs it', () => {
    // The builder types both fields; a stale or hand-written command can still
    // carry a kind the engine does not know, or a tool name that is not a string.
    const forgedPayloads: Array<{ name: string; payload: unknown; toolName: unknown }> = [
      { name: 'an unknown wait kind', payload: { toolPath: ['tool_name'], tool: 'request_user_input', waitKind: 'plan' }, toolName: 'request_user_input' },
      { name: 'a tool that is not a string', payload: { toolPath: ['tool_name'], tool: 42, waitKind: 'question' }, toolName: 42 },
    ];
    for (const { name, payload, toolName } of forgedPayloads) {
      const { lines, errors } = run('tool_start', [extractTool('tool_name'), forgedDirective('appendPermissionWaitForTool', payload)], { tool_name: toolName });
      expect(lines.map((line) => line.type), name).toEqual(['tool_start']);
      expect(errors, name).toHaveLength(1);
      expect(errors[0], name).toContain('invalid appendPermissionWaitForTool payload');
    }
  });
});

describe('replyJson', () => {
  const bridgePath = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'event-bridge.js');

  function runBridgeProcess(directives: string[]): { stdout: string; events: string } {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reply-'));
    try {
      const eventsPath = path.join(folder, 'events.jsonl');
      const result = spawnSync(process.execPath, [bridgePath, eventsPath, 'tool_start', ...directives], {
        input: JSON.stringify({ toolCall: { name: 'ask_question' } }),
        encoding: 'utf8',
      });
      return { stdout: result.stdout, events: fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : '' };
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  it('is the only stdout the bridge process writes, and the events still land', () => {
    const withReply = runBridgeProcess([replyJson({ decision: 'allow' })]);
    expect(withReply.stdout).toBe('{"decision":"allow"}');
    expect(withReply.events).toContain('"type":"tool_start"');
    // Every other hook stays silent: Gemini rejects any hook stdout.
    expect(runBridgeProcess([]).stdout).toBe('');
  });

  it('adds nothing to the event and is read only by hookReplyFrom', () => {
    const { lines, errors } = run('tool_start', [replyJson({ decision: 'allow' })], {});
    expect(lines).toEqual([{ ts: 1_700_000_000_000, type: 'tool_start' }]);
    expect(errors).toEqual([]);
    expect(hookReplyFrom([replyJson({ decision: 'allow' })])).toBe('{"decision":"allow"}');
    expect(hookReplyFrom([setDetail('x')])).toBeNull();
  });

  it('answers nothing when the reply is missing or is not an object', () => {
    // Printing `"x"` or `undefined` for a CLI that reads a decision off stdout is worse than silence.
    const forgedPayloads: Array<{ name: string; payload: unknown }> = [
      { name: 'a payload with no reply', payload: {} },
      { name: 'a reply that is a string', payload: { reply: 'x' } },
      { name: 'a null reply', payload: { reply: null } },
      { name: 'a null payload', payload: null },
    ];
    for (const { name, payload } of forgedPayloads) {
      expect(hookReplyFrom([forgedDirective('replyJson', payload)]), name).toBeNull();
    }
  });
});

describe('the hook entries that tag a wait', () => {
  describe('Antigravity ask_question PreToolUse', () => {
    // `node <bridge> <events> tool_start <directives...>`, with space-free tokens.
    const entry = buildAntigravityHooks('../bridge.cjs', '../events.jsonl', {})[KANGENTIC_HOOK_NAME];
    const directives = directivesOf(entry.PreToolUse![0].hooks[0].command);
    // Captured live from agy 1.3.4's own hook stdin.
    const askQuestion = readFixture('agy-1.3.4-pre-tool-use-ask-question.json', 'antigravity-hooks');
    const runCommand = readFixture('agy-1.3.4-pre-tool-use-run-command.json', 'antigravity-hooks');

    it('writes the question\'s start and then its wait, and answers allow', () => {
      const { lines } = run('tool_start', directives, askQuestion);
      expect(lines.map((line) => line.type)).toEqual(['tool_start', 'idle']);
      expect(lines[0]).toMatchObject({ tool: 'ask_question' });
      expect(lines[1]).toMatchObject({ detail: 'permission', waitKind: 'question', tool: 'ask_question' });
      expect(hookReplyFrom(directives)).toBe('{"decision":"allow"}');
    });

    it('raises no wait for any other tool that reaches it', () => {
      expect(run('tool_start', directives, runCommand).lines.map((line) => line.type)).toEqual(['tool_start']);
    });
  });

  describe('Claude PermissionRequest', () => {
    const entries = buildClaudeHooks('/mock/event-bridge.js', '/mock/events.jsonl', {}).PermissionRequest;
    const catchAll = entries.find((entry) => entry.matcher === '');
    if (!catchAll) throw new Error('Claude wires no catch-all PermissionRequest entry');
    const directives = directivesOf(catchAll.hooks[0].command);

    it('tags AskUserQuestion as a question', () => {
      expect(run('idle', directives, { tool_name: 'AskUserQuestion' }).lines[0])
        .toMatchObject({ type: 'idle', detail: 'permission', tool: 'AskUserQuestion', waitKind: 'question' });
    });

    it('tags a plan (ExitPlanMode) and every tool as an approval', () => {
      for (const toolName of ['ExitPlanMode', 'Bash', 'mcp__github__create_issue']) {
        expect(run('idle', directives, { tool_name: toolName }).lines[0])
          .toMatchObject({ detail: 'permission', tool: toolName, waitKind: 'approval' });
      }
    });
  });

  describe('Codex', () => {
    // `node .kangentic/codex-event-bridge.cjs env:KANGENTIC_EVENTS_PATH <type> <directives...>`,
    // found by the `-c hooks.<Event>=` key its override registers.
    const directivesFor = (hookEvent: string): string[] => {
      const definition = codexHookDefinitions().find((candidate) => candidate.override.startsWith(`hooks.${hookEvent}=`));
      if (!definition) throw new Error(`Codex wires no ${hookEvent} hook`);
      return directivesOf(definition.command);
    };

    it('turns request_user_input\'s start into a question wait, written after the start in one hook', () => {
      const { lines } = run('tool_start', directivesFor('PreToolUse'), {
        tool_name: 'request_user_input', tool_use_id: 'call_1', tool_input: { questions: [] },
      });
      expect(lines.map((line) => line.type)).toEqual(['tool_start', 'idle']);
      expect(lines[0]).toMatchObject({ tool: 'request_user_input', toolId: 'call_1' });
      expect(lines[1]).toMatchObject({ detail: 'permission', waitKind: 'question', tool: 'request_user_input' });
    });

    it('starts every other tool with no wait', () => {
      const { lines } = run('tool_start', directivesFor('PreToolUse'), {
        tool_name: 'shell', tool_use_id: 'call_2', tool_input: { command: 'ls' },
      });
      expect(lines.map((line) => line.type)).toEqual(['tool_start']);
    });

    it('tags every PermissionRequest as an approval', () => {
      expect(run('idle', directivesFor('PermissionRequest'), { tool_name: 'shell' }).lines[0])
        .toMatchObject({ detail: 'permission', waitKind: 'approval' });
    });
  });

  describe('Droid Notification', () => {
    // `node "<bridge>" "<events>" idle <directives...>` from the per-session settings file.
    const command = buildDroidHookSettings('/mock/event-bridge.js', '/mock/events.jsonl').hooks.Notification[0].hooks[0].command;
    const directives = directivesOf(command);
    // Factory's hooks reference: the Notification carries `message` and `notification_type`.
    const notification = (notificationType: string) => ({
      session_id: '00000000-0000-4000-8000-000000000000', cwd: 'C:\\Users\\dev\\repo',
      hook_event_name: 'Notification', message: 'Droid needs your attention', notification_type: notificationType,
    });

    it('turns an elicitation dialog into a question wait', () => {
      expect(run('idle', directives, notification('elicitation_dialog')).lines)
        .toEqual([{ ts: 1_700_000_000_000, type: 'idle', detail: 'permission', waitKind: 'question' }]);
    });

    it('turns a permission prompt into an approval wait', () => {
      expect(run('idle', directives, notification('permission_prompt')).lines)
        .toEqual([{ ts: 1_700_000_000_000, type: 'idle', detail: 'permission', waitKind: 'approval' }]);
    });

    it('writes nothing for any other notification, an idle prompt included', () => {
      for (const notificationType of ['idle_prompt', 'auth_success']) {
        expect(run('idle', directives, notification(notificationType)).lines).toEqual([]);
      }
    });
  });

  describe('Droid PreToolUse and PostToolUse', () => {
    // The tool start a wait follows and the tool end that answers it, from the per-session settings file.
    const hooks = buildDroidHookSettings('/mock/event-bridge.js', '/mock/events.jsonl').hooks;
    const preToolUseDirectives = directivesOf(hooks.PreToolUse[0].hooks[0].command);
    const postToolUseDirectives = directivesOf(hooks.PostToolUse[0].hooks[0].command);
    // Captured live from Droid 0.218.0's own hook stdin (`droid exec`, with `--settings`).
    const preToolUse = readFixture('droid-0.218.0-pre-tool-use-execute.json', 'droid-hooks');
    const postForeground = readFixture('droid-0.218.0-post-tool-use-foreground.json', 'droid-hooks');
    const postFireAndForget = readFixture('droid-0.218.0-post-tool-use-fire-and-forget.json', 'droid-hooks');

    it('starts the tool with its name and the command it runs', () => {
      const { lines, errors } = run('tool_start', preToolUseDirectives, preToolUse);
      expect(lines).toEqual([{ ts: 1_700_000_000_000, type: 'tool_start', tool: 'Execute', detail: 'node server.js' }]);
      expect(errors).toEqual([]);
    });

    it('ends a foreground tool by name alone', () => {
      const { lines, errors } = run('tool_end', postToolUseDirectives, postForeground);
      expect(lines).toEqual([{ ts: 1_700_000_000_000, type: 'tool_end', tool: 'Execute' }]);
      expect(errors).toEqual([]);
    });

    it('ends a fire-and-forget tool the same way, with no background launch', () => {
      const { lines, errors } = run('tool_end', postToolUseDirectives, postFireAndForget);
      expect(lines).toEqual([{ ts: 1_700_000_000_000, type: 'tool_end', tool: 'Execute' }]);
      expect(errors).toEqual([]);
    });
  });

  describe('Copilot notification', () => {
    // The bridge path is the resolved script, so read the directives after the event type.
    const command = buildCopilotHooks('/mock/events.jsonl').notification[0].command;
    const tokens = command.split(' ');
    const directives = tokens.slice(tokens.indexOf('idle') + 1);
    // Captured live from Copilot CLI 1.0.100's own hook stdin.
    const elicitation = readFixture('copilot-1.0.100-notification-elicitation.json');
    const permissionPrompt = readFixture('copilot-1.0.100-notification-permission.json');

    it('turns the ask_user elicitation dialog into a question wait', () => {
      expect(run('idle', directives, elicitation).lines)
        .toEqual([{ ts: 1_700_000_000_000, type: 'idle', detail: 'permission', waitKind: 'question' }]);
    });

    it('turns a permission prompt into an approval wait', () => {
      expect(run('idle', directives, permissionPrompt).lines)
        .toEqual([{ ts: 1_700_000_000_000, type: 'idle', detail: 'permission', waitKind: 'approval' }]);
    });

    it('writes nothing for any other notification type', () => {
      for (const notificationType of ['shell_completed', 'shell_detached_completed', 'agent_completed', 'agent_idle']) {
        expect(run('idle', directives, { ...permissionPrompt, notification_type: notificationType }).lines).toEqual([]);
      }
    });
  });

  describe('Qwen Code PermissionRequest', () => {
    const entries = buildQwenHooks('/mock/event-bridge.js', '/mock/events.jsonl', {}).PermissionRequest;
    const directives = directivesOf(entries[entries.length - 1].hooks[0].command);

    it('tags ask_user_question as a question and anything else as an approval', () => {
      expect(run('idle', directives, { tool_name: 'ask_user_question' }).lines[0]).toMatchObject({ waitKind: 'question' });
      expect(run('idle', directives, { tool_name: 'run_shell_command' }).lines[0]).toMatchObject({ waitKind: 'approval' });
      expect(run('idle', directives, { tool_name: 'exit_plan_mode' }).lines[0]).toMatchObject({ waitKind: 'approval' });
    });
  });
});
