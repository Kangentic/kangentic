/**
 * Background command reporting over captured payloads (task #859).
 *
 * For each adapter whose hooks report background commands from a
 * `BackgroundCommandSpec`, this runs the REAL event bridge with the directives
 * that adapter's real `buildHooks` writes on its post-tool entry, and the REAL
 * hint bridge with the v2 spec built from the same spec, over payloads captured
 * from the real CLI (tests/fixtures/<agent>-hooks/, headless runs against a
 * local stand-in for the model API, paths and ids sanitized). A launch must
 * write a named `background_shell_start` before the hook's own `tool_end`, a
 * flagged launch must carry `noActivityHold`, a stop must write its end, and a
 * foreground call must write nothing extra. The hint must answer exactly the
 * launches that hold.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventType } from '../../src/shared/types';
import { SHELL_ID_PATTERN_SOURCE, type BackgroundCommandSpec } from '../../src/shared/background-command-spec';
import { NO_ACTIVITY_HOLD_FLAG } from '../../src/shared/background-shell-hold';
import { backgroundShellHintSpecOf } from '../../src/main/agent/shared/background-command-hooks';
import {
  appendBackgroundLaunch,
  emitOnlyWhenDetailMatches,
  extractDetail,
  extractTool,
  type BackgroundLaunchDirective,
} from '../../src/main/agent/shared/directive-builders';
import { buildHooks as buildQwenHooks, QWEN_BACKGROUND_COMMAND_SPEC } from '../../src/main/agent/adapters/qwen-code/hook-manager';
import { buildHooks as buildGeminiHooks, GEMINI_BACKGROUND_COMMAND_SPEC } from '../../src/main/agent/adapters/gemini/hook-manager';
import { buildHooks as buildCopilotHooks, COPILOT_BACKGROUND_COMMAND_SPEC } from '../../src/main/agent/adapters/copilot/hook-manager';
import { buildGrokHooks, GROK_BACKGROUND_COMMAND_SPEC } from '../../src/main/agent/adapters/grok/hook-manager';

const EVENT_BRIDGE = path.resolve(__dirname, '../../src/main/agent/event-bridge.js');
const HINT_BRIDGE = path.resolve(__dirname, '../../src/main/agent/background-shell-hint-bridge.js');
const FIXTURES = path.resolve(__dirname, '../fixtures');

let tmpDir: string;
let outputFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-command-reporting-'));
  outputFile = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The directives after the event type in a bridge command `node <bridge> <events> tool_end <directive> ...`. */
function directivesOf(command: string, eventType: EventType = EventType.ToolEnd): string[] {
  const tokens = command.split(' ');
  const typeIndex = tokens.indexOf(eventType);
  if (typeIndex < 0) throw new Error(`no ${eventType} in ${command}`);
  return tokens.slice(typeIndex + 1);
}

interface AdapterUnderTest {
  name: string;
  spec: BackgroundCommandSpec;
  /** The directives of the adapter's real post-tool event bridge entry. */
  postToolDirectives: () => string[];
  fixtureDirectory: string;
}

const ADAPTERS: Record<string, AdapterUnderTest> = {
  qwen: {
    name: 'Qwen Code',
    spec: QWEN_BACKGROUND_COMMAND_SPEC,
    postToolDirectives: () => directivesOf(buildQwenHooks('/mock/.kangentic/event-bridge.js', '/mock/events.jsonl', {}).PostToolUse[0].hooks[0].command),
    fixtureDirectory: 'qwen-hooks',
  },
  gemini: {
    name: 'Gemini CLI',
    spec: GEMINI_BACKGROUND_COMMAND_SPEC,
    postToolDirectives: () => directivesOf(buildGeminiHooks('/mock/.kangentic/event-bridge.js', 'env:KANGENTIC_EVENTS_PATH', {}).AfterTool[0].hooks[0].command),
    fixtureDirectory: 'gemini-hooks',
  },
  copilot: {
    name: 'Copilot',
    spec: COPILOT_BACKGROUND_COMMAND_SPEC,
    postToolDirectives: () => directivesOf(buildCopilotHooks('/mock/sessions/one/events.jsonl').postToolUse[0].command),
    fixtureDirectory: 'copilot-hooks',
  },
  grok: {
    name: 'Grok',
    spec: GROK_BACKGROUND_COMMAND_SPEC,
    postToolDirectives: () => directivesOf(buildGrokHooks('/mock/.kangentic/event-bridge.js').PostToolUse[0].hooks[0].command),
    fixtureDirectory: 'grok-hooks',
  },
};

