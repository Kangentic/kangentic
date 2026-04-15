/**
 * Unit tests for CursorAdapter - detection, command building, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

// Mock which, fs, and exec-version before importing adapter
let mockWhichResult: string | Error = '/usr/local/bin/agent';
let mockExecVersionStdout = '0.50.3\n';
let mockExecVersionShouldFail = false;
let execVersionCallCount = 0;

vi.mock('which', () => ({
  default: async () => {
    if (mockWhichResult instanceof Error) throw mockWhichResult;
    return mockWhichResult;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: {
      ...original,
      existsSync: () => true,
    },
  };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: async () => {
    execVersionCallCount++;
    if (mockExecVersionShouldFail) {
      throw new Error('command not found');
    }
    return { stdout: mockExecVersionStdout, stderr: '' };
  },
}));

// Import after mocks are set up
const { CursorAdapter } = await import('../../src/main/agent/adapters/cursor');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build minimal SpawnCommandOptions with sensible defaults. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/local/bin/agent',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

// ── CursorAdapter ────────────────────────────────────────────────────────────

describe('CursorAdapter', () => {
  let adapter: CursorAdapter;

  beforeEach(() => {
    adapter = new CursorAdapter();
    mockWhichResult = '/usr/local/bin/agent';
    mockExecVersionStdout = '0.50.3\n';
    mockExecVersionShouldFail = false;
    execVersionCallCount = 0;
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it('has name "cursor"', () => {
    expect(adapter.name).toBe('cursor');
  });

  it('has displayName "Cursor CLI"', () => {
    expect(adapter.displayName).toBe('Cursor CLI');
  });

  it('has sessionType "cursor_agent"', () => {
    expect(adapter.sessionType).toBe('cursor_agent');
  });

  it('does not support caller session IDs', () => {
    expect(adapter.supportsCallerSessionId).toBe(false);
  });

  it('defaults to bypassPermissions so stream-json telemetry is on', () => {
    // Stream-json's init event is the only documented surface that
    // exposes Cursor's resolved model + session_id together. Defaulting
    // to bypassPermissions ensures the ContextBar model pill resolves
    // and `--resume=<id>` works without the user opting in manually.
    expect(adapter.defaultPermission).toBe('bypassPermissions');
  });

  it('exposes a streamOutput parser factory', () => {
    expect(adapter.runtime.streamOutput).toBeDefined();
    const parser = adapter.runtime.streamOutput?.createParser();
    expect(parser).toBeDefined();
    expect(typeof parser?.parseTelemetry).toBe('function');
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found: true with override path', async () => {
      const result = await adapter.detect('/custom/agent');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/agent');
      expect(result.version).toBe('0.50.3');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/local/bin/agent');
    });

    it('returns found: false when which fails', async () => {
      mockWhichResult = new Error('not found');
      const result = await adapter.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('returns found: false with configured path when --version fails on override', async () => {
      mockExecVersionShouldFail = true;
      const result = await adapter.detect('/custom/agent');
      expect(result.found).toBe(false);
      expect(result.path).toBe('/custom/agent');
      expect(result.version).toBeNull();
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/agent');
      const second = await adapter.detect('/custom/agent');
      expect(first).toBe(second);
      expect(execVersionCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/agent');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/agent');
      expect(execVersionCallCount).toBe(2);
    });

    it('parses version from plain version string', async () => {
      mockExecVersionStdout = '0.50.3\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBe('0.50.3');
    });

    it('parses version from prefixed "agent" output', async () => {
      mockExecVersionStdout = 'agent 1.2.3\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBe('1.2.3');
    });

    it('parses version from "Cursor Agent" prefix', async () => {
      mockExecVersionStdout = 'Cursor Agent 2.0.0-beta\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBe('2.0.0-beta');
    });

    it('returns null for non-version output', async () => {
      mockExecVersionStdout = 'Usage: agent [options]\n';
      adapter.invalidateDetectionCache();
      const result = await adapter.detect('/custom/agent');
      expect(result.version).toBeNull();
    });
  });

  // ── buildCommand ─────────────────────────────────────────────────────────

  describe('buildCommand', () => {
    // ── Interactive mode (default) ──────────────────────────────────────

    it('builds interactive command with prompt as positional arg', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug' }));
      expect(command).not.toContain('-p');
      expect(command).not.toContain('--output-format');
      expect(command).toContain('Fix the bug');
    });

    it('omits prompt when none provided', () => {
      const command = adapter.buildCommand(makeOptions());
      const parts = command.split(' ');
      // Only the agent path
      expect(parts.length).toBe(1);
    });

    // ── Non-interactive mode (bypassPermissions) ────────────────────────

    it('adds -p and --output-format stream-json for bypassPermissions', () => {
      const command = adapter.buildCommand(makeOptions({
        permissionMode: 'bypassPermissions',
        prompt: 'Fix the bug',
      }));
      expect(command).toContain('-p');
      expect(command).toContain('--output-format');
      expect(command).toContain('stream-json');
    });

    it('adds -p and --output-format stream-json for nonInteractive flag', () => {
      const command = adapter.buildCommand(makeOptions({
        nonInteractive: true,
        prompt: 'Fix the bug',
      }));
      expect(command).toContain('-p');
      expect(command).toContain('--output-format');
      expect(command).toContain('stream-json');
    });

    // ── Resume mode ─────────────────────────────────────────────────────

    it('builds resume command with --resume flag', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: 'chat-abc-123',
        resume: true,
      }));
      expect(command).toContain('--resume=');
      expect(command).toContain('chat-abc-123');
    });

    it('resume command does not include prompt or -p', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: 'chat-abc-123',
        resume: true,
        prompt: 'This should be ignored',
      }));
      expect(command).not.toContain('-p');
      expect(command).not.toContain('This should be ignored');
    });

    // ── Permission mode mapping ─────────────────────────────────────────

    describe('permission mode mapping', () => {
      const nonInteractiveModes: PermissionMode[] = ['bypassPermissions'];
      const interactiveModes: PermissionMode[] = ['default', 'plan', 'dontAsk', 'acceptEdits', 'auto'];

      for (const mode of nonInteractiveModes) {
        it(`uses -p for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({
            permissionMode: mode,
            prompt: 'test',
          }));
          expect(command).toContain('-p');
        });
      }

      for (const mode of interactiveModes) {
        it(`uses interactive mode for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({
            permissionMode: mode,
            prompt: 'test',
          }));
          expect(command).not.toContain('-p');
          expect(command).not.toContain('--output-format');
        });
      }
    });

    // ── Shell quoting ───────────────────────────────────────────────────

    describe('shell quoting', () => {
      it('replaces double quotes with single quotes for non-unix shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'powershell',
        }));
        expect(command).not.toContain('"broken"');
        expect(command).toContain("'broken'");
      });

      it('preserves double quotes for unix-like shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'bash',
        }));
        expect(command).toContain('"broken"');
      });
    });

    it('starts with quoted agent path', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: '/usr/local/bin/agent',
        shell: 'bash',
      }));
      expect(command.startsWith(quoteArg('/usr/local/bin/agent', 'bash'))).toBe(true);
    });
  });

  // ── Runtime strategy ──────────────────────────────────────────────────────

  describe('runtime', () => {
    it('uses pty activity detection', () => {
      expect(adapter.runtime.activity.kind).toBe('pty');
    });

    it('has session ID capture via fromOutput', () => {
      expect(adapter.runtime.sessionId).toBeDefined();
      expect(adapter.runtime.sessionId!.fromOutput).toBeDefined();
    });

    it('has no session history', () => {
      expect(adapter.runtime.sessionHistory).toBeUndefined();
    });

    it('has no status file', () => {
      expect(adapter.runtime.statusFile).toBeUndefined();
    });
  });

  // ── Session ID capture ────────────────────────────────────────────────────

  describe('sessionId.fromOutput', () => {
    function fromOutput(data: string): string | null {
      return adapter.runtime.sessionId!.fromOutput!(data);
    }

    it('captures UUID from NDJSON init event', () => {
      const line = '{"type":"system","subtype":"init","session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff","model":"Claude 4 Sonnet"}';
      expect(fromOutput(line)).toBe('c6b62c6f-7ead-4fd6-9922-e952131177ff');
    });

    it('captures UUID from multi-line NDJSON stream', () => {
      const output = [
        '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","model":"GPT-5","permissionMode":"default"}',
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]},"session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}',
      ].join('\n');
      expect(fromOutput(output)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('returns null for interactive output without session_id', () => {
      expect(fromOutput('Welcome to Cursor Agent')).toBeNull();
      expect(fromOutput('MOCK_CURSOR_SESSION:abc')).toBeNull();
    });

    it('returns null for empty data', () => {
      expect(fromOutput('')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(fromOutput('{"session_id": "not-a-uuid"}')).toBeNull();
    });

    it('matches real Cursor CLI NDJSON fixture format', () => {
      // Real-format fixture from Cursor CLI docs
      const fixture = '{"type":"system","subtype":"init","apiKeySource":"env|flag|login","cwd":"/absolute/path","session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff","model":"Claude 4 Sonnet","permissionMode":"default"}';
      expect(fromOutput(fixture)).toBe('c6b62c6f-7ead-4fd6-9922-e952131177ff');
    });
  });

  // ── No-op methods ────────────────────────────────────────────────────────

  describe('no-op methods', () => {
    it('ensureTrust resolves without error', async () => {
      await expect(adapter.ensureTrust('/some/dir')).resolves.toBeUndefined();
    });

    it('removeHooks does not throw', () => {
      expect(() => adapter.removeHooks('/some/dir')).not.toThrow();
    });

    it('clearSettingsCache does not throw', () => {
      expect(() => adapter.clearSettingsCache()).not.toThrow();
    });

    it('locateSessionHistoryFile returns null', async () => {
      const result = await adapter.locateSessionHistoryFile('session-1', '/some/dir');
      expect(result).toBeNull();
    });
  });

  // ── Output detection ──────────────────────────────────────────────────────

  describe('detectFirstOutput', () => {
    it('returns true for any non-empty data', () => {
      expect(adapter.detectFirstOutput('hello')).toBe(true);
    });

    it('returns false for empty data', () => {
      expect(adapter.detectFirstOutput('')).toBe(false);
    });
  });

  // ── Exit sequence ─────────────────────────────────────────────────────────

  describe('getExitSequence', () => {
    it('returns Ctrl+C', () => {
      expect(adapter.getExitSequence()).toEqual(['\x03']);
    });
  });

  // ── interpolateTemplate ──────────────────────────────────────────────────

  describe('interpolateTemplate', () => {
    it('replaces {{key}} placeholders', () => {
      const result = adapter.interpolateTemplate(
        'Fix {{issue}} in {{file}}',
        { issue: 'bug-123', file: 'main.ts' },
      );
      expect(result).toBe('Fix bug-123 in main.ts');
    });

    it('leaves unmatched placeholders unchanged', () => {
      const result = adapter.interpolateTemplate('{{name}} - {{unknown}}', { name: 'test' });
      expect(result).toBe('test - {{unknown}}');
    });
  });
});

// ── Registry integration ─────────────────────────────────────────────────────

describe('Agent Registry - Cursor', () => {
  it('has cursor adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('cursor')).toBe(true);
  });

  it('getOrThrow returns CursorAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('cursor');
    expect(adapter.name).toBe('cursor');
    expect(adapter.sessionType).toBe('cursor_agent');
  });

  it('lists cursor among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('cursor');
  });

  it('can look up cursor by session type', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getBySessionType('cursor_agent');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('cursor');
  });
});
