/**
 * Unit tests for the Antigravity CLI (agy) adapter: identity, command
 * building, session-id capture, transcript parsing, capability discovery,
 * and registry membership.
 *
 * Fixture data mirrors real agy 1.1.13 output captured by the E1 rig
 * (2026-08-16): the shutdown summary, the print-mode JSON result, hook
 * payloads, and brain-dir transcript steps - with machine paths scrubbed to
 * the generic C:/Users/dev form.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// discoverAntigravityCapabilities probes the CLI via exec (win32) or execFile
// (POSIX); mock only those two exports so the REAL util.promisify still wraps
// them correctly, and every other promisify() call site in the adapter graph
// (agentRegistry, imported below, pulls in every other adapter) keeps its
// real behavior. Mocking node:util itself (the identity-promisify trick used
// by the per-adapter capability-discovery test files) is NOT safe here: this
// file's import graph is far wider than those isolated files.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn(), execFile: vi.fn() };
});

// Antigravity's data root is derived from os.homedir(). Most tests in this
// file operate on transcript files at explicit temp paths and never touch
// it, so the mock stays a pass-through to the REAL homedir unless a test
// opts in via `homeOverride` (the parseAntigravityTranscript entry-point
// tests below). Kept inert by default: agentRegistry (imported below) pulls
// in every other adapter, several of which resolve an os.homedir()-derived
// path eagerly in a constructor (e.g. ClaudeDetector). ES module evaluation
// runs every imported module's top-level code before THIS file's own
// top-level statements run, so a `let` binding here would still be in its
// temporal dead zone when those constructors call the mocked homedir() -
// `var` is deliberate: its binding is initialized to `undefined` during
// module instantiation, before any module in the graph evaluates.
// eslint-disable-next-line no-var -- TDZ-safe default required; see comment above
var homeOverride: string | null = null;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => homeOverride ?? actual.homedir();
  return { ...actual, default: { ...actual, homedir }, homedir };
});

import { exec, execFile } from 'node:child_process';
import {
  AntigravityAdapter,
  antigravityModelDisplayName,
} from '../../src/main/agent/adapters/antigravity';
import {
  parseAntigravityTranscript,
  parseAntigravityTranscriptFile,
  createAntigravityInjectionVerifier,
  extractAntigravityUserTurn,
  extractUserRequestText,
} from '../../src/main/agent/adapters/antigravity/transcript-parser';
import {
  parseModelsOutput,
  discoverAntigravityCapabilities,
  resetAntigravityCapabilityCacheForTests,
} from '../../src/main/agent/adapters/antigravity/capability-discovery';
import { AntigravityStatusParser } from '../../src/main/agent/adapters/antigravity/status-parser';
import { extractPrintResponse } from '../../src/main/agent/adapters/antigravity/print-runner';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
  agentLoginCommand,
} from '../../src/renderer/utils/agent-display-name';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const adapter = new AntigravityAdapter();

function spawnOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/local/bin/agy',
    taskId: 'task-1',
    cwd: '/project',
    permissionMode: 'default',
    shell: 'bash',
    ...overrides,
  };
}

describe('AntigravityAdapter identity', () => {
  it('declares name, display name, session type, and no caller session id', () => {
    expect(adapter.name).toBe('antigravity');
    expect(adapter.displayName).toBe('Antigravity CLI');
    expect(adapter.sessionType).toBe('antigravity_agent');
    expect(adapter.supportsCallerSessionId).toBe(false);
  });

  it('declares the four permission modes mapped onto agy autonomy flags', () => {
    expect(adapter.permissions.map((entry) => entry.mode)).toEqual([
      'plan', 'default', 'acceptEdits', 'bypassPermissions',
    ]);
    expect(adapter.defaultPermission).toBe('acceptEdits');
  });

  it('uses hooks_and_pty activity with an events statusFile pipeline and no fromFilesystem', () => {
    expect(adapter.runtime.activity.kind).toBe('hooks_and_pty');
    expect(adapter.runtime.statusFile?.isFullRewrite).toBe(false);
    expect(adapter.runtime.sessionId?.fromFilesystem).toBeUndefined();
    expect(adapter.runtime.sessionId?.fromHook).toBeDefined();
    expect(adapter.runtime.sessionId?.fromOutput).toBeDefined();
  });

  it('exits via double Ctrl+C (agy has no /quit command)', () => {
    expect(adapter.getExitSequence()).toEqual(['\x03', '\x03']);
  });
});

describe('AntigravityAdapter.buildCommand', () => {
  it('spawns bare agy for a plain interactive session', () => {
    // quoteArg leaves shell-safe tokens bare under bash.
    expect(adapter.buildCommand(spawnOptions())).toBe('/usr/local/bin/agy');
  });

  it('delivers an interactive prompt via -i (agy has no positional prompt)', () => {
    const command = adapter.buildCommand(spawnOptions({ prompt: 'Fix the bug' }));
    expect(command).toContain(" -i 'Fix the bug'");
    expect(command).not.toContain(' -p ');
  });

  it('delivers a non-interactive prompt via -p', () => {
    const command = adapter.buildCommand(spawnOptions({ prompt: 'Fix it', nonInteractive: true }));
    expect(command).toContain(" -p 'Fix it'");
  });

  it('resumes a conversation with --conversation <id>', () => {
    const command = adapter.buildCommand(spawnOptions({
      resume: true,
      sessionId: '08939dbf-7975-4a3e-988e-54962828b379',
    }));
    expect(command).toContain('--conversation 08939dbf-7975-4a3e-988e-54962828b379');
  });

  it('omits --conversation for a fresh spawn (agy allocates the id lazily)', () => {
    expect(adapter.buildCommand(spawnOptions({ sessionId: 'abc' }))).not.toContain('--conversation');
  });

  it('passes model and effort overrides through', () => {
    const command = adapter.buildCommand(spawnOptions({ model: 'gemini-3.1-pro-low', effort: 'high' }));
    expect(command).toContain('--model gemini-3.1-pro-low');
    expect(command).toContain('--effort high');
  });

  it.each([
    ['plan', '--mode plan'],
    ['acceptEdits', '--mode accept-edits'],
    ['auto', '--mode accept-edits'],
    ['bypassPermissions', '--dangerously-skip-permissions'],
    ['dontAsk', '--dangerously-skip-permissions'],
  ] as const)('maps permission mode %s to %s', (mode, expected) => {
    expect(adapter.buildCommand(spawnOptions({ permissionMode: mode }))).toContain(expected);
  });

  it('emits no autonomy flag for the default mode (agy request-review)', () => {
    const command = adapter.buildCommand(spawnOptions({ permissionMode: 'default' }));
    expect(command).not.toContain('--mode');
    expect(command).not.toContain('--dangerously-skip-permissions');
  });
});

describe('AntigravityAdapter session-id capture', () => {
  it('fromOutput matches the graceful-shutdown resume line', () => {
    const scrollback = 'Resume with -c (or command below):\nagy --conversation=08939dbf-7975-4a3e-988e-54962828b379\n';
    expect(adapter.runtime.sessionId?.fromOutput?.(scrollback)).toBe('08939dbf-7975-4a3e-988e-54962828b379');
  });

  it('fromOutput matches print-mode JSON output', () => {
    const printJson = '{"conversation_id":"02d4959d-354d-4a2d-ae40-3d7f9875a3ed","status":"SUCCESS","response":"ok\\n"}';
    expect(adapter.runtime.sessionId?.fromOutput?.(printJson)).toBe('02d4959d-354d-4a2d-ae40-3d7f9875a3ed');
  });

  it('fromOutput ignores unrelated output', () => {
    expect(adapter.runtime.sessionId?.fromOutput?.('? for shortcuts')).toBeNull();
  });

  it('fromHook reads conversationId from any hook payload', () => {
    const payload = JSON.stringify({
      conversationId: '3db42741-6af4-4632-99cf-e5f230f7bc94',
      modelName: 'gemini-3.7-flash-high',
      workspacePaths: ['C:/Users/dev/project'],
    });
    expect(adapter.runtime.sessionId?.fromHook?.(payload)).toBe('3db42741-6af4-4632-99cf-e5f230f7bc94');
  });

  it('fromHook returns null for payloads without a conversationId and for non-JSON', () => {
    expect(adapter.runtime.sessionId?.fromHook?.('{}')).toBeNull();
    expect(adapter.runtime.sessionId?.fromHook?.('not json')).toBeNull();
  });
});

describe('AntigravityAdapter activity detection', () => {
  const detectIdle = adapter.runtime.activity.kind === 'hooks_and_pty'
    ? adapter.runtime.activity.detectIdle
    : undefined;

  it('detects the idle footer frame', () => {
    expect(detectIdle?.('\x1b[2m? for shortcuts\x1b[0m')).toBe(true);
  });

  it('does not fire on a generating frame (footer shows esc to cancel)', () => {
    expect(detectIdle?.('⣾  Generating...esc to cancel')).toBe(false);
  });

  it('reports first output on any nonempty chunk', () => {
    expect(adapter.detectFirstOutput('W')).toBe(true);
    expect(adapter.detectFirstOutput('')).toBe(false);
  });
});

describe('configuredModelFromCommand and model display names', () => {
  it('extracts a quoted --model value with a friendly display name', () => {
    const seeded = adapter.configuredModelFromCommand("\"/usr/local/bin/agy\" --model 'gemini-3.1-pro-high' -i 'x'");
    expect(seeded).toEqual({ id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' });
  });

  it('returns null when the command has no model override', () => {
    expect(adapter.configuredModelFromCommand('"/usr/local/bin/agy"')).toBeNull();
  });

  it('extracts a double-quoted --model value with a friendly display name', () => {
    const seeded = adapter.configuredModelFromCommand('"/usr/local/bin/agy" --model "gemini-3.1-pro-high" -i "x"');
    expect(seeded).toEqual({ id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' });
  });

  it('extracts a bare, unquoted --model token with a friendly display name', () => {
    const seeded = adapter.configuredModelFromCommand('/usr/local/bin/agy --model gemini-3.1-pro-high -i x');
    expect(seeded).toEqual({ id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' });
  });

  it.each([
    ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
    ['claude-opus-4-6-thinking', 'Claude Opus 4.6 Thinking'],
    ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
  ])('formats %s as %s', (slug, expected) => {
    expect(antigravityModelDisplayName(slug)).toBe(expected);
  });
});

describe('capability discovery parsing', () => {
  it('parses agy models TSV output, skipping the fetch banner', () => {
    const stdout = 'Fetching available models...\n'
      + 'gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n'
      + 'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
    const parsed = parseModelsOutput(stdout);
    expect(parsed.models).toEqual(['gemini-3.6-flash-high', 'claude-sonnet-4-6']);
    expect(parsed.displayNames['claude-sonnet-4-6']).toBe('Claude Sonnet 4.6 (Thinking)');
  });

  it('yields no models from an error or empty fetch', () => {
    expect(parseModelsOutput('Error: not signed in\n').models).toEqual([]);
  });

  it('parses the same models and display names when the CLI emits CRLF line endings', () => {
    const stdoutLf = 'Fetching available models...\n'
      + 'gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n'
      + 'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
    const stdoutCrlf = stdoutLf.replace(/\n/g, '\r\n');
    const parsedCrlf = parseModelsOutput(stdoutCrlf);
    // Pin the actual values (not just LF/CRLF equality) so a regression that
    // breaks both variants identically still fails this test.
    expect(parsedCrlf.models).toEqual(['gemini-3.6-flash-high', 'claude-sonnet-4-6']);
    expect(parsedCrlf.displayNames['claude-sonnet-4-6']).toBe('Claude Sonnet 4.6 (Thinking)');
    expect(parsedCrlf).toEqual(parseModelsOutput(stdoutLf));
  });
});

describe('print-runner response extraction', () => {
  it('extracts the response from print-mode PTY output with ANSI chrome', () => {
    const raw = '\x1b[2J\x1b[H{"conversation_id":"02d4959d-354d-4a2d-ae40-3d7f9875a3ed","status":"SUCCESS","response":"ok\\n","usage":{"input_tokens":14931,"output_tokens":115}}\r\n\x1b]0;powershell\x07';
    expect(extractPrintResponse(raw)).toBe('ok\n');
  });

  it('returns null when no result object is present', () => {
    expect(extractPrintResponse('spinner noise only')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transcript parsing (fixture mirrors real brain-dir transcript.jsonl steps)
// ---------------------------------------------------------------------------

const TRANSCRIPT_STEPS = [
  '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-08-16T16:09:01Z","content":"<USER_REQUEST>\\nCreate a file named probe.txt containing exactly: ok\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nThe current local time is: 2026-08-16T12:09:01-04:00.\\n</ADDITIONAL_METADATA>"}',
  '{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE","created_at":"2026-08-16T16:09:01Z"}',
  // Steps land slightly out of order in the real file - keep 3 before 2 to
  // pin the sort.
  '{"step_index":3,"source":"MODEL","type":"ERROR_MESSAGE","status":"DONE","created_at":"2026-08-16T16:09:09Z","content":"Error invalid tool call: tool call denied"}',
  '{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-16T16:09:01Z","thinking":"**Initiating File Creation**","tool_calls":[{"name":"write_to_file","args":{"CodeContent":"\\"ok\\"","Overwrite":"true","TargetFile":"\\"C:/Users/dev/ws/probe.txt\\""}}]}',
  '{"step_index":4,"source":"SYSTEM","type":"CHECKPOINT","status":"DONE","created_at":"2026-08-16T16:09:10Z","content":"{{ CHECKPOINT 0 }} summary"}',
  '{"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-16T16:09:31Z","content":"I attempted to create probe.txt but tool execution was denied."}',
].join('\n') + '\n';

function writeTranscriptFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-transcript-'));
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, TRANSCRIPT_STEPS);
  return filePath;
}

describe('parseAntigravityTranscriptFile', () => {
  it('maps steps to entries, sorted by step_index with decoded tool args', () => {
    const filePath = writeTranscriptFixture();
    try {
      const parsed = parseAntigravityTranscriptFile(filePath);
      expect(parsed.sourcePath).toBe(filePath);
      expect(parsed.entries.map((entry) => entry.kind)).toEqual([
        'user', 'assistant', 'tool_result', 'system', 'assistant',
      ]);

      const [user, assistant, toolResult, checkpoint, finalResponse] = parsed.entries;
      expect(user.kind === 'user' && user.text).toBe('Create a file named probe.txt containing exactly: ok');

      if (assistant.kind !== 'assistant') throw new Error('expected assistant entry');
      expect(assistant.blocks[0]).toEqual({ type: 'thinking', text: '**Initiating File Creation**' });
      const toolUse = assistant.blocks[1];
      if (toolUse.type !== 'tool_use') throw new Error('expected tool_use block');
      expect(toolUse.name).toBe('write_to_file');
      // JSON-encoded arg values are decoded for display.
      expect(toolUse.input).toEqual({ CodeContent: 'ok', Overwrite: true, TargetFile: 'C:/Users/dev/ws/probe.txt' });

      // The ERROR_MESSAGE step is attached to the preceding tool call.
      if (toolResult.kind !== 'tool_result') throw new Error('expected tool_result entry');
      expect(toolResult.toolUseId).toBe(toolUse.id);
      expect(toolResult.isError).toBe(true);

      expect(checkpoint.kind === 'system' && checkpoint.subtype).toBe('compaction');
      if (finalResponse.kind !== 'assistant') throw new Error('expected assistant entry');
      expect(finalResponse.blocks[0]).toEqual({
        type: 'text',
        text: 'I attempted to create probe.txt but tool execution was denied.',
      });
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('never throws on a corrupt or partially flushed transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-transcript-'));
    const filePath = path.join(dir, 'transcript.jsonl');
    try {
      fs.writeFileSync(filePath, '{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>\\nhi\\n</USER_REQUEST>"}\n{"step_index":1,"typ');
      const parsed = parseAntigravityTranscriptFile(filePath);
      expect(parsed.entries).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extractUserRequestText falls back to raw content without the wrapper', () => {
    expect(extractUserRequestText('plain prompt')).toBe('plain prompt');
  });

  it('does not attach an ERROR_MESSAGE to a stale tool call from an earlier step', () => {
    // A tool-bearing PLANNER_RESPONSE (step 0), then a TEXT-ONLY
    // PLANNER_RESPONSE (step 1, no tool_calls) that must reset the "most
    // recent tool call" anchor, then an ERROR_MESSAGE (step 2). Without the
    // reset, step 2 would misattach to step 0's long-resolved tool call.
    const steps = [
      '{"step_index":0,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-16T16:09:01Z","tool_calls":[{"name":"read_file","args":{"TargetFile":"\\"C:/Users/dev/ws/a.txt\\""}}]}',
      '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-16T16:09:05Z","content":"Reviewing the file now."}',
      '{"step_index":2,"source":"MODEL","type":"ERROR_MESSAGE","status":"DONE","created_at":"2026-08-16T16:09:09Z","content":"Error invalid tool call: tool call denied"}',
    ].join('\n') + '\n';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-error-attribution-'));
    const filePath = path.join(dir, 'transcript.jsonl');
    try {
      fs.writeFileSync(filePath, steps);
      const parsed = parseAntigravityTranscriptFile(filePath);
      // Only the two PLANNER_RESPONSE steps produce entries; the orphaned
      // ERROR_MESSAGE (no live tool call to attach to) produces none.
      expect(parsed.entries.map((entry) => entry.kind)).toEqual(['assistant', 'assistant']);
      expect(parsed.entries.some((entry) => entry.kind === 'tool_result')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeUserInputSteps(steps: Array<{ stepIndex: number; text: string; createdAt: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-verifier-'));
  const filePath = path.join(dir, 'transcript.jsonl');
  const lines = steps.map((step) => JSON.stringify({
    step_index: step.stepIndex,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: step.createdAt,
    content: `<USER_REQUEST>\n${step.text}\n</USER_REQUEST>`,
  })).join('\n') + '\n';
  fs.writeFileSync(filePath, lines);
  return filePath;
}

describe('createAntigravityInjectionVerifier', () => {
  it('confirms a submitted turn at or after sentAt and rejects older entries', async () => {
    const filePath = writeTranscriptFixture();
    try {
      const verifier = createAntigravityInjectionVerifier(filePath)!;
      const stepTimeMs = Date.parse('2026-08-16T16:09:01Z');
      await expect(verifier('Create a file named probe.txt containing exactly: ok', stepTimeMs)).resolves.toBe(true);
      // A sentAt far after the entry (beyond the 5s slack) must reject it.
      await expect(verifier('Create a file named probe.txt containing exactly: ok', stepTimeMs + 60_000)).resolves.toBe(false);
      await expect(verifier('some other text', stepTimeMs)).resolves.toBe(false);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('confirms a whole-second-truncated created_at written just before sentAt (the 5s slack)', async () => {
    // agy truncates created_at to whole seconds. A record written ~900ms
    // after sentAt can therefore carry a timestamp that reads as BEFORE
    // sentAt by more than the shared verifier's raw 50ms tolerance - this is
    // exactly what TRANSCRIPT_TIMESTAMP_SLACK_MS (5s) exists to absorb.
    const createdAt = '2026-08-16T16:09:01Z';
    const filePath = writeUserInputSteps([{ stepIndex: 0, text: 'run the smoke test', createdAt }]);
    try {
      const verifier = createAntigravityInjectionVerifier(filePath)!;
      const sentAt = Date.parse(createdAt) + 900; // same second, 900ms after truncation
      await expect(verifier('run the smoke test', sentAt)).resolves.toBe(true);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('confirms the most recent of two identical-text records (backward scan reaches it first)', async () => {
    // An older record with the SAME text sits well outside the confirm
    // window; if the scan walked forward it would hit that stale record
    // first, see it is too old, and bail before ever reaching the current
    // submission's matching record.
    const filePath = writeUserInputSteps([
      { stepIndex: 0, text: 'run the smoke test', createdAt: '2026-08-16T16:00:00Z' },
      { stepIndex: 1, text: 'run the smoke test', createdAt: '2026-08-16T16:09:10Z' },
    ]);
    try {
      const verifier = createAntigravityInjectionVerifier(filePath)!;
      const sentAt = Date.parse('2026-08-16T16:09:10Z');
      await expect(verifier('run the smoke test', sentAt)).resolves.toBe(true);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('extractAntigravityUserTurn returns null for a PLANNER_RESPONSE line', () => {
    const line = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-08-16T16:09:01Z',
      content: 'hello',
    });
    expect(extractAntigravityUserTurn(line)).toBeNull();
  });

  it('extractAntigravityUserTurn returns null for a non-JSON line', () => {
    expect(extractAntigravityUserTurn('not json at all')).toBeNull();
  });

  it('extractAntigravityUserTurn extracts the unwrapped USER_REQUEST text and epoch-ms timestamp', () => {
    const createdAt = '2026-08-16T16:09:01Z';
    const line = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: createdAt,
      content: '<USER_REQUEST>\nrun the smoke test\n</USER_REQUEST>\n'
        + '<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-16T12:09:01-04:00.\n</ADDITIONAL_METADATA>',
    });
    expect(extractAntigravityUserTurn(line)).toEqual({
      timestampMs: Date.parse(createdAt),
      text: 'run the smoke test',
    });
  });
});

describe('AntigravityAdapter.transcriptToolCounts', () => {
  it('counts tool_use blocks per tool from an explicit transcriptPath', async () => {
    const filePath = writeTranscriptFixture();
    try {
      const counts = await adapter.transcriptToolCounts({ transcriptPath: filePath });
      expect(counts?.toolCallCount).toBe(1);
      expect(counts?.toolBreakdown).toEqual([
        { toolName: 'write_to_file', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
      ]);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('returns null when nothing is resolvable', async () => {
    expect(await adapter.transcriptToolCounts({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseAntigravityTranscript (the async adapter entry point). Points the
// mocked os.homedir() at a sandbox directory so the real brain-dir layout
// (antigravityTranscriptPath) resolves under a temp dir.
// ---------------------------------------------------------------------------

describe('parseAntigravityTranscript (async entry point)', () => {
  let sandboxHome: string;

  beforeEach(() => {
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
    homeOverride = sandboxHome;
  });

  afterEach(() => {
    homeOverride = null;
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  });

  function writeBrainTranscript(conversationId: string): string {
    const logsDir = path.join(
      sandboxHome, '.gemini', 'antigravity-cli', 'brain', conversationId,
      '.system_generated', 'logs',
    );
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, 'transcript.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-08-16T16:09:01Z',
      content: '<USER_REQUEST>\nrun the smoke test\n</USER_REQUEST>',
    }) + '\n');
    return filePath;
  }

  it('resolves the real brain-dir layout under the conversation id and parses it', async () => {
    // Proves antigravityTranscriptPath resolves to the CORRECT location, not
    // merely "some" path that happens not to exist - the negative case below
    // would also pass against a wrong path.
    const conversationId = '3db42741-6af4-4632-99cf-e5f230f7bc94';
    const expectedPath = writeBrainTranscript(conversationId);

    const parsed = await parseAntigravityTranscript(conversationId, '/project');

    expect(parsed.sourcePath).toBe(expectedPath);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].kind).toBe('user');
  });

  it('resolves to empty entries and a null sourcePath without throwing when no transcript exists', async () => {
    // Same conversation-id SHAPE as a real one, but nothing was ever written
    // for it under the (mocked, empty) home directory.
    const parsed = await parseAntigravityTranscript('00000000-0000-4000-8000-000000000000', '/project');
    expect(parsed).toEqual({ entries: [], sourcePath: null });
  });
});

// ---------------------------------------------------------------------------
// discoverAntigravityCapabilities: mocks node:child_process's exec/execFile
// (whichever `runCli` selects for the current platform) with real
// util.promisify still wrapping them.
// ---------------------------------------------------------------------------

describe('discoverAntigravityCapabilities', () => {
  const execMock = exec as unknown as ReturnType<typeof vi.fn>;
  const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

  /**
   * exec/execFile are now bare vi.fn()s, so they lose Node's
   * util.promisify.custom symbol: the REAL util.promisify wraps them with
   * its generic callback-to-promise adapter, which appends its own callback
   * as the LAST argument and expects the mock to invoke it Node-style
   * (error-first, single result object). Returning a Promise directly from
   * the mock (instead of calling that callback) leaves the adapter's
   * callback never invoked, so the wrapped promise never settles - every
   * `discoverAntigravityCapabilities` call hangs until the test times out.
   */
  type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

  function callbackArgument(invocationArguments: unknown[]): ExecCallback {
    return invocationArguments[invocationArguments.length - 1] as ExecCallback;
  }

  /**
   * Route successive CLI probe calls (--help, then models) to successive
   * stdouts, regardless of whether the platform-selected implementation is
   * exec (win32) or execFile (POSIX).
   */
  function respondInOrder(...stdouts: string[]): void {
    let callIndex = 0;
    const respond = (...invocationArguments: unknown[]): void => {
      const stdout = stdouts[Math.min(callIndex, stdouts.length - 1)];
      callIndex += 1;
      callbackArgument(invocationArguments)(null, { stdout, stderr: '' });
    };
    execMock.mockImplementation(respond);
    execFileMock.mockImplementation(respond);
  }

  function respondWithFailure(error: Error): void {
    const reject = (...invocationArguments: unknown[]): void => {
      callbackArgument(invocationArguments)(error);
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);
  }

  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
    resetAntigravityCapabilityCacheForTests();
  });

  it('parses --model and --effort support from --help text, and the model list from `models`', async () => {
    respondInOrder(
      'Usage: agy [options]\n  --model <name>  Model for the current CLI session\n'
        + '  --effort <level>  Reasoning effort for the current session (low|medium|high)\n',
      'Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n',
    );

    const capabilities = await discoverAntigravityCapabilities('/usr/bin/agy');

    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high']);
    expect(capabilities.models).toEqual(['gemini-3.1-pro-high']);
    expect(capabilities.modelDisplayNames).toEqual({ 'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)' });
  });

  it('yields no override support and never throws when the help probe fails', async () => {
    respondWithFailure(new Error('ENOENT: agy not found'));

    await expect(discoverAntigravityCapabilities('/usr/bin/agy')).resolves.toEqual({
      supportsModelOverride: false,
      effortLevels: [],
      models: undefined,
      modelDisplayNames: undefined,
    });
  });

  it('caches per cliPath and only re-probes the CLI when forceRefresh is set', async () => {
    respondInOrder('Usage: agy\n  --model <name>  Model\n  --effort <level>  (low|medium|high)\n');

    await discoverAntigravityCapabilities('/usr/bin/agy');
    const callsAfterFirstProbe = execMock.mock.calls.length + execFileMock.mock.calls.length;
    expect(callsAfterFirstProbe).toBeGreaterThan(0);

    await discoverAntigravityCapabilities('/usr/bin/agy');
    expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBe(callsAfterFirstProbe);

    await discoverAntigravityCapabilities('/usr/bin/agy', true);
    expect(execMock.mock.calls.length + execFileMock.mock.calls.length).toBeGreaterThan(callsAfterFirstProbe);
  });
});

