/**
 * A Claude installed in a WSL distro (#286): configured by its
 * `\\wsl.localhost\<distro>\...` path, it runs in the distro's shell by the
 * path the distro sees, its hooks and status line go through the WSL hook
 * transport, and it keeps its trust and user settings in the distro's home.
 * Paths here are built from the OS temp folder, so on Windows they are drive
 * paths the distro sees under `/mnt`, and on CI's Linux they pass through as
 * they are; each expectation converts the same way the code does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execCliForTargetMock = vi.hoisted(() => vi.fn(async () => ({ stdout: 'Usage: claude [options]\n  --model <model>\n', stderr: '' })));
const WSL_CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';

vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  return {
    ...original,
    // Resolved as on Windows, with the distro's facts read, so the WSL path
    // reaches the distro branch on any OS without calling wsl.exe.
    resolveCliTarget: async (cliPath: string | null | undefined, adapterSupportsWsl: boolean) =>
      original.resolveCliTarget(cliPath, adapterSupportsWsl, { platform: 'win32', resolveFacts: async () => factsRef.current }),
    execCliForTarget: execCliForTargetMock,
  };
});

const factsRef = vi.hoisted(() => ({
  current: {
    distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '', uncRoot: '\\\\wsl.localhost\\Ubuntu',
    interactivePath: '/home/dev/.local/bin:/usr/bin', env: {}, networkingMode: 'nat' as const,
  },
}));

import { CommandBuilder } from '../../src/main/agent/adapters/claude/command-builder';
import { ensureClaudeSpawnConfig } from '../../src/main/agent/adapters/claude/trust-manager';
import { discoverClaudeStaticCapabilities } from '../../src/main/agent/adapters/claude/capability-discovery';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { quoteArg } from '../../src/shared/paths';

const SHELL = 'wsl -d Ubuntu';
let projectDirectory: string;
let distroHome: string;
let target: CliTarget;

beforeEach(() => {
  projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-wsl-project-'));
  distroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-wsl-home-'));
  factsRef.current = { ...factsRef.current, homeUnc: distroHome };
  target = { kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/claude', facts: factsRef.current };
  execCliForTargetMock.mockClear();
});

afterEach(() => {
  fs.rmSync(projectDirectory, { recursive: true, force: true });
  fs.rmSync(distroHome, { recursive: true, force: true });
});

function sessionDirectory(sessionId: string): string {
  return path.join(projectDirectory, '.kangentic', 'sessions', sessionId);
}

function buildForDistro(sessionId: string): { command: string; settings: Record<string, unknown> } {
  const directory = sessionDirectory(sessionId);
  const command = new CommandBuilder().buildClaudeCommand({
    cliPath: WSL_CLI_PATH,
    taskId: 'task-1',
    cwd: projectDirectory,
    projectRoot: projectDirectory,
    permissionMode: 'default',
    shell: SHELL,
    statusOutputPath: path.join(directory, 'status.json'),
    eventsOutputPath: path.join(directory, 'events.jsonl'),
    mcpServerEnabled: true,
    mcpServerUrl: 'http://127.0.0.1:4000/mcp/project-1',
    mcpServerToken: 'token',
    cliTarget: target,
  });
  const settings = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf-8')) as Record<string, unknown>;
  return { command, settings };
}

function hookCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  return Object.values(hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
}

describe('a Claude installed in a WSL distro: the command', () => {
  // Red-green: quoting `options.cliPath` for the head fails the first
  // assertion; `toForwardSlash` for the files fails the next two on Windows.
  it('runs the CLI by the distro path and names every file the distro way', () => {
    const { command } = buildForDistro('wsl-command');
    const directory = sessionDirectory('wsl-command');

    expect(command.startsWith(quoteArg('/home/dev/.local/bin/claude', SHELL))).toBe(true);
    expect(command).toContain(`--settings ${quoteArg(cliPathForTarget(path.join(directory, 'settings.json'), target), SHELL)}`);
    expect(command).toContain(`--mcp-config ${quoteArg(cliPathForTarget(path.join(directory, 'mcp.json'), target), SHELL)}`);
    expect(command).not.toContain('wsl.localhost');
  });
});

describe('a Claude installed in a WSL distro: its settings', () => {
  // Red-green: building the node bridge commands for a target fails the hook
  // and status assertions; not preparing the transport fails the folder one.
  it('runs every hook and the status line through the transport script, never node', () => {
    const { settings } = buildForDistro('wsl-hooks');
    const script = cliPathForTarget(wslHookPaths(sessionDirectory('wsl-hooks')).script, target);
    const commands = hookCommands(settings);

    expect(commands.length).toBeGreaterThan(10);
    for (const command of commands) {
      expect(command.startsWith(`sh "${script}" `)).toBe(true);
      expect(command).not.toContain('node ');
    }
    expect((settings.statusLine as { command: string }).command).toBe(
      `sh "${script}" status "${cliPathForTarget(path.join(sessionDirectory('wsl-hooks'), 'status.json'), target)}"`,
    );
    expect(fs.existsSync(wslHookPaths(sessionDirectory('wsl-hooks')).script)).toBe(true);
  });

  it('asks Kangentic for plan approval through a reply, with the spec and no path', () => {
    const { settings } = buildForDistro('wsl-plan');
    const permissionHooks = (settings.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>).PermissionRequest;
    const planHook = permissionHooks.find((entry) => entry.matcher === 'ExitPlanMode');

    expect(planHook?.hooks[0].command).toMatch(/ reply plan-approval [A-Za-z0-9+/=]+$/);
    expect(planHook?.hooks[0].command).not.toContain('plan-approval.json');
  });

  it('takes the renderer choice from the distro\'s user settings, and none from this machine\'s environment', () => {
    fs.mkdirSync(path.join(distroHome, '.claude'), { recursive: true });
    const builder = new CommandBuilder();
    const options = { cwd: projectDirectory, projectRoot: projectDirectory, cliTarget: target };

    // This machine's own variable is not the distro's.
    expect(builder.rendererEnvironment(options, { CLAUDE_CODE_NO_FLICKER: '0' })).toEqual({ CLAUDE_CODE_NO_FLICKER: '1' });
    fs.writeFileSync(path.join(distroHome, '.claude', 'settings.json'), JSON.stringify({ tui: 'default' }));
    expect(builder.rendererEnvironment(options, {})).toBeNull();
  });
});

describe('a Claude installed in a WSL distro: trust', () => {
  // Red-green: writing the Windows ~/.claude.json, or keying the entry by the
  // Windows path, fails these.
  it('trusts the directory in the distro\'s ~/.claude.json, keyed the way the distro sees it', async () => {
    await ensureClaudeSpawnConfig(projectDirectory, target);

    const written = JSON.parse(fs.readFileSync(path.join(distroHome, '.claude.json'), 'utf-8')) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean; enabledMcpjsonServers?: string[] }>;
      diffSidebarOpen: boolean;
    };
    const key = cliPathForTarget(path.resolve(projectDirectory), target);
    expect(written.projects[key]?.hasTrustDialogAccepted).toBe(true);
    expect(written.projects[key]?.enabledMcpjsonServers).toContain('kangentic');
    expect(written.diffSidebarOpen).toBe(false);
    // The lock beside the distro's file is released.
    expect(fs.existsSync(path.join(distroHome, '.claude.json.lock'))).toBe(false);
  });
});

describe('a Claude installed in a WSL distro: capability discovery', () => {
  it('reads --help inside the distro', async () => {
    await discoverClaudeStaticCapabilities(WSL_CLI_PATH);

    expect(execCliForTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/claude' }),
      ['--help'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });
});
