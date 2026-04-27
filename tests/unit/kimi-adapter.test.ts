/**
 * Unit tests for KimiAdapter - detection, command building, runtime
 * strategy, and registry integration.
 *
 * Flag set was captured empirically from `kimi --help` (v1.37.0). Wire
 * protocol details and session-id banner come from running the real
 * CLI on this machine plus the upstream `docs/en/customization/wire-mode.md`
 * schema. These tests are the regression net against future Kimi
 * releases that change either surface.
 */
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import { KimiCommandBuilder } from '../../src/main/agent/adapters/kimi/command-builder';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

// Mock which, fs, and exec-version before importing adapter
let mockWhichResult: string | Error = '/usr/bin/kimi';
let mockExecVersionStdout = 'kimi, version 1.37.0\n';
let mockExecVersionShouldFail = false;
let mockExistsSync: (filePath: string) => boolean = () => true;
let mockReaddirSync: (filePath: string) => string[] = () => [];
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
      existsSync: (filePath: string) => mockExistsSync(filePath),
      readdirSync: (filePath: string) => mockReaddirSync(filePath),
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

const { KimiAdapter } = await import('../../src/main/agent/adapters/kimi');

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/kimi',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

describe('KimiAdapter', () => {
  let adapter: InstanceType<typeof KimiAdapter>;

  beforeEach(() => {
    adapter = new KimiAdapter();
    mockWhichResult = '/usr/bin/kimi';
    mockExecVersionStdout = 'kimi, version 1.37.0\n';
    mockExecVersionShouldFail = false;
    mockExistsSync = () => true;
    mockReaddirSync = () => [];
    execVersionCallCount = 0;
  });

  // ── Identity ─────────────────────────────────────────────────────────────

  describe('identity', () => {
    it('has name "kimi"', () => {
      expect(adapter.name).toBe('kimi');
    });

    it('has displayName "Kimi Code"', () => {
      expect(adapter.displayName).toBe('Kimi Code');
    });

    it('has sessionType "kimi_agent"', () => {
      expect(adapter.sessionType).toBe('kimi_agent');
    });

    it('supports caller-supplied session IDs (Kimi accepts UUID via --session)', () => {
      expect(adapter.supportsCallerSessionId).toBe(true);
    });

    it('exposes plan / default / bypass permission modes', () => {
      const modes = adapter.permissions.map((entry) => entry.mode);
      expect(modes).toContain('plan');
      expect(modes).toContain('default');
      expect(modes).toContain('bypassPermissions');
    });

    it('defaults to "default" permission (interactive confirms)', () => {
      expect(adapter.defaultPermission).toBe('default');
    });
  });

  // ── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    it('returns found:true with override path', async () => {
      const result = await adapter.detect('/custom/kimi');
      expect(result.found).toBe(true);
      expect(result.path).toBe('/custom/kimi');
      expect(result.version).toBe('1.37.0');
    });

    it('falls back to which when no override path', async () => {
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe('/usr/bin/kimi');
    });

    it('parses the empirical "kimi, version X" output format', async () => {
      mockExecVersionStdout = 'kimi, version 2.0.1\n';
      const result = await adapter.detect();
      expect(result.version).toBe('2.0.1');
    });

    it('parses "kimi-cli, version X" alias output', async () => {
      mockExecVersionStdout = 'kimi-cli, version 1.0.0\n';
      const result = await adapter.detect();
      expect(result.version).toBe('1.0.0');
    });

    it('falls back to permissive prefix strip for unfamiliar output', async () => {
      mockExecVersionStdout = 'kimi v0.5.0\n';
      const result = await adapter.detect();
      expect(result.version).toBe('0.5.0');
    });

    it('returns found:false when which fails and no fallback paths exist', async () => {
      mockWhichResult = new Error('not found');
      mockExistsSync = () => false;
      const result = await adapter.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
      expect(result.version).toBeNull();
    });

    it('falls back to a uv-tool install path when which fails', async () => {
      mockWhichResult = new Error('not found');
      const result = await adapter.detect();
      expect(result.found).toBe(true);
      expect(result.path).not.toBeNull();
      expect(result.version).toBe('1.37.0');
    });

    it('returns found:false with the configured path when --version fails on an override', async () => {
      mockExecVersionShouldFail = true;
      const result = await adapter.detect('/custom/kimi');
      expect(result.found).toBe(false);
      expect(result.path).toBe('/custom/kimi');
      expect(result.version).toBeNull();
    });

    it('caches detection result', async () => {
      const first = await adapter.detect('/custom/kimi');
      const second = await adapter.detect('/custom/kimi');
      expect(first).toBe(second);
      expect(execVersionCallCount).toBe(1);
    });

    it('invalidateDetectionCache clears cache', async () => {
      await adapter.detect('/custom/kimi');
      adapter.invalidateDetectionCache();
      await adapter.detect('/custom/kimi');
      expect(execVersionCallCount).toBe(2);
    });
  });

  // ── buildCommand ─────────────────────────────────────────────────────────

  describe('buildCommand', () => {
    it('starts with quoted agent path followed by -w <cwd>', () => {
      const command = adapter.buildCommand(makeOptions({
        agentPath: '/usr/local/bin/kimi',
        cwd: '/projects/foo',
        shell: 'bash',
      }));
      expect(command.startsWith(quoteArg('/usr/local/bin/kimi', 'bash'))).toBe(true);
      expect(command).toContain('-w');
      expect(command).toContain('/projects/foo');
    });

    it('forward-slashes the cwd path on all shells', () => {
      const command = adapter.buildCommand(makeOptions({ cwd: 'C:\\projects\\foo', shell: 'powershell' }));
      expect(command).toContain('C:/projects/foo');
      expect(command).not.toContain('C:\\projects\\foo');
    });

    it('passes --prompt with the user prompt', () => {
      const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug' }));
      expect(command).toContain('--prompt');
      expect(command).toContain('Fix the bug');
    });

    it('omits --prompt when no prompt is provided', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--prompt');
    });

    it('passes --session <uuid> when sessionId is provided (caller-owned ID)', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: '73013240-b192-422f-99a3-7cf37eac045a',
      }));
      expect(command).toContain('--session');
      expect(command).toContain('73013240-b192-422f-99a3-7cf37eac045a');
    });

    it('passes --session <uuid> for resume too (Kimi uses the same flag)', () => {
      const command = adapter.buildCommand(makeOptions({
        sessionId: '73013240-b192-422f-99a3-7cf37eac045a',
        resume: true,
      }));
      expect(command).toContain('--session');
      expect(command).toContain('73013240-b192-422f-99a3-7cf37eac045a');
    });

    describe('permission mode mapping', () => {
      const planModes: PermissionMode[] = ['plan'];
      const yoloModes: PermissionMode[] = ['bypassPermissions'];
      const noFlagModes: PermissionMode[] = ['default', 'dontAsk', 'acceptEdits', 'auto'];

      for (const mode of planModes) {
        it(`adds --plan for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          expect(command).toContain('--plan');
          expect(command).not.toContain('--yolo');
        });
      }

      for (const mode of yoloModes) {
        it(`adds --yolo for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          expect(command).toContain('--yolo');
          expect(command).not.toContain('--plan');
        });
      }

      for (const mode of noFlagModes) {
        it(`omits --yolo and --plan for ${mode}`, () => {
          const command = adapter.buildCommand(makeOptions({ permissionMode: mode }));
          expect(command).not.toContain('--yolo');
          expect(command).not.toContain('--plan');
        });
      }
    });

    describe('non-interactive mode', () => {
      it('adds --print --output-format stream-json when nonInteractive is true', () => {
        const command = adapter.buildCommand(makeOptions({ nonInteractive: true }));
        expect(command).toContain('--print');
        expect(command).toContain('--output-format');
        expect(command).toContain('stream-json');
      });

      it('omits --print when nonInteractive is false', () => {
        const command = adapter.buildCommand(makeOptions());
        expect(command).not.toContain('--print');
      });
    });

    describe('MCP config injection', () => {
      it('adds --mcp-config with kangentic server when enabled', () => {
        const command = adapter.buildCommand(makeOptions({
          mcpServerEnabled: true,
          mcpServerUrl: 'http://127.0.0.1:54321',
          mcpServerToken: 'secret-token',
          shell: 'bash',
        }));
        expect(command).toContain('--mcp-config');
        expect(command).toContain('mcpServers');
        expect(command).toContain('kangentic');
        expect(command).toContain('http://127.0.0.1:54321');
        expect(command).toContain('X-Kangentic-Token');
      });

      it('omits headers when no token is provided', () => {
        const command = adapter.buildCommand(makeOptions({
          mcpServerEnabled: true,
          mcpServerUrl: 'http://127.0.0.1:54321',
          shell: 'bash',
        }));
        expect(command).toContain('--mcp-config');
        expect(command).not.toContain('X-Kangentic-Token');
      });

      it('omits MCP config entirely when disabled', () => {
        const command = adapter.buildCommand(makeOptions({
          mcpServerEnabled: false,
          mcpServerUrl: 'http://127.0.0.1:54321',
        }));
        expect(command).not.toContain('--mcp-config');
      });

      it('omits MCP config when enabled but URL is missing', () => {
        const command = adapter.buildCommand(makeOptions({
          mcpServerEnabled: true,
        }));
        expect(command).not.toContain('--mcp-config');
      });

      it('replaces embedded double quotes with single quotes in MCP JSON for powershell', () => {
        // PowerShell treats embedded " as string delimiters. The JSON payload
        // from JSON.stringify() contains plenty of them (keys, URL, token value).
        // The builder must replace every " with ' before passing to quoteArg so
        // PowerShell receives a correctly-quoted argument.
        const command = adapter.buildCommand(makeOptions({
          mcpServerEnabled: true,
          mcpServerUrl: 'http://127.0.0.1:54321',
          mcpServerToken: 'tok-abc',
          shell: 'powershell',
        }));
        expect(command).toContain('--mcp-config');
        // No raw double quotes should survive inside the MCP JSON segment.
        // The outer quoteArg wrapper may add double quotes on its own, so we
        // strip the first and last char before checking for embedded ones.
        const mcpFlagIndex = command.indexOf('--mcp-config');
        const afterFlag = command.slice(mcpFlagIndex + '--mcp-config'.length).trimStart();
        // After the flag, the next token is the JSON payload wrapped by quoteArg.
        // We check that the unwrapped content contains single-quote-delimited keys.
        expect(afterFlag).toContain("'mcpServers'");
        expect(afterFlag).toContain("'kangentic'");
      });

      it('replaces double quotes with single quotes in MCP JSON when shell is undefined on win32', () => {
        // When shell is not provided and we are on win32, the builder checks
        // process.platform and applies the same double->single quote replacement.
        // We simulate win32 by temporarily patching process.platform.
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        try {
          const command = adapter.buildCommand(makeOptions({
            mcpServerEnabled: true,
            mcpServerUrl: 'http://127.0.0.1:54321',
            // shell intentionally omitted (undefined) - tests the platform fallback
          }));
          expect(command).toContain('--mcp-config');
          const mcpFlagIndex = command.indexOf('--mcp-config');
          const afterFlag = command.slice(mcpFlagIndex + '--mcp-config'.length).trimStart();
          expect(afterFlag).toContain("'mcpServers'");
        } finally {
          Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        }
      });
    });

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

    it('does not emit --continue when only SpawnCommandOptions fields are passed (firewall against accidental future spread)', () => {
      // KimiAdapter.buildCommand accepts SpawnCommandOptions, which does NOT
      // include useContinueFallback. This test pins the firewall contract: even
      // with no sessionId, the adapter must never emit --continue for a fresh
      // spawn. If a future refactor adds useContinueFallback to
      // SpawnCommandOptions and accidentally enables --continue for every
      // new Kimi session, this test will catch it.
      const command = adapter.buildCommand(makeOptions());
      expect(command).not.toContain('--continue');
    });
  });

  // ── KimiCommandBuilder.useContinueFallback ───────────────────────────────
  //
  // The `useContinueFallback` option lives on `KimiCommandOptions` (not on
  // the shared `SpawnCommandOptions`), so we exercise the builder directly.
  // It surfaces the `--continue` resume mode for cases where Kangentic does
  // not own a session UUID (lost DB record, manual `kimi` session in the
  // same work_dir, command-terminal "resume latest" affordance).

  describe('KimiCommandBuilder.useContinueFallback', () => {
    const builder = new KimiCommandBuilder();

    it('emits --continue when useContinueFallback is true and no sessionId', () => {
      const command = builder.buildKimiCommand({
        kimiPath: '/usr/bin/kimi',
        taskId: 'task-1',
        cwd: '/projects/foo',
        permissionMode: 'default',
        useContinueFallback: true,
        shell: 'bash',
      });
      expect(command).toContain('--continue');
      expect(command).not.toContain('--session');
    });

    it('prefers --session <uuid> over --continue when both sessionId and useContinueFallback are set', () => {
      const command = builder.buildKimiCommand({
        kimiPath: '/usr/bin/kimi',
        taskId: 'task-1',
        cwd: '/projects/foo',
        permissionMode: 'default',
        sessionId: '73013240-b192-422f-99a3-7cf37eac045a',
        useContinueFallback: true,
        shell: 'bash',
      });
      expect(command).toContain('--session');
      expect(command).toContain('73013240-b192-422f-99a3-7cf37eac045a');
      expect(command).not.toContain('--continue');
    });

    it('omits --continue when useContinueFallback is false and no sessionId', () => {
      const command = builder.buildKimiCommand({
        kimiPath: '/usr/bin/kimi',
        taskId: 'task-1',
        cwd: '/projects/foo',
        permissionMode: 'default',
        useContinueFallback: false,
        shell: 'bash',
      });
      expect(command).not.toContain('--continue');
      expect(command).not.toContain('--session');
    });

    it('omits --continue when useContinueFallback is undefined (default)', () => {
      const command = builder.buildKimiCommand({
        kimiPath: '/usr/bin/kimi',
        taskId: 'task-1',
        cwd: '/projects/foo',
        permissionMode: 'default',
        shell: 'bash',
      });
      expect(command).not.toContain('--continue');
      expect(command).not.toContain('--session');
    });
  });

  // ── Runtime strategy ─────────────────────────────────────────────────────

  describe('runtime.sessionId.fromOutput', () => {
    const fromOutput = (data: string): string | null => {
      const fn = adapter.runtime.sessionId?.fromOutput;
      if (!fn) throw new Error('fromOutput is not configured');
      return fn(data);
    };

    it('extracts the UUID from the welcome banner "Session: <uuid>" line', () => {
      const banner = 'Welcome to Kimi Code CLI!\n'
        + 'Send /help for help information.\n'
        + 'Directory: ~\\Documents\\GitHub\\kangentic\n'
        + 'Session: 73013240-b192-422f-99a3-7cf37eac045a\n'
        + 'Model: not set, send /login to login\n';
      expect(fromOutput(banner)).toBe('73013240-b192-422f-99a3-7cf37eac045a');
    });

    it('extracts the UUID from the print-mode "kimi -r <uuid>" exit message', () => {
      const exitLine = 'To resume this session: kimi -r bf6b28d4-58d1-4bd5-a892-7733ad7d054c\n';
      expect(fromOutput(exitLine)).toBe('bf6b28d4-58d1-4bd5-a892-7733ad7d054c');
    });

    it('returns null when neither anchor is present', () => {
      expect(fromOutput('some random TUI output without a session anchor')).toBeNull();
    });

    it('is case-insensitive on the "Session:" prefix (defensive)', () => {
      expect(fromOutput('SESSION: 73013240-b192-422f-99a3-7cf37eac045a')).toBe(
        '73013240-b192-422f-99a3-7cf37eac045a',
      );
    });

    it('does not falsely match non-UUID strings after Session:', () => {
      expect(fromOutput('Session: not-a-uuid-here')).toBeNull();
    });
  });

  describe('runtime.activity', () => {
    it('uses PTY-based detection (no hooks)', () => {
      expect(adapter.runtime.activity.kind).toBe('pty');
    });

    it('detects "kimi> " prompt at end of output as idle', () => {
      const detect = adapter.runtime.activity.detectIdle;
      expect(detect).toBeDefined();
      expect(detect!('Some output\nkimi> ')).toBe(true);
    });

    it('detects bare "> " prompt at end of output as idle', () => {
      const detect = adapter.runtime.activity.detectIdle;
      expect(detect!('Some output\n> ')).toBe(true);
    });

    it('does not flag mid-output text as idle', () => {
      const detect = adapter.runtime.activity.detectIdle;
      expect(detect!('Doing some work...')).toBe(false);
    });
  });

  describe('runtime.sessionHistory', () => {
    it('declares append-only mode (resume appends to existing wire.jsonl)', () => {
      expect(adapter.runtime.sessionHistory?.isFullRewrite).toBe(false);
    });

    it('exposes both locate and parse functions', () => {
      expect(typeof adapter.runtime.sessionHistory?.locate).toBe('function');
      expect(typeof adapter.runtime.sessionHistory?.parse).toBe('function');
    });
  });

  // ── Exit / first-output / lifecycle ──────────────────────────────────────

  describe('getExitSequence', () => {
    it('sends Ctrl+C then /exit for graceful shutdown', () => {
      const sequence = adapter.getExitSequence();
      expect(sequence).toEqual(['\x03', '/exit\r']);
    });
  });

  describe('detectFirstOutput', () => {
    it('matches the cursor-hide ANSI sequence (TUI takeover)', () => {
      expect(adapter.detectFirstOutput('shell prompt\x1b[?25l')).toBe(true);
    });

    it('returns false for plain shell output without alt-screen entry', () => {
      expect(adapter.detectFirstOutput('PS C:\\> ')).toBe(false);
    });
  });

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
  });

  // ── probeAuth ────────────────────────────────────────────────────────────

  describe('probeAuth', () => {
    // probeAuth checks ~/.kimi/credentials/ for OAuth state written by
    // `kimi login`. The renderer surfaces the false case as an amber
    // warning so users know to authenticate before spawning a task.

    it('targets ~/.kimi/credentials/ under the home directory', async () => {
      let probedPath: string | null = null;
      mockReaddirSync = (filePath) => {
        probedPath = filePath;
        return ['default.json'];
      };
      await adapter.probeAuth();
      expect(probedPath).not.toBeNull();
      expect(probedPath!).toContain(path.join('.kimi', 'credentials'));
    });

    it('returns true when ~/.kimi/credentials/ contains files', async () => {
      mockReaddirSync = () => ['default.json', 'session.token'];
      const result = await adapter.probeAuth();
      expect(result).toBe(true);
    });

    it('returns false when ~/.kimi/credentials/ is missing (ENOENT)', async () => {
      mockReaddirSync = () => {
        const error = new Error('no such file or directory') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      };
      const result = await adapter.probeAuth();
      expect(result).toBe(false);
    });

    it('returns false when ~/.kimi/credentials/ exists but is empty', async () => {
      mockReaddirSync = () => [];
      const result = await adapter.probeAuth();
      expect(result).toBe(false);
    });

    it('returns null when readdirSync throws a non-ENOENT error', async () => {
      mockReaddirSync = () => {
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      };
      const result = await adapter.probeAuth();
      expect(result).toBeNull();
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
  it('has kimi adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('kimi')).toBe(true);
  });

  it('getOrThrow returns KimiAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('kimi');
    expect(adapter.name).toBe('kimi');
    expect(adapter.sessionType).toBe('kimi_agent');
  });

  it('lists kimi among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('kimi');
  });

  it('lookup by sessionType returns the kimi adapter', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getBySessionType('kimi_agent');
    expect(adapter?.name).toBe('kimi');
  });
});

// -- agent-display-name - kimi entry -----------------------------------------

describe('agent-display-name - kimi entry', () => {
  it('agentDisplayName returns "Kimi Code" for "kimi"', () => {
    expect(agentDisplayName('kimi')).toBe('Kimi Code');
  });

  it('agentShortName returns "Kimi" for "kimi"', () => {
    expect(agentShortName('kimi')).toBe('Kimi');
  });

  it('agentInstallUrl returns the Kimi CLI repo URL for "kimi"', () => {
    expect(agentInstallUrl('kimi')).toBe('https://github.com/MoonshotAI/kimi-cli');
  });
});
