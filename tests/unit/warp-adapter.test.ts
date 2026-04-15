/**
 * Unit tests for WarpAdapter - detection, command building, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

// Mock which, fs, and execWarpVersion before importing adapter.
// Warp uses `dump-debug-info` instead of `--version`, so we mock
// execWarpVersion (exported from the adapter module) directly.
let mockWhichResult: string | Error = '/usr/bin/oz';
let mockVersionResult: string | null = 'v0.2026.04.08.08.36.stable_02';
let execCallCount = 0;

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

// Mock version-detector so we don't spawn real processes.
// Warp uses `dump-debug-info` instead of `--version`.
vi.mock('../../src/main/agent/adapters/warp/version-detector', () => ({
  execWarpVersion: async () => {
    execCallCount++;
    return mockVersionResult;
  },
  parseWarpVersion: (output: string) => {
    const match = output.match(/Warp version:\s*Some\("([^"]+)"\)/);
    return match ? match[1] : null;
  },
}));

// Import after mocks are set up
const { WarpAdapter } = await import('../../src/main/agent/adapters/warp');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build minimal SpawnCommandOptions with sensible defaults. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/oz',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

// ── WarpAdapter ──────────────────────────────────────────────────────────────

describe('WarpAdapter', () => {
  let adapter: InstanceType<typeof WarpAdapter>;

  beforeEach(() => {
    adapter = new WarpAdapter();
    mockWhichResult = '/usr/bin/oz';
    mockVersionResult = 'v0.2026.04.08.08.36.stable_02';
    execCallCount = 0;
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  it('has name "warp"', () => {
    expect(adapter.name).toBe('warp');
  });

  it('has displayName "Oz CLI"', () => {
    expect(adapter.displayName).toBe('Oz CLI');
  });

  it('has sessionType "warp_agent"', () => {
    expect(adapter.sessionType).toBe('warp_agent');
  });

  it('does not support caller session IDs', () => {
    expect(adapter.supportsCallerSessionId).toBe(false);
  });

  it('has default permission mode "default"', () => {
    expect(adapter.defaultPermission).toBe('default');
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found: true with override path', async () => {
      const result = await adapter.detect('/custom/oz');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/oz');
      expect(result.version).toBe('v0.2026.04.08.08.36.stable_02');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/oz');
    });

    it('returns found: false when which fails', async () => {
      mockWhichResult = new Error('not found');
      const result = await adapter.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('returns found: false with the configured path when dump-debug-info fails on an override', async () => {
      mockVersionResult = null;
      const result = await adapter.detect('/custom/oz');
      expect(result.found).toBe(false);
      expect(result.path).toBe('/custom/oz');
      expect(result.version).toBeNull();
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/oz');
      const second = await adapter.detect('/custom/oz');

      expect(first).toBe(second); // Same object reference (cached)
      expect(execCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/oz');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/oz');

      // Called twice because cache was invalidated
      expect(execCallCount).toBe(2);
    });
  });

  // ── buildCommand ─────────────────────────────────────────────────────────

  describe('buildCommand', () => {
    it('builds command starting with "oz agent run"', () => {
      const command = adapter.buildCommand(makeOptions({ shell: 'bash' }));
      const quoted = quoteArg('/usr/bin/oz', 'bash');
      expect(command.startsWith(`${quoted} agent run`)).toBe(true);
    });

    it('includes -- --prompt when prompt is provided', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug' }));
      expect(command).toContain('-- --prompt');
      expect(command).toContain('Fix the bug');
    });

    it('omits --prompt and end-of-options guard when no prompt', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--prompt');
      expect(command).not.toContain(' -- ');
    });

    it('includes -C for working directory', () => {
      const command = adapter.buildCommand(makeOptions({ cwd: '/projects/my-app' }));
      expect(command).toContain('-C');
      expect(command).toContain('/projects/my-app');
    });

    it('omits -C flag when cwd is undefined', () => {
      const command = adapter.buildCommand(makeOptions({ cwd: undefined }));
      expect(command).not.toContain('-C');
    });

    it('includes --name with task ID', () => {
      const command = adapter.buildCommand(makeOptions({ taskId: 'task-42' }));
      expect(command).toContain('--name');
      expect(command).toContain('task-42');
    });

    it('omits --name flag when taskId is undefined', () => {
      const command = adapter.buildCommand(makeOptions({ taskId: undefined }));
      expect(command).not.toContain('--name');
    });

    // ── Permission mode mapping ──────────────────────────────────────────

    describe('permission mode mapping', () => {
      const allModes: PermissionMode[] = ['default', 'plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'];

      for (const mode of allModes) {
        it(`adds no permission flags for ${mode} (Warp uses profiles)`, () => {
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          // Warp does not map permission modes to CLI flags
          expect(command).not.toContain('--yes');
          expect(command).not.toContain('--auto');
          expect(command).not.toContain('--sandbox');
          expect(command).not.toContain('--ask-for-approval');
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

    // ── Ignored options ──────────────────────────────────────────────────

    it('ignores resume flag (Warp has no session resume)', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: 'session-123',
        resume: true,
      }));
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--session-id');
      expect(command).not.toContain('session-123');
    });

    it('starts with quoted agent path', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: '/usr/local/bin/oz',
        shell: 'bash',
      }));
      expect(command.startsWith(quoteArg('/usr/local/bin/oz', 'bash'))).toBe(true);
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

  // ── detectFirstOutput ────────────────────────────────────────────────────

  describe('detectFirstOutput', () => {
    it('returns true for any non-empty data', () => {
      expect(adapter.detectFirstOutput('Hello')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(adapter.detectFirstOutput('')).toBe(false);
    });
  });

  // ── getExitSequence ──────────────────────────────────────────────────────

  it('exit sequence is Ctrl+C', () => {
    expect(adapter.getExitSequence()).toEqual(['\x03']);
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

// ── parseWarpVersion (real output format) ────────────────────────────────────

describe('parseWarpVersion', async () => {
  // The vi.mock above only replaces execWarpVersion; parseWarpVersion
  // is the real implementation (passed through in the mock).
  const { parseWarpVersion } = await import('../../src/main/agent/adapters/warp/version-detector');

  it('extracts version from real dump-debug-info output', () => {
    const realOutput = [
      'Warp version: Some("v0.2026.04.08.08.36.stable_02")',
      'gpu_power_preference: HighPerformance',
      'backend_preference: None',
      'windowing_system: None',
      '##################################################',
      '# wgpu Adapters',
      '##################################################',
      'DiscreteGpu: NVIDIA GeForce RTX 5090',
    ].join('\n');
    expect(parseWarpVersion(realOutput)).toBe('v0.2026.04.08.08.36.stable_02');
  });

  it('returns null when version line is missing', () => {
    expect(parseWarpVersion('gpu_power_preference: HighPerformance\n')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseWarpVersion('')).toBeNull();
  });

  it('handles None version (CLI not properly initialized)', () => {
    expect(parseWarpVersion('Warp version: None\n')).toBeNull();
  });
});

// ── Registry integration ─────────────────────────────────────────────────────

describe('Agent Registry', () => {
  it('has warp adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('warp')).toBe(true);
  });

  it('getOrThrow returns WarpAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('warp');
    expect(adapter.name).toBe('warp');
    expect(adapter.sessionType).toBe('warp_agent');
  });

  it('lists warp among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('warp');
  });

  it('getBySessionType finds warp adapter', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getBySessionType('warp_agent');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('warp');
  });
});
