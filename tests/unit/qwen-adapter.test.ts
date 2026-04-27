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
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code';
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

describe('Qwen Adapter - concurrent-session hook reference counting', () => {
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

  const buildOptions = (cwd: string, taskId: string) => ({
    agentPath: 'qwen',
    taskId,
    cwd,
    permissionMode: 'default' as const,
    eventsOutputPath: path.join(cwd, 'events.jsonl'),
  });

  it('strips hooks only after the last live session releases', () => {
    adapter.buildCommand(buildOptions(sandbox, 'task-a'));
    adapter.buildCommand(buildOptions(sandbox, 'task-b'));

    seedSettingsWithKangenticHook();

    adapter.removeHooks(sandbox, 'task-a');
    const afterFirst = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(afterFirst.hooks?.SessionStart?.length).toBe(1);

    adapter.removeHooks(sandbox, 'task-b');
    const afterSecondExists = fs.existsSync(settingsPath);
    if (afterSecondExists) {
      const afterSecond = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(afterSecond.hooks?.SessionStart).toBeUndefined();
    } else {
      expect(afterSecondExists).toBe(false);
    }
  });

  it('double-release for the same taskId is idempotent (suspend + onExit)', () => {
    adapter.buildCommand(buildOptions(sandbox, 'task-a'));
    adapter.buildCommand(buildOptions(sandbox, 'task-b'));
    seedSettingsWithKangenticHook();

    adapter.removeHooks(sandbox, 'task-a');
    adapter.removeHooks(sandbox, 'task-a');

    const afterDoubleRelease = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(afterDoubleRelease.hooks?.SessionStart?.length).toBe(1);
  });

  it('decouples reference counts across different cwds', () => {
    const sandboxTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-qwen-refcount-b-'));
    try {
      adapter.buildCommand(buildOptions(sandbox, 'task-a'));
      adapter.buildCommand(buildOptions(sandboxTwo, 'task-b'));

      seedSettingsWithKangenticHook();
      const settingsPathTwo = path.join(sandboxTwo, '.qwen', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPathTwo), { recursive: true });
      fs.writeFileSync(settingsPathTwo, fs.readFileSync(settingsPath, 'utf-8'));

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
   * buildOptions with MCP config but NO eventsOutputPath.
   * This is the "MCP-only" path introduced when the in-process MCP HTTP
   * server is wired into Qwen sessions.
   */
  const buildMcpOnlyOptions = (cwd: string, taskId: string) => ({
    agentPath: 'qwen',
    taskId,
    cwd,
    permissionMode: 'default' as const,
    mcpServerEnabled: true as const,
    mcpServerUrl: 'http://127.0.0.1:51234/mcp/proj-1',
    mcpServerToken: 'test-token-mcp',
    // eventsOutputPath intentionally absent
  });

  it('gap-1: does NOT retain a hook reference when only MCP is configured', () => {
    // Call buildCommand twice with MCP-only options. If retainHooks were
    // incorrectly called, the reference counter for `sandbox` would be 2
    // and the first removeHooks call would leave the counter at 1 (not
    // calling removeQwenHooks at all). The test proves the counter stays at
    // zero: even after two spawns, a single removeHooks call with an
    // unregistered taskId still invokes the underlying cleanup.
    adapter.buildCommand(buildMcpOnlyOptions(sandbox, 'task-a'));
    adapter.buildCommand(buildMcpOnlyOptions(sandbox, 'task-b'));

    // Write a settings file that has only the kangentic MCP entry - this
    // simulates what createMergedSettings wrote for the two spawns.
    const qwenDir = path.join(sandbox, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.writeFileSync(
      path.join(qwenDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          kangentic: {
            httpUrl: 'http://127.0.0.1:51234/mcp/proj-1',
            headers: { 'X-Kangentic-Token': 'test-token-mcp' },
          },
        },
      }, null, 2),
    );

    // removeHooks with an unregistered taskId (no retain was called for
    // 'task-a' or 'task-b' because eventsOutputPath was absent). When
    // hookHolders is empty for sandbox, removeQwenHooks runs unconditionally.
    adapter.removeHooks(sandbox, 'task-a');

    // mcpServers.kangentic must be stripped - the file should now be empty
    // (no user hooks or user MCP servers) so either the key is gone or the
    // file is deleted.
    const stillExists = fs.existsSync(path.join(qwenDir, 'settings.json'));
    if (stillExists) {
      const result = JSON.parse(fs.readFileSync(path.join(qwenDir, 'settings.json'), 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(result.mcpServers?.kangentic).toBeUndefined();
    }
    // If the file was deleted entirely, that is also an acceptable outcome.
  });

  it('gap-2: removeHooks after MCP-only spawn strips mcpServers.kangentic even with empty hookHolders', () => {
    // Spawn once with MCP-only options. hookHolders map stays empty.
    adapter.buildCommand(buildMcpOnlyOptions(sandbox, 'task-x'));

    // Settings file written by createMergedSettings for the MCP-only spawn.
    const qwenDir = path.join(sandbox, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.writeFileSync(
      path.join(qwenDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          kangentic: {
            httpUrl: 'http://127.0.0.1:51234/mcp/proj-1',
            headers: { 'X-Kangentic-Token': 'test-token-mcp' },
          },
          'user-server': { httpUrl: 'http://example.com/mcp' },
        },
      }, null, 2),
    );

    // With hookHolders empty for sandbox, the adapter calls removeQwenHooks
    // immediately - no gating on a reference counter.
    adapter.removeHooks(sandbox, 'task-x');

    // kangentic entry stripped; user-server preserved.
    const result = JSON.parse(
      fs.readFileSync(path.join(qwenDir, 'settings.json'), 'utf-8'),
    ) as { mcpServers?: Record<string, unknown> };
    expect(result.mcpServers?.kangentic).toBeUndefined();
    expect(result.mcpServers?.['user-server']).toBeDefined();
  });
});