function fixture(adapter: AdapterUnderTest, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, adapter.fixtureDirectory, file), 'utf-8'));
}

/**
 * Every line one run of the REAL bridge appended. The file is cleared first so a
 * second run in the same test (a control beside a negative) reads only its own
 * lines, and a run that writes nothing (every event suppressed) reads as empty:
 * the bridge creates the file only when it has a line to append.
 */
function runBridge(eventType: EventType, directives: string[], payload: Record<string, unknown>): Array<Record<string, unknown>> {
  fs.rmSync(outputFile, { force: true });
  execFileSync(process.execPath, [EVENT_BRIDGE, outputFile, eventType, ...directives], {
    input: JSON.stringify(payload),
    timeout: 5000,
  });
  if (!fs.existsSync(outputFile)) return [];
  return fs.readFileSync(outputFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

/** Every line the bridge appended for one post-tool hook run. */
function runPostTool(adapter: AdapterUnderTest, payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return runBridge(EventType.ToolEnd, adapter.postToolDirectives(), payload);
}

/** The event types a run wrote, in order. */
function typesOf(lines: Array<Record<string, unknown>>): unknown[] {
  return lines.map((line) => line.type);
}

/** A copy of `value` whose object at `key` also carries `changes`, so a payload changes in one place only. */
function withNested(value: Record<string, unknown>, key: string, changes: Record<string, unknown>): Record<string, unknown> {
  const existing = value[key];
  const base = typeof existing === 'object' && existing !== null ? existing : {};
  return { ...value, [key]: { ...base, ...changes } };
}

/** What the hint bridge prints for the payload (empty for no hint). */
function runHint(adapter: AdapterUnderTest, payload: Record<string, unknown>): string {
  const hintSpec = backgroundShellHintSpecOf(adapter.spec);
  if (!hintSpec) return '';
  const encoded = Buffer.from(JSON.stringify(hintSpec), 'utf8').toString('base64');
  return execFileSync(process.execPath, [HINT_BRIDGE, encoded], { input: JSON.stringify(payload), timeout: 5000 }).toString('utf8');
}

interface Case {
  file: string;
  /** The background event the bridge must write before the tool_end, or null for none. */
  background: { type: EventType; id: string; noActivityHold?: true } | null;
}

const CASES: Record<string, Case[]> = {
  qwen: [
    { file: 'qwen-0.25.3-post-tool-use-background-launch.json', background: { type: EventType.BackgroundShellStart, id: 'bg_bc67cecc' } },
    { file: 'qwen-0.25.3-post-tool-use-foreground-shell.json', background: null },
    { file: 'qwen-0.25.3-post-tool-use-task-stop.json', background: { type: EventType.BackgroundShellEnd, id: 'bg_bc67cecc' } },
    { file: 'qwen-0.25.3-post-tool-use-flagged-launch.json', background: { type: EventType.BackgroundShellStart, id: 'bg_5d90bd48', noActivityHold: true } },
  ],
  gemini: [
    { file: 'gemini-0.64.0-after-tool-background-launch.json', background: { type: EventType.BackgroundShellStart, id: '84272' } },
    { file: 'gemini-0.64.0-after-tool-foreground-shell.json', background: null },
    { file: 'gemini-0.64.0-after-tool-flagged-launch.json', background: { type: EventType.BackgroundShellStart, id: '43964', noActivityHold: true } },
  ],
  copilot: [
    { file: 'copilot-1.0.100-post-tool-use-async-launch.json', background: { type: EventType.BackgroundShellStart, id: 'probe-server' } },
    { file: 'copilot-1.0.100-post-tool-use-sync-completed.json', background: null },
    { file: 'copilot-1.0.100-post-tool-use-sync-still-running.json', background: { type: EventType.BackgroundShellStart, id: '0' } },
    { file: 'copilot-1.0.100-post-tool-use-stop.json', background: { type: EventType.BackgroundShellEnd, id: 'probe-server' } },
    { file: 'copilot-1.0.100-post-tool-use-flagged-launch.json', background: { type: EventType.BackgroundShellStart, id: '1', noActivityHold: true } },
    // An independent process the agent means to outlive the session never holds.
    { file: 'copilot-1.0.100-post-tool-use-detached-launch.json', background: null },
  ],
  grok: [
    { file: 'grok-1.0.0-post-tool-use-background-launch.json', background: { type: EventType.BackgroundShellStart, id: '00000000-0000-4000-8000-6d078eb2d5c1' } },
    { file: 'grok-1.0.0-post-tool-use-foreground.json', background: null },
    { file: 'grok-1.0.0-post-tool-use-kill.json', background: { type: EventType.BackgroundShellEnd, id: '00000000-0000-4000-8000-6d078eb2d5c1' } },
    { file: 'grok-1.0.0-post-tool-use-flagged-launch.json', background: { type: EventType.BackgroundShellStart, id: '00000000-0000-4000-8000-426fc1a9c4f0', noActivityHold: true } },
  ],
};

for (const [key, adapter] of Object.entries(ADAPTERS)) {
  describe(`${adapter.name} background commands, over captured payloads`, () => {
    for (const testCase of CASES[key]) {
      it(`${testCase.file}: ${testCase.background ? `${testCase.background.type} ${testCase.background.id}` : 'nothing beyond tool_end'}`, () => {
        const lines = runPostTool(adapter, fixture(adapter, testCase.file));
        const toolEnd = lines[lines.length - 1];
        expect(toolEnd.type).toBe(EventType.ToolEnd);
        if (!testCase.background) {
          expect(lines).toHaveLength(1);
          return;
        }
        expect(lines).toHaveLength(2);
        const background = lines[0];
        expect(background).toMatchObject({ type: testCase.background.type, detail: testCase.background.id });
        // The tool's own tool_end closes its pending tool; a start that closed it too would decrement twice.
        expect(background).not.toHaveProperty('toolId');
        if (testCase.background.noActivityHold) {
          expect(background.noActivityHold).toBe(true);
        } else {
          expect(background).not.toHaveProperty('noActivityHold');
        }
      });

      it(`${testCase.file}: the hint answers exactly a launch that holds`, () => {
        const holds = testCase.background?.type === EventType.BackgroundShellStart && !testCase.background.noActivityHold;
        const printed = runHint(adapter, fixture(adapter, testCase.file));
        if (!holds || adapter.spec.hintReply === undefined) {
          expect(printed).toBe('');
          return;
        }
        expect(printed.length).toBeGreaterThan(0);
        const reply: unknown = JSON.parse(printed);
        expect(JSON.stringify(reply)).toContain(`shellIds [\\"${testCase.background?.id}\\"]`);
        expect(JSON.stringify(reply)).not.toContain('{{shellId}}');
      });
    }
  });
}

describe('the hint has the reply shape each CLI reads', () => {
  it('Qwen reads hookSpecificOutput.additionalContext on PostToolUse', () => {
    expect(QWEN_BACKGROUND_COMMAND_SPEC.hintReply).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse' } });
  });
  it('Gemini reads hookSpecificOutput.additionalContext on AfterTool', () => {
    expect(GEMINI_BACKGROUND_COMMAND_SPEC.hintReply).toMatchObject({ hookSpecificOutput: { hookEventName: 'AfterTool' } });
  });
  it('Copilot reads a top-level additionalContext, and ignores hookSpecificOutput', () => {
    expect(COPILOT_BACKGROUND_COMMAND_SPEC.hintReply).toHaveProperty('additionalContext');
    expect(COPILOT_BACKGROUND_COMMAND_SPEC.hintReply).not.toHaveProperty('hookSpecificOutput');
  });
  it('Grok has no hint: its PostToolUse is passive', () => {
    expect(GROK_BACKGROUND_COMMAND_SPEC.hintReply).toBeUndefined();
    expect(backgroundShellHintSpecOf(GROK_BACKGROUND_COMMAND_SPEC)).toBeNull();
  });
});

describe('a stop ends a shell only when the CLI reports the stop happened', () => {
  // The stop directive rides the stop tool's post-tool entry. In every payload below the
  // id source still resolves (toolArgs.shellId, toolInput.task_id) and the tool still
  // matches, so the result field is the only thing left to keep the shell held.
  const COPILOT_STOP = 'copilot-1.0.100-post-tool-use-stop.json';
  const GROK_KILL = 'grok-1.0.0-post-tool-use-kill.json';

  it.each(['failure', 'denied'])('Copilot: a stop whose resultType is %s ends nothing', (resultType) => {
    const adapter = ADAPTERS.copilot;
    const success = fixture(adapter, COPILOT_STOP);
    // Same payload, success result: the control that proves only the result field blocks the end.
    expect(typesOf(runPostTool(adapter, success))).toEqual([EventType.BackgroundShellEnd, EventType.ToolEnd]);

    const failed = withNested(success, 'toolResult', { resultType });
    expect(failed).toMatchObject({ toolName: 'stop_powershell', toolArgs: { shellId: 'probe-server' } });
    const lines = runPostTool(adapter, failed);
    expect(typesOf(lines)).toEqual([EventType.ToolEnd]);
    expect(lines[0]).toMatchObject({ tool: 'stop_powershell' });
  });

  it.each(['Error', 'TaskNotFound'])('Grok: a kill whose result type is %s, not KillTask, ends nothing', (resultType) => {
    const adapter = ADAPTERS.grok;
    const killed = fixture(adapter, GROK_KILL);
    expect(typesOf(runPostTool(adapter, killed))).toEqual([EventType.BackgroundShellEnd, EventType.ToolEnd]);

    const refused = { ...killed, toolResult: { type: resultType, message: 'The task was not killed' } };
    expect(refused).toMatchObject({
      toolName: 'kill_command_or_subagent',
      toolInput: { task_id: '00000000-0000-4000-8000-6d078eb2d5c1' },
    });
    const lines = runPostTool(adapter, refused);
    expect(typesOf(lines)).toEqual([EventType.ToolEnd]);
    expect(lines[0]).toMatchObject({ tool: 'kill_command_or_subagent' });
  });
});

describe('a launch needs the CLI to say it launched, not text that quotes the phrase', () => {
  const GEMINI_FOREGROUND = 'gemini-0.64.0-after-tool-foreground-shell.json';
  const QWEN_FOREGROUND = 'qwen-0.25.3-post-tool-use-foreground-shell.json';

  /** The shell tool's real foreground payload with the flag and the result text set. */
  function geminiPayload(isBackground: boolean, llmContent: string): Record<string, unknown> {
    const base = fixture(ADAPTERS.gemini, GEMINI_FOREGROUND);
    return withNested(withNested(base, 'tool_input', { is_background: isBackground }), 'tool_response', { llmContent });
  }

  // Gemini's launch id is anchored at the start of the result text, where a foreground
  // command's result has "Output:". Text further in never reads as a launch.
  const QUOTING_RESULTS: Record<string, string> = {
    'a foreground result whose output echoes the phrase':
      '<untrusted_context>\nOutput: Command moved to background (PID: 123)\nProcess Group PGID: 53712\n</untrusted_context>',
    'text that opens with something else': 'Note: Command moved to background (PID: 123). Output hidden.',
  };

  for (const [description, llmContent] of Object.entries(QUOTING_RESULTS)) {
    it.each([true, false])(`Gemini: ${description} (is_background %s) is not a launch`, (isBackground) => {
      const adapter = ADAPTERS.gemini;
      // Control: the same flag with the phrase leading the text IS a launch, for the hold and the hint.
      const genuine = geminiPayload(isBackground, '<untrusted_context>\nCommand moved to background (PID: 123). Output hidden.\n</untrusted_context>');
      const genuineLines = runPostTool(adapter, genuine);
      expect(typesOf(genuineLines)).toEqual([EventType.BackgroundShellStart, EventType.ToolEnd]);
      expect(genuineLines[0]).toMatchObject({ detail: '123' });
      expect(runHint(adapter, genuine)).not.toBe('');

      const quoted = geminiPayload(isBackground, llmContent);
      expect(typesOf(runPostTool(adapter, quoted))).toEqual([EventType.ToolEnd]);
      expect(runHint(adapter, quoted)).toBe('');
    });
  }

  // Qwen's launch needs tool_input.is_background to be exactly true. A foreground
  // command can still print an "id: bg_..." line (here, in its own output).
  const QWEN_FOREGROUND_ID_LINE = 'Command: echo ready\nDirectory: (root)\nOutput: ready\nid: bg_abcd1234\nError: (none)\nExit Code: 0\nSignal: (none)\nProcess Group PGID: (none)';

  function qwenPayload(isBackground: unknown): Record<string, unknown> {
    const base = fixture(ADAPTERS.qwen, QWEN_FOREGROUND);
    return withNested(withNested(base, 'tool_input', { is_background: isBackground }), 'tool_response', { llmContent: QWEN_FOREGROUND_ID_LINE });
  }

  it.each([false, 'true'])('Qwen: is_background %j with an "id: bg_..." line in the result is not a launch', (isBackground) => {
    const adapter = ADAPTERS.qwen;
    // Control: the identical payload with is_background true reports bg_abcd1234, for the hold and the hint.
    const launched = qwenPayload(true);
    const launchedLines = runPostTool(adapter, launched);
    expect(typesOf(launchedLines)).toEqual([EventType.BackgroundShellStart, EventType.ToolEnd]);
    expect(launchedLines[0]).toMatchObject({ detail: 'bg_abcd1234' });
    expect(runHint(adapter, launched)).not.toBe('');

    const foreground = qwenPayload(isBackground);
    expect(typesOf(runPostTool(adapter, foreground))).toEqual([EventType.ToolEnd]);
    expect(runHint(adapter, foreground)).toBe('');
  });
});

describe('a Grok Stop that lists running background tasks', () => {
  it('is an idle event and ends none of them', () => {
    const adapter = ADAPTERS.grok;
    const payload = fixture(adapter, 'grok-1.0.0-stop-with-background-tasks.json');
    // The captured Stop names a task that is still running (flagged, so it never held).
    expect(payload).toMatchObject({ hookEventName: 'stop', backgroundTasks: [{ status: 'running' }] });

    const stopCommand = buildGrokHooks('/mock/.kangentic/event-bridge.js').Stop[0].hooks[0].command;
    const lines = runBridge(EventType.Idle, directivesOf(stopCommand, EventType.Idle), payload);

    // Exactly the idle the Stop maps to (reason carried as detail): no background start or end.
    expect(typesOf(lines)).toEqual([EventType.Idle]);
    expect(lines[0]).toMatchObject({ detail: 'end_turn' });
    expect(lines[0]).not.toHaveProperty('noActivityHold');
  });
});

describe('appendBackgroundLaunch in the real bridge', () => {
  /** A synthetic launch: the tool "run_shell" returns its shell id at result.id. */
  const LAUNCH_MATCH: BackgroundLaunchDirective = {
    toolField: 'tool_name',
    tools: ['run_shell'],
    when: [],
    unless: [],
    idSources: [{ path: ['result', 'id'] }],
    commandPath: ['input', 'command'],
    idPattern: SHELL_ID_PATTERN_SOURCE,
    optOutFlag: NO_ACTIVITY_HOLD_FLAG,
  };

  function launchPayload(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { tool_name: 'run_shell', input: { command: 'node server.js' }, result: { id }, status: 'running', ...extra };
  }

  /** The directive with one field of its payload left out, as a stale or hand-built directive would. */
  function launchDirectiveWithout(field: keyof BackgroundLaunchDirective): string {
    const incomplete = Object.fromEntries(Object.entries(LAUNCH_MATCH).filter(([key]) => key !== field));
    return appendBackgroundLaunch(incomplete as unknown as BackgroundLaunchDirective);
  }

  const OWN_EVENT = [extractTool('tool_name')];

  describe('the id shape', () => {
    it('reports an id at the 64 character bound', () => {
      const id = 'a'.repeat(64);
      const lines = runBridge(EventType.ToolEnd, [...OWN_EVENT, appendBackgroundLaunch(LAUNCH_MATCH)], launchPayload(id));
      expect(typesOf(lines)).toEqual([EventType.BackgroundShellStart, EventType.ToolEnd]);
      expect(lines[0]).toMatchObject({ detail: id, tool: 'run_shell' });
    });

    it.each([
      ['65 characters', 'a'.repeat(65)],
      ['a dot', 'srv.1'],
      ['a space', 'srv 1'],
    ])('writes only the hook\'s own event for an id with %s', (_description, id) => {
      const lines = runBridge(EventType.ToolEnd, [...OWN_EVENT, appendBackgroundLaunch(LAUNCH_MATCH)], launchPayload(id));
      expect(typesOf(lines)).toEqual([EventType.ToolEnd]);
      expect(lines[0]).toMatchObject({ tool: 'run_shell' });
    });
  });

  describe('the hook\'s own event is suppressed by emitOnlyWhenDetailMatches', () => {
    // The gate reads the extracted detail, so extractDetail comes first. The gate and the
    // launch are independent of each other's list order.
    const GATE = [extractDetail(['status']), emitOnlyWhenDetailMatches('^done$')];

    it.each([
      ['before', true],
      ['after', false],
    ])('still writes the start when the gate is listed %s the launch', (_description, gateFirst) => {
      const launch = appendBackgroundLaunch(LAUNCH_MATCH);
      const directives = gateFirst ? [...GATE, launch] : [GATE[0], launch, GATE[1]];

      // Control: a detail that matches the gate keeps the tool_end beside the start.
      const matching = runBridge(EventType.ToolEnd, directives, launchPayload('srv-1', { status: 'done' }));
      expect(typesOf(matching)).toEqual([EventType.BackgroundShellStart, EventType.ToolEnd]);

      const suppressed = runBridge(EventType.ToolEnd, directives, launchPayload('srv-1', { status: 'running' }));
      expect(typesOf(suppressed)).toEqual([EventType.BackgroundShellStart]);
      expect(suppressed[0]).toMatchObject({ detail: 'srv-1', tool: 'run_shell' });
    });
  });

  describe('a directive payload that cannot name a call', () => {
    it.each([
      ['no toolField', launchDirectiveWithout('toolField'), launchPayload('srv-1')],
      // Without its guard the lookup would read the key "undefined", which this payload carries.
      ['no toolField and a payload keyed "undefined"', launchDirectiveWithout('toolField'), launchPayload('srv-1', { undefined: 'run_shell' })],
      ['no tools', launchDirectiveWithout('tools'), launchPayload('srv-1')],
      [
        'tools that is a string holding the tool name',
        appendBackgroundLaunch({ ...LAUNCH_MATCH, tools: 'run_shell' as unknown as string[] }),
        launchPayload('srv-1'),
      ],
    ])('matches nothing and still writes the hook\'s own event: %s', (_description, directive, payload) => {
      // runBridge throws if the bridge exits nonzero, so reaching the assertions means it did not throw.
      const lines = runBridge(EventType.ToolEnd, [...OWN_EVENT, directive], payload);
      expect(typesOf(lines)).toEqual([EventType.ToolEnd]);
      expect(lines[0]).toMatchObject({ tool: 'run_shell' });
    });
  });
});
