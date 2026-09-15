/**
 * Unit tests for GooseAdapter - detection, command building, permission-mode
 * to GOOSE_MODE mapping, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC
 * dependencies. Goose detection goes through the shared AgentDetector, so we
 * mock `which`, `node:fs`, and the shared `execVersion` probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';
import { ActivityDetection } from '../../src/shared/types';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

// The paths the mocked filesystem reports as installed. Fallback install
// locations (Homebrew, nvm, etc.) are deliberately NOT in this set so the
// "not found" path is reachable when `which` fails.
const installedPaths = new Set<string>(['/usr/bin/goose', '/custom/goose']);
let mockWhichResult: string | Error = '/usr/bin/goose';
let mockVersionResult: string | null = 'goose 1.10.0';
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
      existsSync: (candidatePath: string) => installedPaths.has(candidatePath),
    },
    existsSync: (candidatePath: string) => installedPaths.has(candidatePath),
  };
});

// Mock the shared --version probe so no real process is spawned. An empty
// result models a binary that produced no recognizable version.
vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: async () => {
    execCallCount++;
    return { stdout: mockVersionResult ?? '', stderr: '' };
  },
}));

// Import after mocks are set up.
const { GooseAdapter } = await import('../../src/main/agent/adapters/goose');

// -- Helpers ------------------------------------------------------------------

/** Build minimal SpawnCommandOptions with sensible defaults. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/goose',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

// -- GooseAdapter -------------------------------------------------------------

describe('GooseAdapter', () => {
  let adapter: InstanceType<typeof GooseAdapter>;

  beforeEach(() => {
    adapter = new GooseAdapter();
    mockWhichResult = '/usr/bin/goose';
    mockVersionResult = 'goose 1.10.0';
    execCallCount = 0;
  });

  // -- Identity ---------------------------------------------------------------

  it('has name "goose"', () => {
    expect(adapter.name).toBe('goose');
  });

  it('has displayName "Goose CLI"', () => {
    expect(adapter.displayName).toBe('Goose CLI');
  });

  it('has sessionType "goose_agent"', () => {
    expect(adapter.sessionType).toBe('goose_agent');
  });

  it('supports caller session IDs (resume via --name)', () => {
    expect(adapter.supportsCallerSessionId).toBe(true);
  });

  it('has default permission mode "default"', () => {
    expect(adapter.defaultPermission).toBe('default');
  });

  it('declares the exact permission dropdown entries (KEEP IN SYNC with tests/ui/mock-electron-api.js)', () => {
    expect(adapter.permissions).toEqual([
      { mode: 'plan', label: 'Plan (Chat Only, Read-Only)' },
      { mode: 'default', label: 'Default (Smart Approve)' },
      { mode: 'acceptEdits', label: 'Auto Edit (Approve Edits)' },
      { mode: 'bypassPermissions', label: 'Auto (Skip All Approvals)' },
    ]);
  });

  it('uses PTY-only activity detection at runtime (no hooks)', () => {
    expect(adapter.runtime.activity).toEqual(ActivityDetection.pty());
  });

  // -- Detection --------------------------------------------------------------

  describe('detect', () => {
    it('returns found: true and the parsed semver with an override path', async () => {
      const result = await adapter.detect('/custom/goose');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/goose');
      // parseVersion extracts the MAJOR.MINOR.PATCH run from `goose 1.10.0`.
      expect(result.version).toBe('1.10.0');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/goose');
      expect(result.version).toBe('1.10.0');
    });

    it('returns found: false when which fails and no fallback exists', async () => {
      mockWhichResult = new Error('not found');
      const result = await adapter.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('returns found: false with the configured path when --version produces nothing', async () => {
      mockVersionResult = null;
      const result = await adapter.detect('/custom/goose');
      expect(result.found).toBe(false);
      expect(result.path).toBe('/custom/goose');
      expect(result.version).toBeNull();
    });

    it('extracts the version from anywhere in the wrapper text, not just a fixed prefix', async () => {
      // parseVersion scans for the first MAJOR.MINOR.PATCH run instead of
      // stripping a fixed "goose " prefix, because wrapper text varies
      // between builds/packaging (detector.ts docstring). Every other test
      // in this file uses 'goose 1.10.0', where a naive prefix-strip would
      // coincidentally produce the same result - this fixture puts the
      // version after other text so only the scan-anywhere regex passes.
      mockVersionResult = 'Goose CLI version 1.10.0 (build 42)';
      const result = await adapter.detect('/custom/goose');
      expect(result.found).toBe(true);
      expect(result.version).toBe('1.10.0');
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/goose');
      const second = await adapter.detect('/custom/goose');

      expect(first).toBe(second); // Same object reference (cached)
      expect(execCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/goose');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/goose');

      expect(execCallCount).toBe(2);
    });
  });

  // -- buildCommand -----------------------------------------------------------

  describe('buildCommand', () => {
    it('uses `goose run ... -s` when a prompt is provided', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug', shell: 'bash' }));
      const quoted = quoteArg('/usr/bin/goose', 'bash');
      expect(command.startsWith(`${quoted} run`)).toBe(true);
      expect(command).toContain('-t');
      expect(command).toContain('Fix the bug');
      expect(command).toContain('-s');
    });

    it('uses a bare `goose session` when no prompt is provided', () => {
      const command = adapter.buildCommand(makeOptions({ shell: 'bash' }));
      const quoted = quoteArg('/usr/bin/goose', 'bash');
      expect(command).toBe(`${quoted} session`);
      expect(command).not.toContain('-t');
      expect(command).not.toContain('-s');
    });

    it('passes the session id as --name on a fresh spawn (no -r)', () => {
      const command = adapter.buildCommand(makeOptions({
        prompt: 'Fix the bug',
        sessionId: 'abc-123',
      }));
      expect(command).toContain('-n');
      expect(command).toContain('abc-123');
      expect(command).not.toContain('-r');
    });

    it('adds -r to resume by --name', () => {
      const command = adapter.buildCommand(makeOptions({
        prompt: 'Keep going',
        sessionId: 'abc-123',
        resume: true,
      }));
      expect(command).toContain('-r');
      expect(command).toContain('-n');
      expect(command).toContain('abc-123');
    });

    it('resumes a promptless session with `goose session -r -n <id>`', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: 'abc-123',
        resume: true,
        shell: 'bash',
      }));
      const quoted = quoteArg('/usr/bin/goose', 'bash');
      expect(command).toBe(`${quoted} session -r -n abc-123`);
    });

    it('omits --name when no session id is present', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug' }));
      expect(command).not.toContain('-n');
    });

    it('does not add -r when resuming without a session id', () => {
      const command = adapter.buildCommand(makeOptions({ resume: true }));
      expect(command).not.toContain('-r');
    });

    it('starts with the quoted agent path', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: '/usr/local/bin/goose',
        shell: 'bash',
      }));
      expect(command.startsWith(quoteArg('/usr/local/bin/goose', 'bash'))).toBe(true);
    });

    // -- Shell quoting --------------------------------------------------------

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
  });

  // -- buildEnv (permission mode -> GOOSE_MODE) -------------------------------

  describe('buildEnv', () => {
    const expected: Record<PermissionMode, string> = {
      plan: 'chat',
      dontAsk: 'chat',
      default: 'smart_approve',
      acceptEdits: 'auto',
      auto: 'auto',
      bypassPermissions: 'auto',
    };

    for (const mode of Object.keys(expected) as PermissionMode[]) {
      it(`maps ${mode} to GOOSE_MODE=${expected[mode]}`, () => {
        const env = adapter.buildEnv(makeOptions({ permissionMode: mode }));
        expect(env).toEqual({ GOOSE_MODE: expected[mode] });
      });
    }
  });

  // -- No-op methods ----------------------------------------------------------

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

    it('getSubmissionVerifier returns null', () => {
      expect(adapter.getSubmissionVerifier('paste')).toBeNull();
    });

    it('locateSessionHistoryFile returns null', async () => {
      const result = await adapter.locateSessionHistoryFile('session-1', '/some/dir');
      expect(result).toBeNull();
    });
  });

  // -- detectFirstOutput ------------------------------------------------------

  describe('detectFirstOutput', () => {
    it('returns true for any non-empty data', () => {
      expect(adapter.detectFirstOutput('Hello')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(adapter.detectFirstOutput('')).toBe(false);
    });
  });

  // -- getExitSequence --------------------------------------------------------

  it('exit sequence is Ctrl+C', () => {
    expect(adapter.getExitSequence()).toEqual(['\x03']);
  });

  // -- interpolateTemplate ----------------------------------------------------

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

// -- Registry integration -----------------------------------------------------

describe('Agent Registry', () => {
  it('has goose adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('goose')).toBe(true);
  });

  it('getOrThrow returns GooseAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('goose');
    expect(adapter.name).toBe('goose');
    expect(adapter.sessionType).toBe('goose_agent');
  });

  it('lists goose among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('goose');
  });

  it('getBySessionType finds goose adapter', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getBySessionType('goose_agent');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('goose');
  });
});

// -- agent-display-name - goose entry -----------------------------------------

describe('agent-display-name - goose entry', () => {
  it('agentDisplayName returns "Goose CLI" for "goose"', () => {
    expect(agentDisplayName('goose')).toBe('Goose CLI');
  });

  it('agentShortName returns "Goose" for "goose"', () => {
    expect(agentShortName('goose')).toBe('Goose');
  });

  it('agentInstallUrl returns the Goose repo URL for "goose"', () => {
    expect(agentInstallUrl('goose')).toBe('https://github.com/block/goose');
  });
});
