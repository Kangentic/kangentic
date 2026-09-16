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
import { ActivityDetection, DEFAULT_CONFIG } from '../../src/shared/types';
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
      { mode: 'plan', label: 'Plan (Chat Only, No File Access)' },
      { mode: 'default', label: 'Default (Smart Approve)' },
      { mode: 'bypassPermissions', label: 'Auto (Skip All Approvals)' },
    ]);
  });

  it('offers no dropdown entry that grants more autonomy than its label promises', () => {
    // Goose has three reachable modes (chat / smart_approve / auto), so three
    // entries. Two entries resolving to one GOOSE_MODE is the regression this
    // guards: `acceptEdits` mapped to `auto` once made "Auto Edit (Approve
    // Edits)" behave exactly like "Auto (Skip All Approvals)", handing full
    // shell autonomy to whoever picked the edit-scoped-sounding option.
    const modesOffered = adapter.permissions.map(
      (entry) => adapter.buildEnv(makeOptions({ permissionMode: entry.mode }))?.GOOSE_MODE,
    );
    expect(new Set(modesOffered).size).toBe(adapter.permissions.length);
    expect(adapter.permissions.map((entry) => entry.mode)).not.toContain('acceptEdits');
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

    it.each([
      ['pressly/goose, the Go migration tool', 'goose version: v3.24.1'],
      ['the awesome-goose scaffolding framework', 'goose version 0.0.0'],
    ])('rejects %s, which publishes the same `goose` binary name', async (_label, banner) => {
      // THE BINARY-NAME COLLISION, and the reason parseVersion is anchored.
      // Both of these install a binary called `goose` and print a
      // MAJOR.MINOR.PATCH run, so a scan-anywhere /\d+\.\d+\.\d+/ accepts them
      // and Kangentic then spawns `goose run -t "<prompt>" -s` against a tool
      // with no such command. Both put the literal word `version` where Block's
      // clap banner puts the digits, which is what the anchor keys off - the
      // same discriminator GrokDetector uses for the shared `agent` shim.
      mockVersionResult = banner;
      const result = await adapter.detect('/custom/goose');
      expect(result.found).toBe(false);
      expect(result.version).toBeNull();
    });

    it('accepts the Block Goose banner in every form its packaging plausibly prints', async () => {
      // Goose's published docs show the `--version` COMMAND and never its
      // stdout, so the accept side is deliberately wider than one pinned
      // string: a false negative here surfaces as a diagnosable "not found"
      // with the raw line logged, while a false positive spawns the wrong
      // binary. All of these still carry a digit right after the product name,
      // so none of them weakens the rejection above.
      for (const banner of [
        'goose 1.10.0',
        'goose v1.10.0',
        'goose-cli 1.10.0',
        'goose 1.10.0 (3cd0d0cbce)',
        'goose 1.10.0-rc.1',
        'GOOSE 2.0.0',
      ]) {
        adapter.invalidateDetectionCache();
        mockVersionResult = banner;
        const result = await adapter.detect('/custom/goose');
        expect(result.found, `banner ${banner} should be accepted`).toBe(true);
        expect(result.version, `banner ${banner}`).toMatch(/^\d/);
      }
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

    it('drops -s for a nonInteractive spawn so the run exits instead of parking', () => {
      // `nonInteractive` is a real spawn_agent action config key
      // (ActionConfig.nonInteractive -> transition-engine -> SpawnCommandOptions).
      // `goose run -t <prompt>` without -s is already the headless one-shot
      // form, so honouring the flag costs nothing; ignoring it left a
      // fire-and-forget automation sitting in an interactive session forever.
      const command = adapter.buildCommand(makeOptions({
        prompt: 'Fix the bug',
        nonInteractive: true,
        shell: 'bash',
      }));
      expect(command).toContain('-t');
      expect(command.split(' ')).not.toContain('-s');
    });

    it('keeps -s when nonInteractive is not set', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug', shell: 'bash' }));
      expect(command.split(' ')).toContain('-s');
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

      it('preserves newlines in a multi-line prompt for a unix-like shell', () => {
        // buildCommand passes { multiline: true } to quoteArg for -t so a
        // multi-line task envelope survives shell delivery intact. Without
        // that option, quoteArg falls through to sanitizeForPty, which
        // collapses \n to a space - this is the regression the option
        // guards against (see quoteArg's docstring in src/shared/paths.ts).
        // This adapter is not covered by the cross-adapter
        // tests/unit/adapter-multiline-prompt.test.ts guard, so it is
        // pinned here instead.
        const command = adapter.buildCommand(makeOptions({
          prompt: 'Fix the bug\nAdd a regression test',
          shell: 'bash',
        }));
        expect(command).toContain('Fix the bug\nAdd a regression test');
      });
    });
  });

  // -- buildEnv (permission mode -> GOOSE_MODE) -------------------------------

  describe('buildEnv', () => {
    const expected: Record<PermissionMode, string> = {
      plan: 'chat',
      dontAsk: 'chat',
      default: 'smart_approve',
      acceptEdits: 'smart_approve',
      auto: 'auto',
      bypassPermissions: 'auto',
    };

    for (const mode of Object.keys(expected) as PermissionMode[]) {
      it(`maps ${mode} to GOOSE_MODE=${expected[mode]}`, () => {
        const env = adapter.buildEnv(makeOptions({ permissionMode: mode }));
        expect(env).toEqual({ GOOSE_MODE: expected[mode] });
      });
    }

    it('does not hand the SHIPPED DEFAULT permission mode a fully unattended Goose', () => {
      // `DEFAULT_CONFIG.agent.permissionMode` is 'acceptEdits' and
      // `resolveEffectivePermissionMode` falls through task -> lane -> that
      // global without consulting `adapter.permissions`. So whatever
      // 'acceptEdits' maps to IS the out-of-the-box spawn for every Goose
      // session on a fresh install. `auto` there means no approval on shell
      // commands, chosen by nobody. Goose has no edits-auto/commands-ask mode,
      // so it must resolve DOWN, never up.
      expect(DEFAULT_CONFIG.agent.permissionMode).toBe('acceptEdits');
      const shippedDefaultEnv = adapter.buildEnv(
        makeOptions({ permissionMode: DEFAULT_CONFIG.agent.permissionMode }),
      );
      expect(shippedDefaultEnv).not.toEqual({ GOOSE_MODE: 'auto' });
      expect(shippedDefaultEnv).toEqual({ GOOSE_MODE: 'smart_approve' });
    });

    it('degrades to the adapter default rather than emitting GOOSE_MODE=undefined', () => {
      // `permission_mode` is an unconstrained TEXT column read back through a
      // bare cast, so the PermissionMode union is a compile-time claim only. A
      // legacy or hand-edited row reaching buildEnv must not produce
      // `{ GOOSE_MODE: undefined }`, which the PTY env turns into the literal
      // "undefined" and Goose then ignores in favour of its own default.
      const env = adapter.buildEnv(makeOptions({
        permissionMode: 'someRetiredMode' as PermissionMode,
      }));
      expect(env).toEqual({ GOOSE_MODE: 'smart_approve' });
    });
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

  it('exit sequence interrupts, then exits explicitly', () => {
    // Ctrl+C alone is not enough. Goose's Ctrl+C exits only when the input
    // line is already empty; mid-turn it just interrupts the request. A kill
    // usually lands mid-turn (a card moving to Done while the agent works),
    // so a lone '\x03' leaves the session alive until the teardown grace
    // expires and the PTY is force-killed. '/exit\r' is what actually ends it,
    // matching Ollama's REPL exit sequence.
    expect(adapter.getExitSequence()).toEqual(['\x03', '/exit\r']);
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
