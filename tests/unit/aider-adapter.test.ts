/**
 * Unit tests for AiderAdapter - detection, command building, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

// Mock which, fs, and exec-version before importing adapter
let mockWhichResult: string | Error = '/usr/bin/aider';
let mockExecVersionStdout = 'aider v0.50.1\n';
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
const { AiderAdapter } = await import('../../src/main/agent/adapters/aider');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build minimal SpawnCommandOptions with sensible defaults. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/aider',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

// ── AiderAdapter ─────────────────────────────────────────────────────────────

describe('AiderAdapter', () => {
  let adapter: AiderAdapter;

  beforeEach(() => {
    adapter = new AiderAdapter();
    mockWhichResult = '/usr/bin/aider';
    mockExecVersionStdout = 'aider v0.50.1\n';
    mockExecVersionShouldFail = false;
    execVersionCallCount = 0;
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it('has name "aider"', () => {
    expect(adapter.name).toBe('aider');
  });

  it('has sessionType "aider_agent"', () => {
    expect(adapter.sessionType).toBe('aider_agent');
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found: true with override path', async () => {
      const result = await adapter.detect('/custom/aider');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/aider');
      expect(result.version).toBe('v0.50.1');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/aider');
    });

    it('returns found: false when which fails', async () => {
      mockWhichResult = new Error('not found');
      const result = await adapter.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('returns found: true with null version when --version fails', async () => {
      mockExecVersionShouldFail = true;
      const result = await adapter.detect('/custom/aider');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/aider');
      expect(result.version).toBeNull();
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/aider');
      const second = await adapter.detect('/custom/aider');

      expect(first).toBe(second); // Same object reference (cached)
      expect(execVersionCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/aider');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/aider');

      // Called twice because cache was invalidated
      expect(execVersionCallCount).toBe(2);
    });
  });

  // ── buildCommand ─────────────────────────────────────────────────────────

  describe('buildCommand', () => {
    it('builds basic command with --no-auto-commits', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).toContain('--no-auto-commits');
    });

    it('includes --message when prompt is provided', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug' }));
      expect(command).toContain('--message');
      expect(command).toContain('Fix the bug');
    });

    it('omits --message when no prompt', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--message');
    });

    it('always includes --no-auto-commits', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'test' }));
      expect(command).toContain('--no-auto-commits');
    });

    // ── Permission mode mapping ──────────────────────────────────────────

    describe('permission mode mapping', () => {
      const yesPermissionModes: PermissionMode[] = ['bypassPermissions', 'dontAsk', 'acceptEdits', 'auto'];
      const noYesPermissionModes: PermissionMode[] = ['default', 'plan'];

      for (const mode of yesPermissionModes) {
        it(`adds --yes for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          expect(command).toContain('--yes');
        });
      }

      for (const mode of noYesPermissionModes) {
        it(`omits --yes for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          expect(command).not.toContain('--yes');
        });
      }
    });

    // ── Shell quoting ────────────────────────────────────────────────────

    describe('shell quoting', () => {
      it('replaces double quotes with single quotes for non-unix shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'powershell',
        }));
        // Double quotes in prompt should be replaced with single quotes
        expect(command).not.toContain('"broken"');
        expect(command).toContain("'broken'");
      });

      it('preserves double quotes for unix-like shells', () => {
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the "broken" test',
          shell: 'bash',
        }));
        // Single-quoted on bash, double quotes preserved literally inside
        expect(command).toContain('"broken"');
      });
    });

    // ── Ignored options ──────────────────────────────────────────────────

    it('ignores resume flag (Aider has no session resume)', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: 'session-123',
        resume: true,
      }));
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--session-id');
      expect(command).not.toContain('session-123');
    });

    it('ignores nonInteractive flag', () => {
      const command = adapter.buildCommand(makeOptions({ nonInteractive: true }));
      expect(command).not.toContain('--print');
    });

    it('starts with quoted agent path', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: '/usr/local/bin/aider',
        shell: 'bash',
      }));
      expect(command.startsWith(quoteArg('/usr/local/bin/aider', 'bash'))).toBe(true);
    });
  });

  // ── No-op methods ────────────────────────────────────────────────────────

  describe('no-op methods', () => {
    it('ensureTrust resolves without error', async () => {
      await expect(adapter.ensureTrust('/some/dir')).resolves.toBeUndefined();
    });

    it('parseStatus returns null', () => {
      expect(adapter.parseStatus('{"some":"data"}')).toBeNull();
    });

    it('parseEvent returns null', () => {
      expect(adapter.parseEvent('{"type":"tool_start"}')).toBeNull();
    });

    it('stripHooks does not throw', () => {
      expect(() => adapter.stripHooks('/some/dir')).not.toThrow();
    });

    it('clearSettingsCache does not throw', () => {
      expect(() => adapter.clearSettingsCache()).not.toThrow();
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

describe('Agent Registry', () => {
  it('has aider adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('aider')).toBe(true);
  });

  it('getOrThrow returns AiderAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('aider');
    expect(adapter.name).toBe('aider');
    expect(adapter.sessionType).toBe('aider_agent');
  });

  it('lists aider among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('aider');
  });
});
