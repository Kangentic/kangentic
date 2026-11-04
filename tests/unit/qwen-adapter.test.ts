/**
 * Unit tests for QwenAdapter session ID extraction - both hook-based
 * (extractSessionId) and PTY output-based (captureSessionIdFromOutput).
 *
 * Mirrors gemini-adapter.test.ts. Adds an extra case for the dual
 * `(?:qwen|gemini) --resume` regex so we can resume sessions even when
 * a fork build still emits the upstream literal in its shutdown summary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QwenAdapter, QwenCommandBuilder } from '../../src/main/agent/adapters/qwen-code';
import { QWEN_SUBAGENT_LAUNCH_TOOLS } from '../../src/main/agent/adapters/qwen-code/hook-manager';
import { resetQwenToolCallCursorsForTests } from '../../src/main/agent/adapters/qwen-code/transcript-metrics';
import { qwenProjectSlug } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

describe('Qwen Adapter - session ID capture', () => {
  let adapter: QwenAdapter;

  beforeEach(() => {
    adapter = new QwenAdapter();
  });

  describe('extractSessionId', () => {
    it('extracts session_id from hookContext JSON', () => {
      const hookContext = JSON.stringify({ session_id: '4231e6aa-5409-4749-9272-270e9aab079b' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('extracts sessionId (camelCase) as fallback', () => {
      const hookContext = JSON.stringify({ sessionId: 'abc-123-def' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBe('abc-123-def');
    });

    it('prefers session_id over sessionId', () => {
      const hookContext = JSON.stringify({ session_id: 'preferred', sessionId: 'fallback' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBe('preferred');
    });

    it('extracts from full Qwen hook base schema', () => {
      const hookContext = JSON.stringify({
        session_id: '4231e6aa-5409-4749-9272-270e9aab079b',
        transcript_path: '/tmp/transcript.json',
        cwd: '/home/dev/project',
        hook_event_name: 'SessionStart',
        timestamp: '2026-04-05T12:00:00Z',
      });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('returns null when hookContext has no session_id', () => {
      const hookContext = JSON.stringify({ thread_id: 'not-a-session' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBeNull();
    });

    it('returns null for empty session_id string', () => {
      const hookContext = JSON.stringify({ session_id: '' });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBeNull();
    });

    it('returns null for non-string session_id', () => {
      const hookContext = JSON.stringify({ session_id: 12345 });
      expect(adapter.runtime.sessionId!.fromHook!(hookContext)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(adapter.runtime.sessionId!.fromHook!('not json')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(adapter.runtime.sessionId!.fromHook!('')).toBeNull();
    });
  });

  describe('captureSessionIdFromOutput', () => {
    it('captures UUID from qwen --resume line', () => {
      const output = "To resume this session: qwen --resume '4231e6aa-5409-4749-9272-270e9aab079b'";
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('captures UUID from qwen --resume without quotes', () => {
      const output = 'To resume this session: qwen --resume 4231e6aa-5409-4749-9272-270e9aab079b';
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('captures UUID from gemini --resume line (some forks emit upstream literal)', () => {
      const output = "To resume this session: gemini --resume '4231e6aa-5409-4749-9272-270e9aab079b'";
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('captures UUID from Session ID header line', () => {
      const output = 'Session ID:           4231e6aa-5409-4749-9272-270e9aab079b';
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('captures from full shutdown summary', () => {
      const output = [
        'Agent powering down. Goodbye!',
        '',
        'Interaction Summary',
        'Session ID:           4231e6aa-5409-4749-9272-270e9aab079b',
        'Tool Calls:           0 ( 0 x 0 )',
        'Success Rate:         0.0%',
        '',
        'Performance',
        'Wall Time:            10.2s',
        '',
        "To resume this session: qwen --resume '4231e6aa-5409-4749-9272-270e9aab079b'",
      ].join('\n');
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('returns null for unrelated output', () => {
      expect(adapter.runtime.sessionId!.fromOutput!('Hello world')).toBeNull();
      expect(adapter.runtime.sessionId!.fromOutput!('')).toBeNull();
    });

    it('returns null for partial UUID', () => {
      expect(adapter.runtime.sessionId!.fromOutput!('Session ID: 4231e6aa')).toBeNull();
    });
  });
});

// Note: filesystem capture / locate scenarios are covered exhaustively
// in tests/unit/qwen-session-history-parser.test.ts (against the real
// JSONL format and ~/.qwen/projects/<sanitized-cwd>/chats/ path scheme).
// We don't duplicate them here.

describe('Qwen Adapter - concurrent-session hook holds', () => {
  let sandbox: string;
  let adapter: QwenAdapter;
  let settingsPath: string;

  const seedSettingsWithKangenticHook = (): void => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{
            name: 'kangentic-SessionStart',
            type: 'command',
            command: 'node "C:/fake/.kangentic/event-bridge.js" events.jsonl SessionStart',
          }],
        }],
      },
    }, null, 2));
  };

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-qwen-refcount-'));
    settingsPath = path.join(sandbox, '.qwen', 'settings.json');
    adapter = new QwenAdapter();
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Holds are keyed by the session's own id (`ptySessionId`), never by its
  // task: a task's sessions overlap while an old PTY exits.
  const buildOptions = (cwd: string, ptySessionId: string, taskId = `task-of-${ptySessionId}`) => ({
    agentPath: 'qwen',
    taskId,
    ptySessionId,
    cwd,
    permissionMode: 'default' as const,
    eventsOutputPath: path.join(cwd, 'events.jsonl'),
  });

  const sessionStartHookCount = (): number | undefined => {
    if (!fs.existsSync(settingsPath)) return undefined;
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).hooks?.SessionStart?.length;
  };

  it('strips hooks only after the last live session releases', () => {
    adapter.buildCommand(buildOptions(sandbox, 'session-a'));
    adapter.buildCommand(buildOptions(sandbox, 'session-b'));

    seedSettingsWithKangenticHook();

    adapter.removeHooks(sandbox, 'session-a');
    expect(sessionStartHookCount()).toBe(1);

    adapter.removeHooks(sandbox, 'session-b');
    expect(sessionStartHookCount()).toBeUndefined();
  });

  it('double-release for the same session is idempotent (suspend + onExit)', () => {
    adapter.buildCommand(buildOptions(sandbox, 'session-a'));
    adapter.buildCommand(buildOptions(sandbox, 'session-b'));
    seedSettingsWithKangenticHook();

    adapter.removeHooks(sandbox, 'session-a');
    adapter.removeHooks(sandbox, 'session-a');

    expect(sessionStartHookCount()).toBe(1);
  });

  it('an older session of the same task releasing late keeps the newer session\'s hooks', () => {
    adapter.buildCommand(buildOptions(sandbox, 'old-session', 'task-a'));
    adapter.buildCommand(buildOptions(sandbox, 'new-session', 'task-a'));
    seedSettingsWithKangenticHook();

    adapter.removeHooks(sandbox, 'old-session');
    expect(sessionStartHookCount()).toBe(1);

    adapter.removeHooks(sandbox, 'new-session');
    expect(sessionStartHookCount()).toBeUndefined();
  });

  it('decouples holds across different cwds', () => {
    const sandboxTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-qwen-refcount-b-'));
    try {
      adapter.buildCommand(buildOptions(sandbox, 'session-a'));
      adapter.buildCommand(buildOptions(sandboxTwo, 'session-b'));

      seedSettingsWithKangenticHook();
      const settingsPathTwo = path.join(sandboxTwo, '.qwen', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPathTwo), { recursive: true });
      fs.writeFileSync(settingsPathTwo, fs.readFileSync(settingsPath, 'utf-8'));

      adapter.removeHooks(sandbox, 'session-a');
      const stillThere = JSON.parse(fs.readFileSync(settingsPathTwo, 'utf-8'));
      expect(stillThere.hooks?.SessionStart?.length).toBe(1);
    } finally {
      fs.rmSync(sandboxTwo, { recursive: true, force: true });
    }
  });

  // The Command Terminal's namer reads the first prompt's text, which only
  // reaches the hooks file when the spawn's `capturePromptText` survives the
  // adapter's option spread into the builder.
  it('carries capturePromptText from the spawn into the UserPromptSubmit hook', () => {
    const promptCommand = (): string => {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      const entries = settings.hooks.UserPromptSubmit;
      return entries[entries.length - 1].hooks[0].command;
    };
    adapter.buildCommand(buildOptions(sandbox, 'session-plain'));
    const plain = promptCommand();
    adapter.removeHooks(sandbox, 'session-plain');

    adapter.buildCommand({ ...buildOptions(sandbox, 'session-terminal'), capturePromptText: true });
    const capturing = promptCommand();
    adapter.removeHooks(sandbox, 'session-terminal');

    // One more directive: the prompt detail, ahead of the plan mode.
    expect(capturing.split(' ')).toHaveLength(plain.split(' ').length + 1);
  });

  it('tolerates removeHooks with no prior retain (crash/restart path)', () => {
    seedSettingsWithKangenticHook();
    expect(() => adapter.removeHooks(sandbox, 'orphan-session')).not.toThrow();
  });
});

// -- agent-display-name - qwen entry ----------------------------------------

describe('agent-display-name - qwen entry', () => {
  it('agentDisplayName returns "Qwen Code" for "qwen"', () => {
    expect(agentDisplayName('qwen')).toBe('Qwen Code');
  });

  it('agentShortName returns "Qwen" for "qwen"', () => {
    expect(agentShortName('qwen')).toBe('Qwen');
  });

  it('agentInstallUrl returns the Qwen Code repo URL for "qwen"', () => {
    expect(agentInstallUrl('qwen')).toBe('https://github.com/QwenLM/qwen-code');
  });
});

describe('Qwen Adapter - MCP-only spawn (no eventsOutputPath)', () => {
  let sandbox: string;
  let adapter: QwenAdapter;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-qwen-mcp-only-'));
    adapter = new QwenAdapter();
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * buildOptions with MCP config but NO eventsOutputPath. The server goes
   * through `--mcp-config` naming the session's own `mcp.json`, so the folder's
   * `.qwen/settings.json` is not written and no hold is taken.
   */
  const buildMcpOnlyOptions = (cwd: string, ptySessionId: string) => ({
    agentPath: 'qwen',
    taskId: `task-of-${ptySessionId}`,
    ptySessionId,
    cwd,
    permissionMode: 'default' as const,
    statusOutputPath: path.join(cwd, '.kangentic', 'sessions', ptySessionId, 'status.json'),
    mcpServerEnabled: true as const,
    mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
    mcpServerToken: 'test-token-mcp',
    // eventsOutputPath intentionally absent
  });

  const seedKangenticMcpEntry = (extraServers: Record<string, unknown> = {}): string => {
    const qwenDir = path.join(sandbox, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    const settingsFile = path.join(qwenDir, 'settings.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        mcpServers: {
          kangentic: {
            httpUrl: 'http://127.0.0.1:51234/mcp/proj-1',
            headers: { 'X-Kangentic-Token': 'test-token-mcp' },
          },
          ...extraServers,
        },
      }, null, 2),
    );
    return settingsFile;
  };

  it('gives each session its own mcp.json and leaves .qwen/settings.json alone', () => {
    // Qwen 0.20+ gates every `.qwen/settings.json` server behind an
    // "Untrusted MCP server" dialog; a `--mcp-config` server is not gated.
    const commandA = adapter.buildCommand(buildMcpOnlyOptions(sandbox, 'session-a'));
    const commandB = adapter.buildCommand(buildMcpOnlyOptions(sandbox, 'session-b'));

    expect(commandA).toContain('--mcp-config');
    expect(commandA).toContain('session-a/mcp.json');
    expect(commandB).toContain('session-b/mcp.json');
    expect(commandA).not.toContain('test-token-mcp');
    expect(fs.existsSync(path.join(sandbox, '.qwen', 'settings.json'))).toBe(false);
    for (const sessionId of ['session-a', 'session-b']) {
      const mcpConfig = JSON.parse(
        fs.readFileSync(path.join(sandbox, '.kangentic', 'sessions', sessionId, 'mcp.json'), 'utf-8'),
      ) as { mcpServers: Record<string, { httpUrl: string }> };
      expect(mcpConfig.mcpServers.kangentic.httpUrl).toBe('http://127.0.0.1:51234/mcp/proj-1');
    }
  });

  it('takes no folder hold, so its release strips a legacy entry another build left', () => {
    // No hold was taken, so the release is the folder's last one and the
    // legacy `kangentic` entry an older build (or a crash) left is stripped.
    adapter.buildCommand(buildMcpOnlyOptions(sandbox, 'session-a'));
    const settingsFile = seedKangenticMcpEntry();

    adapter.removeHooks(sandbox, 'session-a');
    if (fs.existsSync(settingsFile)) {
      const afterRelease = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      expect(afterRelease.mcpServers?.kangentic).toBeUndefined();
    }
  });

  it('gap-2: a release strips a legacy mcpServers.kangentic and keeps user servers', () => {
    adapter.buildCommand(buildMcpOnlyOptions(sandbox, 'session-x'));
    const settingsFile = seedKangenticMcpEntry({ 'user-server': { httpUrl: 'http://example.com/mcp' } });

    adapter.removeHooks(sandbox, 'session-x');

    // kangentic entry stripped; user-server preserved.
    const result = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    expect(result.mcpServers?.kangentic).toBeUndefined();
    expect(result.mcpServers?.['user-server']).toBeDefined();
  });
});

