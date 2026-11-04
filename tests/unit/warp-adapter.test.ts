/**
 * Unit tests for WarpAdapter - detection, command building, and registry integration.
 *
 * These tests exercise pure logic without any Electron, DOM, or IPC dependencies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { quoteArg } from '../../src/shared/paths';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';
import type { VersionLaunch } from '../../src/main/agent/shared/exec-version';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

// Mock which, fs, and the shared version probe before importing the adapter.
// Warp's detector is the shared one with `dump-debug-info` as its version
// command, so the probe answers with that command's output.
let mockWhichResult: string | Error = '/usr/bin/oz';
let mockVersionResult: string | null = 'v0.2026.04.08.08.36.stable_02';
let execCallCount = 0;
let lastVersionArgs: readonly string[] | undefined;
let lastVersionLaunch: VersionLaunch | null | undefined;

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

// The shared version probe, so no real process is spawned. A null version is
// output with no version line, which the parser rejects.
vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: async (_candidatePath: string, _timeout?: number, args?: readonly string[], launch?: VersionLaunch | null) => {
    execCallCount++;
    lastVersionArgs = args;
    lastVersionLaunch = launch;
    return {
      stdout: mockVersionResult === null ? 'gpu_power_preference: HighPerformance\n' : `Warp version: Some("${mockVersionResult}")\n`,
      stderr: '',
    };
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

    it('asks oz for its version with dump-debug-info, since it has no --version', async () => {
      await adapter.detect('/custom/oz');
      expect(lastVersionArgs).toEqual(['dump-debug-info']);
    });

    // Red-green: the old detector cached one result whatever path it was
    // asked about, so two projects with two oz installs shared the first one's.
    it('detects each configured path on its own', async () => {
      const first = await adapter.detect('/custom/oz');
      mockVersionResult = 'v0.2026.05.01.00.00.stable_01';
      const second = await adapter.detect('/other/oz');
      expect(first.path).toBe('/custom/oz');
      expect(second.path).toBe('/other/oz');
      expect(second.version).toBe('v0.2026.05.01.00.00.stable_01');
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

    it('starts an oz installed in a WSL distro by its Linux path, with -C as the distro sees the folder', () => {
      const command = adapter.buildCommand(makeOptions({
        shell: 'wsl -d Ubuntu',
        agentPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\oz',
        cwd: 'C:\\Users\\dev\\repo',
        cliTarget: {
          kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/oz',
          facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' },
        },
      }));
      expect(command.startsWith('/home/dev/.local/bin/oz agent run')).toBe(true);
      expect(command).toContain('-C /mnt/c/Users/dev/repo');
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

    describe('permission modes', () => {
      const allModes: PermissionMode[] = ['default', 'plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'];

      // Warp keeps autonomy in agent profiles, so no mode may change the
      // command; a mode that did would be a Kangentic layer over the profile.
      it('builds the same command for every mode (Warp uses profiles)', () => {
        const baseline = adapter.buildCommand(makeOptions({ permissionMode: 'default', prompt: 'Fix the bug' }));
        for (const mode of allModes) {
          expect(adapter.buildCommand(makeOptions({ permissionMode: mode, prompt: 'Fix the bug' }))).toBe(baseline);
        }
      });

      // Red-green: Oz used to offer "Plan Only (Read-Only)" and "Auto" entries
      // that mapped to no flag, so a plan column ran with full permissions.
      it('offers only the default entry its Warp profile decides', () => {
        expect(adapter.permissions.map((entry) => entry.mode)).toEqual(['default']);
      });
    });

    // ── Model ────────────────────────────────────────────────────────────

    describe('model', () => {
      it('passes --model before the end-of-options guard', () => {
        const command = adapter.buildCommand(makeOptions({ model: 'model-id-1', prompt: 'Fix the bug', shell: 'bash' }));
        expect(command).toContain('--model model-id-1');
        expect(command.indexOf('--model')).toBeLessThan(command.indexOf('-- --prompt'));
      });

      it('omits --model when no model is set or it is blank', () => {
        expect(adapter.buildCommand(makeOptions())).not.toContain('--model');
        expect(adapter.buildCommand(makeOptions({ model: '   ' }))).not.toContain('--model');
      });

      it('declares the model override without asking the CLI for a list', async () => {
        await expect(adapter.discoverCapabilities('/usr/bin/oz')).resolves.toEqual({ supportsModelOverride: true });
      });

      const distroTarget: NonNullable<SpawnCommandOptions['cliTarget']> = {
        kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/oz',
        facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' },
      };

      /** Every shell family the adapter quotes for, each with the options it needs. */
      const shellCases: Array<{ shell: string; extra: Partial<SpawnCommandOptions> }> = [
        { shell: 'bash', extra: {} },
        { shell: 'powershell', extra: {} },
        { shell: 'cmd', extra: {} },
        { shell: 'wsl -d Ubuntu', extra: { cliTarget: distroTarget } },
      ];

      it('seeds the configured model from the command it built, for bash, PowerShell, cmd and a WSL distro', () => {
        for (const { shell, extra } of shellCases) {
          const command = adapter.buildCommand(makeOptions({ model: 'model-id-1', prompt: 'Fix the bug', shell, ...extra }));
          expect(adapter.configuredModelFromCommand(command), shell).toEqual({ id: 'model-id-1', displayName: 'model-id-1' });
        }
      });

      it('reads no model from a prompt that mentions --model', () => {
        for (const { shell, extra } of shellCases) {
          const command = adapter.buildCommand(makeOptions({ prompt: 'Run it with --model other-id please', shell, ...extra }));
          expect(adapter.configuredModelFromCommand(command), shell).toBeNull();
        }
      });

      it('round-trips a model id that needs quoting', () => {
        for (const shell of ['bash', 'powershell', 'cmd']) {
          const command = adapter.buildCommand(makeOptions({ model: 'my model id', prompt: 'Fix the bug', shell }));
          expect(adapter.configuredModelFromCommand(command), shell).toEqual({ id: 'my model id', displayName: 'my model id' });
        }
      });

      // Red-green: the guard was once found by the first " -- " in the command,
      // so a quoted folder holding " -- " ended the flag region before --model.
      it('seeds the model when the working folder holds " -- "', () => {
        const cases = [
          { shell: 'bash', cwd: '/p/my -- app' },
          { shell: 'powershell', cwd: 'C:\\p\\my -- app' },
        ];
        for (const { shell, cwd } of cases) {
          const command = adapter.buildCommand(makeOptions({ cwd, model: 'model-id-1', prompt: 'Fix the bug', shell }));
          expect(adapter.configuredModelFromCommand(command), shell).toEqual({ id: 'model-id-1', displayName: 'model-id-1' });
        }
      });

      it('returns null for a command with no --model', () => {
        expect(adapter.configuredModelFromCommand(adapter.buildCommand(makeOptions({ shell: 'bash' })))).toBeNull();
      });
    });

    // ── Kangentic MCP server ─────────────────────────────────────────────

    describe('Kangentic MCP server', () => {
      const mcpUrl = 'http://127.0.0.1:65530/mcp/project-1/session-1';
      const mcpToken = 'token-for-test-4f1a';
      let sessionFolder: string;

      beforeEach(() => {
        sessionFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-warp-mcp-'));
      });

      afterEach(() => {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
      });

      function mcpOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
        return makeOptions({
          shell: 'bash',
          prompt: 'Fix the bug',
          statusOutputPath: path.join(sessionFolder, 'status.json'),
          eventsOutputPath: path.join(sessionFolder, 'events.jsonl'),
          mcpServerEnabled: true,
          mcpServerUrl: mcpUrl,
          mcpServerToken: mcpToken,
          ...overrides,
        });
      }

      function readMcpConfig(): Record<string, Record<string, unknown>> {
        return JSON.parse(fs.readFileSync(path.join(sessionFolder, 'mcp.json'), 'utf-8'));
      }

      it('writes the documented url + headers entry and names the file with --mcp before the guard', () => {
        const command = adapter.buildCommand(mcpOptions());
        expect(readMcpConfig()).toEqual({
          kangentic: { url: mcpUrl, headers: { 'X-Kangentic-Token': mcpToken } },
        });
        const configPath = path.join(sessionFolder, 'mcp.json');
        expect(command).toContain(`--mcp ${quoteArg(configPath, 'bash')}`);
        expect(command.indexOf('--mcp')).toBeLessThan(command.indexOf('-- --prompt'));
      });

      it('keeps the token and the URL off the command line', () => {
        const command = adapter.buildCommand(mcpOptions());
        expect(command).not.toContain(mcpToken);
        expect(command).not.toContain(mcpUrl);
      });

      it('writes nothing and passes no --mcp when the server is off or has no URL', () => {
        for (const overrides of [{ mcpServerEnabled: false }, { mcpServerUrl: undefined }, { mcpServerToken: undefined }]) {
          const command = adapter.buildCommand(mcpOptions(overrides));
          expect(command).not.toContain('--mcp');
          // readdirSync, not existsSync: this file mocks existsSync to true.
          expect(fs.readdirSync(sessionFolder)).toEqual([]);
        }
      });

      it('passes no --mcp when the build has no session directory', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const command = adapter.buildCommand(mcpOptions({ statusOutputPath: undefined, eventsOutputPath: undefined }));
          expect(command).not.toContain('--mcp');
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(String(warnSpy.mock.calls[0][0])).toContain('[warp]');
        } finally {
          warnSpy.mockRestore();
        }
      });

      // Red-green for the mkdirSync: without it the write throws ENOENT.
      it('creates a session directory that does not exist yet and writes mcp.json there', () => {
        const nestedFolder = path.join(sessionFolder, 'nested', 'session-folder');
        const command = adapter.buildCommand(mcpOptions({
          statusOutputPath: path.join(nestedFolder, 'status.json'),
          eventsOutputPath: undefined,
        }));
        const configPath = path.join(nestedFolder, 'mcp.json');
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
          kangentic: { url: mcpUrl, headers: { 'X-Kangentic-Token': mcpToken } },
        });
        expect(command).toContain(`--mcp ${quoteArg(configPath, 'bash')}`);
      });

      // Red-green for the `?? options.eventsOutputPath` fallback: with only the
      // events file known, mcp.json still lands beside it.
      it('writes mcp.json beside the events file when no status file path is set', () => {
        const command = adapter.buildCommand(mcpOptions({ statusOutputPath: undefined }));
        expect(readMcpConfig()).toEqual({
          kangentic: { url: mcpUrl, headers: { 'X-Kangentic-Token': mcpToken } },
        });
        expect(command).toContain(`--mcp ${quoteArg(path.join(sessionFolder, 'mcp.json'), 'bash')}`);
      });

      const wslTarget = (networkingMode: 'nat' | 'mirrored'): NonNullable<SpawnCommandOptions['cliTarget']> => ({
        kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/oz',
        facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode },
      });

      it('hands an oz in a WSL distro on NAT networking the bridge as a stdio server, token in its env', () => {
        const command = adapter.buildCommand(mcpOptions({ shell: 'wsl -d Ubuntu', cliTarget: wslTarget('nat') }));
        const entry = readMcpConfig().kangentic;
        expect(entry.url).toBeUndefined();
        expect(typeof entry.command).toBe('string');
        expect(Array.isArray(entry.args)).toBe(true);
        expect(Object.values(entry.env as Record<string, string>)).toEqual([mcpToken]);
        expect(command).not.toContain(mcpToken);
        // The file path reaches the distro in its own form, never a drive path.
        expect(command).toMatch(/--mcp \S*\/mcp\.json/);
        expect(command).not.toMatch(/--mcp \S*\\/);
      });

      it('hands an oz in a WSL distro on mirrored networking the URL itself', () => {
        adapter.buildCommand(mcpOptions({ shell: 'wsl -d Ubuntu', cliTarget: wslTarget('mirrored') }));
        expect(readMcpConfig().kangentic).toEqual({ url: mcpUrl, headers: { 'X-Kangentic-Token': mcpToken } });
      });
    });

    // ── Telemetry ────────────────────────────────────────────────────────

    it('declares that it streams no live telemetry, so the card shows a label instead of a spinner', () => {
      expect(adapter.liveTelemetryUnsupported?.unavailableLabel).toBeTruthy();
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

      it('quotes the "--" end-of-options marker ahead of --prompt for PowerShell hosts', () => {
        // The -- --prompt ordering itself is pinned separately above ("includes
        // -- --prompt when prompt is provided") and stays out of scope here.
        // This only pins that the marker is quoted under PowerShell: its binder
        // consumes a bare -- before a .ps1 shim sees $args.
        const command = adapter.buildCommand(makeOptions({ prompt: 'Fix the bug', shell: 'powershell' }));
        expect(command).toContain('"--" --prompt');
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
  // The vi.mock above replaces only the shared execVersion probe;
  // parseWarpVersion is the real implementation.
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

// ── The Windows version probe (oz.cmd runs a GUI-subsystem warp.exe) ─────────

describe('warpVersionLaunch', async () => {
  const { parseWarpCliShim, parseWarpVersion, warpVersionLaunch } = await import('../../src/main/agent/adapters/warp/version-detector');
  const { AgentDetector } = await import('../../src/main/agent/shared/agent-detector');

  // The shim Warp v0.2026.04.08.08.36.stable_02 installs, with the install
  // folder made generic.
  const installedShim = '@echo off\r\nset "WARP_CLI_MODE=1"\r\n"C:\\Users\\dev\\AppData\\Local\\Programs\\Warp\\warp.exe" %*\r\n';
  let shimFolder: string;

  beforeEach(() => {
    shimFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-warp-shim-'));
  });

  afterEach(() => {
    fs.rmSync(shimFolder, { recursive: true, force: true });
  });

  it('reads the program and the variables out of the installed shim', () => {
    expect(parseWarpCliShim(installedShim, 'C:\\Users\\dev\\AppData\\Local\\Programs\\Warp\\bin')).toEqual({
      file: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Warp\\warp.exe',
      env: { WARP_CLI_MODE: '1' },
    });
  });

  it('resolves %~dp0 against the shim folder', () => {
    const launch = parseWarpCliShim('@echo off\nset "WARP_CLI_MODE=1"\n"%~dp0..\\warp.exe" %*\n', 'C:\\Users\\dev\\Warp\\bin');
    expect(launch?.file).toBe('C:\\Users\\dev\\Warp\\warp.exe');
  });

  it('reads nothing from a script that runs no .exe with %*', () => {
    expect(parseWarpCliShim('@echo off\nnode "%~dp0oz.js" %*\n', shimFolder)).toBeNull();
  });

  // Red-green: through cmd, oz.cmd printed nothing and Oz was never found on
  // Windows. The probe now starts the warp.exe the shim names.
  it('starts the warp.exe an oz.cmd names, directly, on Windows', () => {
    const shimPath = path.join(shimFolder, 'oz.CMD');
    fs.writeFileSync(shimPath, installedShim);
    expect(warpVersionLaunch(shimPath, 'win32')).toEqual({
      file: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Warp\\warp.exe',
      env: { WARP_CLI_MODE: '1' },
    });
  });

  it('starts a configured warp.exe directly with WARP_CLI_MODE', () => {
    expect(warpVersionLaunch('C:\\Tools\\Warp\\warp.exe', 'win32')).toEqual({ file: 'C:\\Tools\\Warp\\warp.exe', env: { WARP_CLI_MODE: '1' } });
  });

  it('probes the path as found off Windows, and for an unreadable shim', () => {
    expect(warpVersionLaunch('/usr/bin/oz', 'linux')).toBeNull();
    expect(warpVersionLaunch('/usr/local/bin/oz', 'darwin')).toBeNull();
    expect(warpVersionLaunch(path.join(shimFolder, 'missing.cmd'), 'win32')).toBeNull();
  });

  describe('parseWarpCliShim details', () => {
    const shimFolderWindows = 'C:\\Users\\dev\\Warp\\bin';

    it('takes the first .exe line when two are present', () => {
      const text = '"C:\\Users\\dev\\Warp\\first.exe" %*\r\n"C:\\Users\\dev\\Warp\\second.exe" %*\r\n';
      expect(parseWarpCliShim(text, shimFolderWindows)?.file).toBe('C:\\Users\\dev\\Warp\\first.exe');
    });

    it('does not double the separator when the shim folder already ends in one', () => {
      const launch = parseWarpCliShim('"%~dp0warp.exe" %*\n', `${shimFolderWindows}\\`);
      expect(launch?.file).toBe('C:\\Users\\dev\\Warp\\bin\\warp.exe');
    });

    it('reads an unquoted set line into the environment', () => {
      const launch = parseWarpCliShim('set WARP_CLI_MODE=1\n"C:\\Users\\dev\\Warp\\warp.exe" %*\n', shimFolderWindows);
      expect(launch?.env).toEqual({ WARP_CLI_MODE: '1' });
    });

    it("resolves %NAME% from the shim's own set variable, ignoring case", () => {
      const text = 'set "WarpHome=C:\\Users\\dev\\Warp"\n"%WARPHOME%\\warp.exe" %*\n';
      expect(parseWarpCliShim(text, shimFolderWindows, {})?.file).toBe('C:\\Users\\dev\\Warp\\warp.exe');
    });

    it('resolves %NAME% from the passed environment, ignoring case', () => {
      const launch = parseWarpCliShim('"%localappdata%\\Programs\\Warp\\warp.exe" %*\n', shimFolderWindows, { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' });
      expect(launch?.file).toBe('C:\\Users\\dev\\AppData\\Local\\Programs\\Warp\\warp.exe');
    });

    it('returns null for a %NAME% nothing sets', () => {
      expect(parseWarpCliShim('"%NOT_SET_ANYWHERE%\\warp.exe" %*\n', shimFolderWindows, {})).toBeNull();
    });

    it('returns null for a relative program path', () => {
      expect(parseWarpCliShim('"warp.exe" %*\n', shimFolderWindows, {})).toBeNull();
    });
  });

  describe('warpVersionLaunch shim files', () => {
    const exePath = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Warp\\warp.exe';

    it('treats a .bat shim like a .cmd shim', () => {
      const shimPath = path.join(shimFolder, 'oz.bat');
      fs.writeFileSync(shimPath, installedShim);
      expect(warpVersionLaunch(shimPath, 'win32')).toEqual({ file: exePath, env: { WARP_CLI_MODE: '1' } });
    });

    it('does not read a shim larger than 64 KiB', () => {
      const shimPath = path.join(shimFolder, 'oz.cmd');
      fs.writeFileSync(shimPath, installedShim + 'rem padding\r\n'.repeat(6000));
      expect(fs.statSync(shimPath).size).toBeGreaterThan(64 * 1024);
      expect(warpVersionLaunch(shimPath, 'win32')).toBeNull();
    });
  });

  it('the shared detector hands a versionLaunch program to the probe', async () => {
    const launch = { file: 'C:\\Tools\\cli.exe', env: { SOME_MODE: '1' } };
    const detector = new AgentDetector({
      binaryName: 'cli',
      versionArgs: ['dump-debug-info'],
      parseVersion: parseWarpVersion,
      versionLaunch: () => launch,
    });
    const result = await detector.detect('/custom/cli');
    expect(result.found).toBe(true);
    expect(lastVersionArgs).toEqual(['dump-debug-info']);
    expect(lastVersionLaunch).toBe(launch);
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

// -- agent-display-name - warp entry -----------------------------------------

describe('agent-display-name - warp entry', () => {
  it('agentDisplayName returns "Oz CLI" for "warp"', () => {
    expect(agentDisplayName('warp')).toBe('Oz CLI');
  });

  it('agentShortName returns "Oz" for "warp"', () => {
    expect(agentShortName('warp')).toBe('Oz');
  });

  it('agentInstallUrl returns the Warp CLI docs URL for "warp"', () => {
    expect(agentInstallUrl('warp')).toBe('https://docs.warp.dev/reference/cli/cli');
  });
});
