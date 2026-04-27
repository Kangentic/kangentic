/**
 * Unit tests for GeminiAdapter session ID extraction - both hook-based
 * (extractSessionId) and PTY output-based (captureSessionIdFromOutput).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { GeminiSessionHistoryParser } from '../../src/main/agent/adapters/gemini/session-history-parser';
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

describe('Gemini Adapter - concurrent-session hook reference counting', () => {
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

  const buildOptions = (cwd: string, taskId: string) => ({
    agentPath: 'gemini',
    taskId,
    cwd,
    permissionMode: 'default' as const,
    eventsOutputPath: path.join(cwd, 'events.jsonl'),
  });

  it('strips hooks only after the last live session releases', () => {
    // Two concurrent sessions in the same cwd, distinct tasks.
    adapter.buildCommand(buildOptions(sandbox, 'task-a'));
    adapter.buildCommand(buildOptions(sandbox, 'task-b'));

    // Manually seed hooks so removeHooks has something to strip. We cannot
    // actually run the real Gemini binary, so we emulate the state that
    // buildCommand's createMergedSettings would produce.
    seedSettingsWithKangenticHook();

    // Task A releases: hooks must remain because task B is still live.
    adapter.removeHooks(sandbox, 'task-a');
    const afterFirst = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(afterFirst.hooks?.SessionStart?.length).toBe(1);

    // Task B releases: now the file is cleaned up.
    adapter.removeHooks(sandbox, 'task-b');
    const afterSecondExists = fs.existsSync(settingsPath);
    if (afterSecondExists) {
      const afterSecond = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(afterSecond.hooks?.SessionStart).toBeUndefined();
    } else {
      // safelyUpdateSettingsFile deletes the file when hooks was the only key.
      expect(afterSecondExists).toBe(false);
    }
  });

  it('double-release for the same taskId is idempotent (suspend + onExit)', () => {
    adapter.buildCommand(buildOptions(sandbox, 'task-a'));
    adapter.buildCommand(buildOptions(sandbox, 'task-b'));
    seedSettingsWithKangenticHook();

    // Session-manager's suspend() path calls removeHooks explicitly, then
    // the PTY's onExit handler calls it again. Both pass the same taskId.
    adapter.removeHooks(sandbox, 'task-a');
    adapter.removeHooks(sandbox, 'task-a');

    // Task B is still live, so hooks must still be present.
    const afterDoubleRelease = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(afterDoubleRelease.hooks?.SessionStart?.length).toBe(1);
  });

  it('decouples reference counts across different cwds', () => {
    const sandboxTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-gemini-refcount-b-'));
    try {
      adapter.buildCommand(buildOptions(sandbox, 'task-a'));
      adapter.buildCommand(buildOptions(sandboxTwo, 'task-b'));

      seedSettingsWithKangenticHook();
      const settingsPathTwo = path.join(sandboxTwo, '.gemini', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPathTwo), { recursive: true });
      fs.writeFileSync(settingsPathTwo, fs.readFileSync(settingsPath, 'utf-8'));

      // Releasing task-a in one directory does not touch the other.
      adapter.removeHooks(sandbox, 'task-a');
      const stillThere = JSON.parse(fs.readFileSync(settingsPathTwo, 'utf-8'));
      expect(stillThere.hooks?.SessionStart?.length).toBe(1);
    } finally {
      fs.rmSync(sandboxTwo, { recursive: true, force: true });
    }
  });

  it('tolerates removeHooks with no prior retain (crash/restart path)', () => {
    seedSettingsWithKangenticHook();
    expect(() => adapter.removeHooks(sandbox, 'orphan-task')).not.toThrow();
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
