/**
 * Unit tests for GeminiAdapter session ID extraction - both hook-based
 * (extractSessionId) and PTY output-based (captureSessionIdFromOutput).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { KANGENTIC_MCP_TOKEN_ENV, KANGENTIC_MCP_URL_ENV } from '../../src/main/agent/adapters/gemini/command-builder';
import { GeminiSessionHistoryParser } from '../../src/main/agent/adapters/gemini/session-history-parser';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

describe('Gemini Adapter - session ID capture', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter();
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

    it('extracts from full Gemini hook base schema', () => {
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
    it('captures UUID from gemini --resume line', () => {
      const output = "To resume this session: gemini --resume '4231e6aa-5409-4749-9272-270e9aab079b'";
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('captures UUID from gemini --resume without quotes', () => {
      const output = 'To resume this session: gemini --resume 4231e6aa-5409-4749-9272-270e9aab079b';
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('captures UUID from Session ID header line', () => {
      const output = 'Session ID:           4231e6aa-5409-4749-9272-270e9aab079b';
      expect(adapter.runtime.sessionId!.fromOutput!(output)).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('captures from full Gemini shutdown summary', () => {
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
        "To resume this session: gemini --resume '4231e6aa-5409-4749-9272-270e9aab079b'",
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

describe('GeminiSessionHistoryParser.captureSessionIdFromFilesystem', () => {
  const SESSION_UUID = '08889b8d-c485-4aaa-b91d-ae966fa0ab4a';

  let sandbox: string;
  let chatsDir: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-capture-'));
    const projectDirName = path.basename(sandbox).toLowerCase();
    chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectDirName, 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(chatsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('finds session file by startTime proximity', async () => {
    const spawnedAt = new Date();
    const startTime = new Date(spawnedAt.getTime() + 500).toISOString();
    const filename = `session-2026-04-09T19-18-${SESSION_UUID.slice(0, 8)}.json`;
    fs.writeFileSync(
      path.join(chatsDir, filename),
      JSON.stringify({
        sessionId: SESSION_UUID,
        startTime,
        messages: [],
      }),
    );

    const result = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: sandbox,
      maxAttempts: 1,
    });

    expect(result).toBe(SESSION_UUID);
  });

  it('ignores files with stale startTime', async () => {
    const spawnedAt = new Date();
    // startTime is 5 minutes before spawnedAt - outside the ±30s window
    const staleStartTime = new Date(spawnedAt.getTime() - 5 * 60_000).toISOString();
    const filename = `session-old-${SESSION_UUID.slice(0, 8)}.json`;
    fs.writeFileSync(
      path.join(chatsDir, filename),
      JSON.stringify({
        sessionId: SESSION_UUID,
        startTime: staleStartTime,
        messages: [],
      }),
    );

    const result = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt,
      cwd: sandbox,
      maxAttempts: 1,
    });

    expect(result).toBeNull();
  });

  it('returns null when chats directory does not exist', async () => {
    // Use a cwd whose basename doesn't match any existing directory
    const missingCwd = path.join(os.tmpdir(), 'nonexistent-project-xyz');
    const result = await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: missingCwd,
      maxAttempts: 1,
    });

    expect(result).toBeNull();
  });
});

describe('GeminiSessionHistoryParser.locate', () => {
  // REGRESSION: Gemini 0.37 embeds only the FIRST 8 CHARS of the
  // session UUID in the chat filename, e.g. for
  // "08889b8d-c485-4aaa-b91d-ae966fa0ab4a" it writes
  // "session-2026-04-01T23-37-08889b8d.json". The original locate()
  // regex looked for the full UUID and never matched, so the session
  // history reader never attached and the task card was stuck on
  // "Loading agent..." forever. This test exercises the real layout.
  const FULL_UUID = '08889b8d-c485-4aaa-b91d-ae966fa0ab4a';
  const SHORT_ID = '08889b8d';

  let sandbox: string;
  let chatsDir: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-locate-'));
    const projectDirName = path.basename(sandbox).toLowerCase();
    chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectDirName, 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(chatsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('finds a chat file whose filename embeds only the short (8-char) prefix', async () => {
    const filename = `session-2026-04-01T23-37-${SHORT_ID}.json`;
    const filepath = path.join(chatsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify({ sessionId: FULL_UUID, messages: [] }));

    const result = await GeminiSessionHistoryParser.locate({
      agentSessionId: FULL_UUID,
      cwd: sandbox,
    });

    expect(result).toBe(filepath);
  });

  it('still matches filenames with the full UUID if Gemini ever changes the scheme', async () => {
    const filename = `session-${FULL_UUID}.json`;
    const filepath = path.join(chatsDir, filename);
    fs.writeFileSync(filepath, JSON.stringify({ sessionId: FULL_UUID, messages: [] }));

    const result = await GeminiSessionHistoryParser.locate({
      agentSessionId: FULL_UUID,
      cwd: sandbox,
    });

    expect(result).toBe(filepath);
  });
});

describe('Gemini Adapter - concurrent-session hook holds', () => {
  let sandbox: string;
  let adapter: GeminiAdapter;
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
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-gemini-refcount-'));
    settingsPath = path.join(sandbox, '.gemini', 'settings.json');
    adapter = new GeminiAdapter();
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  // Holds are keyed by the session's own id (`ptySessionId`), never by its
  // task: a task's sessions overlap while an old PTY exits.
  const buildOptions = (cwd: string, ptySessionId: string, taskId = `task-of-${ptySessionId}`) => ({
    agentPath: 'gemini',
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
    // Two concurrent sessions in the same cwd, distinct tasks.
    adapter.buildCommand(buildOptions(sandbox, 'session-a'));
    adapter.buildCommand(buildOptions(sandbox, 'session-b'));

    // Manually seed hooks so removeHooks has something to strip. We cannot
    // actually run the real Gemini binary, so we emulate the state that
    // buildCommand's createMergedSettings would produce.
    seedSettingsWithKangenticHook();

    // Session A releases: hooks must remain because session B is still live.
    adapter.removeHooks(sandbox, 'session-a');
    expect(sessionStartHookCount()).toBe(1);

    // Session B releases: now the file is cleaned up (safelyUpdateSettingsFile
    // deletes it when hooks was the only key).
    adapter.removeHooks(sandbox, 'session-b');
    expect(sessionStartHookCount()).toBeUndefined();
  });

  it('double-release for the same session is idempotent (suspend + onExit)', () => {
    adapter.buildCommand(buildOptions(sandbox, 'session-a'));
    adapter.buildCommand(buildOptions(sandbox, 'session-b'));
    seedSettingsWithKangenticHook();

    // Session-manager's suspend() path calls removeHooks explicitly, then
    // the PTY's onExit handler calls it again. Both pass the same session id.
    adapter.removeHooks(sandbox, 'session-a');
    adapter.removeHooks(sandbox, 'session-a');

    // Session B is still live, so hooks must still be present.
    expect(sessionStartHookCount()).toBe(1);
  });

  it('an older session of the same task releasing late keeps the newer session\'s hooks', () => {
    // A young session's kill parks its PTY for the grace; the task respawns
    // meanwhile, and the old PTY's exit releases after the new build. Keyed by
    // task, that release emptied the holders and stripped the running
    // session's hooks.
    adapter.buildCommand(buildOptions(sandbox, 'old-session', 'task-a'));
    adapter.buildCommand(buildOptions(sandbox, 'new-session', 'task-a'));
    seedSettingsWithKangenticHook();

    adapter.removeHooks(sandbox, 'old-session');
    expect(sessionStartHookCount()).toBe(1);

    adapter.removeHooks(sandbox, 'new-session');
    expect(sessionStartHookCount()).toBeUndefined();
  });

  it('an MCP-only spawn holds the file too', () => {
    // The builder writes the MCP entry with no events pipeline, so a
    // neighbour's exit must not strip it while this session runs.
    adapter.buildCommand({
      ...buildOptions(sandbox, 'mcp-only'),
      eventsOutputPath: undefined,
      mcpServerEnabled: true,
      mcpServerUrl: 'http://127.0.0.1:4000/mcp/project',
      mcpServerToken: 'token',
    });
    adapter.buildCommand(buildOptions(sandbox, 'session-b'));
    seedSettingsWithKangenticHook();

    adapter.removeHooks(sandbox, 'session-b');
    expect(sessionStartHookCount()).toBe(1);
  });

  it('decouples holds across different cwds', () => {
    const sandboxTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-gemini-refcount-b-'));
    try {
      adapter.buildCommand(buildOptions(sandbox, 'session-a'));
      adapter.buildCommand(buildOptions(sandboxTwo, 'session-b'));

      seedSettingsWithKangenticHook();
      const settingsPathTwo = path.join(sandboxTwo, '.gemini', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPathTwo), { recursive: true });
      fs.writeFileSync(settingsPathTwo, fs.readFileSync(settingsPath, 'utf-8'));

      // Releasing session-a in one directory does not touch the other.
      adapter.removeHooks(sandbox, 'session-a');
      const stillThere = JSON.parse(fs.readFileSync(settingsPathTwo, 'utf-8'));
      expect(stillThere.hooks?.SessionStart?.length).toBe(1);
    } finally {
      fs.rmSync(sandboxTwo, { recursive: true, force: true });
    }
  });

  it('tolerates removeHooks with no prior retain (crash/restart path)', () => {
    seedSettingsWithKangenticHook();
    expect(() => adapter.removeHooks(sandbox, 'orphan-session')).not.toThrow();
  });
});

// -- buildEnv ------------------------------------------------------------------

describe('GeminiAdapter - buildEnv', () => {
  // The folder-shared .gemini/settings.json names the MCP URL and token as env
  // references (task #859), so the adapter's environment is the only place the
  // per-session values live. Dropping this forward leaves Gemini with unresolved
  // ${KANGENTIC_MCP_URL} references and no kangentic_* tools.
  const MCP_URL = 'http://127.0.0.1:5555/mcp/project-123/sess-xyz';
  const MCP_TOKEN = 'secret-token';

  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter();
  });

  const spawnOptions = (overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions => ({
    agentPath: 'gemini',
    taskId: 'task-1',
    cwd: '/mock/project',
    permissionMode: 'default',
    ...overrides,
  });

  it('returns the MCP URL and token under the variables the settings file references', () => {
    const environment = adapter.buildEnv!(spawnOptions({
      mcpServerEnabled: true,
      mcpServerUrl: MCP_URL,
      mcpServerToken: MCP_TOKEN,
    }));
    expect(environment).toEqual({
      [KANGENTIC_MCP_URL_ENV]: MCP_URL,
      [KANGENTIC_MCP_TOKEN_ENV]: MCP_TOKEN,
    });
  });

  it('forwards the URL and token alongside a model and an effort override', () => {
    // The adapter renames agentPath and pulls model and effort out of the
    // options; the MCP fields must still reach the builder with them.
    const environment = adapter.buildEnv!(spawnOptions({
      model: 'gemini-2.5-pro',
      effort: 'high',
      mcpServerUrl: MCP_URL,
      mcpServerToken: MCP_TOKEN,
    }));
    expect(environment).toEqual({
      [KANGENTIC_MCP_URL_ENV]: MCP_URL,
      [KANGENTIC_MCP_TOKEN_ENV]: MCP_TOKEN,
    });
  });

  it('returns null when the MCP server is switched off', () => {
    expect(adapter.buildEnv!(spawnOptions({
      mcpServerEnabled: false,
      mcpServerUrl: MCP_URL,
      mcpServerToken: MCP_TOKEN,
    }))).toBeNull();
  });

  it.each([
    ['no URL', { mcpServerUrl: undefined, mcpServerToken: MCP_TOKEN }],
    ['no token', { mcpServerUrl: MCP_URL, mcpServerToken: undefined }],
  ])('returns null with %s', (_label, overrides) => {
    expect(adapter.buildEnv!(spawnOptions({ mcpServerEnabled: true, ...overrides }))).toBeNull();
  });
});

// -- getInjectionSequence -----------------------------------------------------

describe('GeminiAdapter - getInjectionSequence', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter();
  });

  it('emits /model <name> when modelChanged is true', () => {
    const sequence = adapter.getInjectionSequence({
      model: 'gemini-2.5-pro',
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual(['/model gemini-2.5-pro']);
  });

  it('returns empty array when only effortChanged (Gemini has no effort concept)', () => {
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
      model: 'gemini-2.0-flash',
      modelChanged: true,
      effort: 'high',
      effortChanged: true,
    });
    expect(sequence).toEqual(['/model gemini-2.0-flash']);
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
    // Clearing model override -> no command emitted
    const sequence = adapter.getInjectionSequence({
      model: null,
      modelChanged: true,
      effort: null,
      effortChanged: false,
    });
    expect(sequence).toEqual([]);
  });
});

// -- agent-display-name - gemini entry ----------------------------------------

describe('agent-display-name - gemini entry', () => {
  it('agentDisplayName returns "Gemini CLI" for "gemini"', () => {
    expect(agentDisplayName('gemini')).toBe('Gemini CLI');
  });

  it('agentShortName returns "Gemini" for "gemini"', () => {
    expect(agentShortName('gemini')).toBe('Gemini');
  });

  it('agentInstallUrl returns the Gemini CLI repo URL for "gemini"', () => {
    expect(agentInstallUrl('gemini')).toBe('https://github.com/google-gemini/gemini-cli');
  });
});