// ---------------------------------------------------------------------------
// AntigravityStatusParser: no status-line channel, event-bridge JSONL parsing
// ---------------------------------------------------------------------------

describe('AntigravityStatusParser', () => {
  it('parseStatus always returns null (agy has no status-line channel)', () => {
    expect(AntigravityStatusParser.parseStatus('')).toBeNull();
    expect(AntigravityStatusParser.parseStatus('{"input_tokens":100}')).toBeNull();
  });

  it('parseEvent returns null, not throws, on malformed JSON', () => {
    expect(AntigravityStatusParser.parseEvent('{"ts":1755360541000,"typ')).toBeNull();
  });

  it('parseEvent parses a well-formed event-bridge line', () => {
    const line = JSON.stringify({ ts: 1755360541000, type: 'tool_end', tool: 'write_to_file' });
    expect(AntigravityStatusParser.parseEvent(line)).toEqual({
      ts: 1755360541000,
      type: 'tool_end',
      tool: 'write_to_file',
    });
  });
});

// ---------------------------------------------------------------------------
// Registry + renderer display metadata
// ---------------------------------------------------------------------------

describe('registry membership', () => {
  it('is registered under name, session type, and list()', () => {
    expect(agentRegistry.has('antigravity')).toBe(true);
    expect(agentRegistry.getOrThrow('antigravity').displayName).toBe('Antigravity CLI');
    expect(agentRegistry.getBySessionType('antigravity_agent')?.name).toBe('antigravity');
    expect(agentRegistry.list()).toContain('antigravity');
  });
});

describe('renderer display metadata', () => {
  it('resolves display name, short name, and install URL', () => {
    expect(agentDisplayName('antigravity')).toBe('Antigravity CLI');
    expect(agentShortName('antigravity')).toBe('Antigravity');
    expect(agentInstallUrl('antigravity')).toBe('https://antigravity.google/docs/cli/getting-started');
  });

  it('has no login command (keyring sign-in happens inside the TUI)', () => {
    expect(agentLoginCommand('antigravity')).toBeUndefined();
  });
});