// -- QwenAdapter configuredModelFromCommand ------------------------------------

describe('QwenAdapter - configuredModelFromCommand', () => {
  // The card names the column's model from the spawned command before Qwen's
  // first assistant record reports one.
  it('reads the --model the builder emitted, with the raw id as the label', () => {
    const command = new QwenCommandBuilder().buildQwenCommand({
      qwenPath: '/usr/bin/qwen',
      taskId: 'task-1',
      cwd: '/mock/project',
      permissionMode: 'acceptEdits',
      model: 'qwen3-coder-plus',
      prompt: 'Rename the loader',
    });
    expect(new QwenAdapter().configuredModelFromCommand(command)).toEqual({ id: 'qwen3-coder-plus', displayName: 'qwen3-coder-plus' });
  });

  it('never reads a --model that sits inside the prompt', () => {
    const command = new QwenCommandBuilder().buildQwenCommand({
      qwenPath: '/usr/bin/qwen',
      taskId: 'task-1',
      cwd: '/mock/project',
      permissionMode: 'default',
      prompt: 'Explain what --model gpt-fake does',
    });
    expect(new QwenAdapter().configuredModelFromCommand(command)).toBeNull();
  });
});

// -- QwenAdapter getInjectionSequence -----------------------------------------

describe('QwenAdapter - getInjectionSequence', () => {
  let adapter: QwenAdapter;

  beforeEach(() => {
    adapter = new QwenAdapter();
  });

  it('emits /model <name> when modelChanged is true', () => {
    const sequence = adapter.getInjectionSequence({
      model: 'qwen2.5-coder-32b',
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual(['/model qwen2.5-coder-32b']);
  });

  it('returns empty array when only effortChanged (Qwen has no effort concept)', () => {
    const sequence = adapter.getInjectionSequence({
      model: null,
      modelChanged: false,
      effort: 'high',
      effortChanged: true,
    });
    expect(sequence).toEqual([]);
  });

  it('emits only /model when both model and effort change (effort still ignored)', () => {
    const sequence = adapter.getInjectionSequence({
      model: 'qwen3-coder',
      modelChanged: true,
      effort: 'xhigh',
      effortChanged: true,
    });
    expect(sequence).toEqual(['/model qwen3-coder']);
  });

  it('returns empty array when neither field changed', () => {
    const sequence = adapter.getInjectionSequence({
      model: null,
      modelChanged: false,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual([]);
  });

  it('returns empty array when modelChanged is true but model value is null', () => {
    // Clearing model override -> no command emitted (same as Gemini)
    const sequence = adapter.getInjectionSequence({
      model: null,
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual([]);
  });
});

describe('Qwen Adapter - subagent spawn tool', () => {
  it('names one of the tools that launch a subagent', () => {
    expect(QWEN_SUBAGENT_LAUNCH_TOOLS).toContain(new QwenAdapter().subagentSpawnToolName);
  });
});

describe('Qwen Adapter - which transcript file a run reads', () => {
  const SESSION_ID = '4231e6aa-5409-4749-9272-270e9aab079b';
  const CALL_TIME_MS = Date.parse('2026-06-12T10:00:00.000Z');
  let adapter: QwenAdapter;
  let tmpBase: string;
  let qwenHome: string;
  let workspace: string;
  let reportedPath: string;
  let chatPath: string;
  let savedQwenHome: string | undefined;
  let savedRuntimeDir: string | undefined;

  /** An assistant record with one API response's usage and the tool calls it made. */
  function assistantRecord(uuid: string, promptTokens: number, candidateTokens: number, calls: Array<{ id: string; at: number }>): string {
    return JSON.stringify({
      uuid,
      type: 'assistant',
      timestamp: new Date(calls[0]?.at ?? CALL_TIME_MS).toISOString(),
      message: {
        role: 'model',
        parts: calls.map((call) => ({ functionCall: { id: call.id, name: 'list_directory', args: { path: '.' } } })),
      },
      usageMetadata: {
        promptTokenCount: promptTokens,
        candidatesTokenCount: candidateTokens,
        totalTokenCount: promptTokens + candidateTokens,
      },
    });
  }

  function writeTranscript(filePath: string, lines: string[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  }

  beforeEach(() => {
    savedQwenHome = process.env.QWEN_HOME;
    savedRuntimeDir = process.env.QWEN_RUNTIME_DIR;
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-adapter-transcript-'));
    qwenHome = path.join(tmpBase, 'qwen-home');
    workspace = path.join(tmpBase, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    process.env.QWEN_HOME = qwenHome;
    delete process.env.QWEN_RUNTIME_DIR;
    chatPath = path.join(qwenHome, 'projects', qwenProjectSlug(workspace), 'chats', `${SESSION_ID}.jsonl`);
    reportedPath = path.join(tmpBase, 'reported', 'reported-chat.jsonl');
    resetQwenToolCallCursorsForTests();
    adapter = new QwenAdapter();
  });

  afterEach(() => {
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
    if (savedRuntimeDir === undefined) delete process.env.QWEN_RUNTIME_DIR;
    else process.env.QWEN_RUNTIME_DIR = savedRuntimeDir;
    resetQwenToolCallCursorsForTests();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  /** Two transcripts that differ in usage and tool calls, so the result shows which was read. */
  function writeBothTranscripts(): void {
    writeTranscript(reportedPath, [assistantRecord('reported-1', 100, 10, [{ id: 'call-reported', at: CALL_TIME_MS }])]);
    writeTranscript(chatPath, [
      assistantRecord('chat-1', 200, 20, [{ id: 'call-chat-1', at: CALL_TIME_MS }]),
      assistantRecord('chat-2', 300, 30, [{ id: 'call-chat-2', at: CALL_TIME_MS + 1000 }]),
    ]);
  }

  it('reads the reported transcript when it exists, over the chat the session id and cwd name', async () => {
    writeBothTranscripts();
    const input = { transcriptPath: reportedPath, agentSessionId: SESSION_ID, cwd: workspace };

    expect(await adapter.transcriptUsage(input)).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect((await adapter.transcriptToolCounts(input))?.toolCallCount).toBe(1);
  });

  it('falls back to the chat the session id and cwd name when the reported path does not exist', async () => {
    writeBothTranscripts();
    fs.rmSync(reportedPath, { force: true });
    const input = { transcriptPath: reportedPath, agentSessionId: SESSION_ID, cwd: workspace };

    // Both of the chat's responses: 200 + 300 in, 20 + 30 out.
    expect(await adapter.transcriptUsage(input)).toEqual({ inputTokens: 500, outputTokens: 50 });
    expect((await adapter.transcriptToolCounts(input))?.toolCallCount).toBe(2);
  });

  it('reads the chat when no transcript path was reported', async () => {
    writeBothTranscripts();

    expect(await adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: workspace }))
      .toEqual({ inputTokens: 500, outputTokens: 50 });
  });

  it('returns the reported path when there is no session id or cwd to fall back on', async () => {
    writeTranscript(reportedPath, [assistantRecord('reported-1', 100, 10, [{ id: 'call-reported', at: CALL_TIME_MS }])]);
    const missingPath = path.join(tmpBase, 'reported', 'missing-chat.jsonl');
    const resolveRunPath = (input: { transcriptPath?: string | null; agentSessionId?: string | null; cwd?: string | null }): Promise<string | null> =>
      (adapter as unknown as { runTranscriptPath(input: object): Promise<string | null> }).runTranscriptPath(input);

    expect(await resolveRunPath({ transcriptPath: reportedPath })).toBe(reportedPath);
    // Nothing to fall back on: the missing path is handed back as it was reported.
    expect(await resolveRunPath({ transcriptPath: missingPath })).toBe(missingPath);
    expect(await resolveRunPath({ transcriptPath: reportedPath, agentSessionId: SESSION_ID })).toBe(reportedPath);
    expect(await resolveRunPath({})).toBeNull();
    expect(await adapter.transcriptUsage({ transcriptPath: reportedPath }))
      .toEqual({ inputTokens: 100, outputTokens: 10 });
  });

  it('passes untilMs through, so a call made after it is not counted', async () => {
    writeBothTranscripts();
    const input = { agentSessionId: SESSION_ID, cwd: workspace };

    expect((await adapter.transcriptToolCounts({ ...input, untilMs: CALL_TIME_MS + 500 }))?.toolCallCount).toBe(1);
    expect((await adapter.transcriptToolCounts({ ...input, untilMs: CALL_TIME_MS + 5000 }))?.toolCallCount).toBe(2);
    // sinceMs rides the same input: the first call is before it.
    expect((await adapter.transcriptToolCounts({ ...input, sinceMs: CALL_TIME_MS + 500 }))?.toolCallCount).toBe(1);
  });
});
