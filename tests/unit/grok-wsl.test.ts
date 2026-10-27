/**
 * A Grok Build installed in a WSL distro (#286).
 *
 * Grok's two per-folder files stay static and shared by every session in the
 * folder: the hooks call the folder's copy of the WSL hook transport's script,
 * and on NAT networking the `.grok/config.toml` block is the transport's stdio
 * bridge with every value an env reference. Its session store, trust store and
 * models cache are the distro's, keyed by the `/mnt` cwd with Linux case, and
 * its sign-in probe asks the distro's Grok.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executed = vi.hoisted(() => [] as Array<{ file: string; args: readonly string[] }>);
vi.mock('../../src/main/utility-process/off-main-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utility-process/off-main-exec')>();
  return {
    ...actual,
    execFileAsync: async (file: string, args: readonly string[] = []) => {
      executed.push({ file, args });
      return { stdout: 'grok-4.6\n', stderr: '' };
    },
  };
});
const FACTS = vi.hoisted(() => ({
  distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu',
  interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' as const,
}));
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  return { ...actual, resolveWslDistroFacts: async () => FACTS, peekWslDistroFacts: () => FACTS };
});

import { GrokAdapter } from '../../src/main/agent/adapters/grok';
import { grokHomeDir, grokSessionDir } from '../../src/main/agent/adapters/grok/session-paths';
import { ensureWorktreeTrust, isFolderTrusted, removeWorktreeTrust } from '../../src/main/agent/adapters/grok/trust-manager';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const TOKEN = 'grok-wsl-token-0123456789';
const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1/session-1';
const realPlatform = process.platform;
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  executed.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function targetOn(networkingMode: 'nat' | 'mirrored', homeUnc = '\\\\wsl.localhost\\Ubuntu\\home\\dev', env: Record<string, string> = {}): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.grok/bin/grok',
    facts: { ...FACTS, homeUnc, env, networkingMode },
  };
}

function sessionOptions(cliTarget: CliTarget | null, project: string, sessionName = 'session-1'): SpawnCommandOptions {
  const sessionDirectory = path.join(project, '.kangentic', 'sessions', sessionName);
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: cliTarget ? '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.grok\\bin\\grok' : '/usr/local/bin/grok',
    taskId: 'task-1',
    cwd: project,
    permissionMode: 'default',
    shell: cliTarget ? 'wsl -d Ubuntu' : 'bash',
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: sessionName,
    ...(cliTarget ? { cliTarget } : {}),
  };
}

function hookCommands(project: string): string[] {
  const file = JSON.parse(fs.readFileSync(path.join(project, '.grok', 'hooks', 'kangentic.json'), 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return Object.values(file.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

function configToml(project: string): string {
  return fs.readFileSync(path.join(project, '.grok', 'config.toml'), 'utf-8');
}

describe('a Grok session in a WSL distro', () => {
  it('starts the Linux path and hooks through the folder\'s copy of the transport script', () => {
    const target = targetOn('nat');
    const project = makeDirectory('kangentic-grok-wsl-project-');
    const adapter = new GrokAdapter();
    const command = adapter.buildCommand(sessionOptions(target, project));

    expect(command.startsWith('/home/dev/.grok/bin/grok ')).toBe(true);
    const folderCopy = path.join(project, '.kangentic', 'grok-wsl-hook.sh');
    expect(fs.existsSync(folderCopy)).toBe(true);
    const commands = hookCommands(project);
    expect(commands.length).toBeGreaterThan(0);
    for (const hookCommand of commands) {
      expect(hookCommand, hookCommand).toContain(cliPathForTarget(folderCopy, target));
      expect(hookCommand).not.toContain('event-bridge');
      expect(hookCommand).not.toContain('session-1');
      expect(hookCommand).not.toContain('</dev/null');
    }
    // A sibling session in the folder writes the same hooks.
    adapter.buildCommand(sessionOptions(target, project, 'session-2'));
    expect(hookCommands(project)).toEqual(commands);
  });

  it('on NAT networking writes the bridge block, whose every reference the session\'s environment carries, and no Windows events path', () => {
    const target = targetOn('nat');
    const project = makeDirectory('kangentic-grok-wsl-project-');
    const options = sessionOptions(target, project);
    const adapter = new GrokAdapter();
    adapter.buildCommand(options);
    const environment = adapter.buildEnv(options) ?? {};
    const sessionDirectory = path.dirname(options.eventsOutputPath!);

    const toml = configToml(project);
    expect(toml).toContain('command = "sh"');
    expect(toml).toContain('args = ["${KANGENTIC_MCP_BRIDGE_SCRIPT}", "mcp", "${KANGENTIC_MCP_URL}"]');
    expect(toml).toContain('env = { "KANGENTIC_MCP_TOKEN" = "${KANGENTIC_MCP_TOKEN}" }');
    expect(toml).not.toContain(TOKEN);
    for (const match of toml.matchAll(/\$\{([A-Z_]+)\}/g)) expect(Object.keys(environment), match[1]).toContain(match[1]);
    expect(environment.KANGENTIC_MCP_BRIDGE_SCRIPT).toBe(cliPathForTarget(wslHookPaths(sessionDirectory).script, target));
    expect(environment.KANGENTIC_EVENTS_PATH).toBeUndefined();
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
  });

  it('on mirrored networking keeps the URL block, and this machine keeps the events path', () => {
    const project = makeDirectory('kangentic-grok-wsl-project-');
    new GrokAdapter().buildCommand(sessionOptions(targetOn('mirrored'), project));
    expect(configToml(project)).toContain('url = "${KANGENTIC_MCP_URL}"');

    const localProject = makeDirectory('kangentic-grok-local-project-');
    const localOptions = sessionOptions(null, localProject);
    const adapter = new GrokAdapter();
    adapter.buildCommand(localOptions);
    expect(adapter.buildEnv(localOptions)).toEqual({
      KANGENTIC_EVENTS_PATH: localOptions.eventsOutputPath,
      KANGENTIC_MCP_URL: MCP_URL,
      KANGENTIC_MCP_TOKEN: TOKEN,
    });
  });
});

describe('Grok\'s own files for a Grok in a WSL distro', () => {
  it('are in the distro\'s Grok home, its GROK_HOME when set, keyed by the /mnt cwd', () => {
    const target = targetOn('nat');
    expect(grokSessionDir('C:\\Users\\dev\\proj', 'session-id', target)).toBe(
      path.join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.grok', 'sessions', encodeURIComponent('/mnt/c/Users/dev/proj'), 'session-id'),
    );
    expect(grokHomeDir(targetOn('nat', '\\\\wsl.localhost\\Ubuntu\\home\\dev', { GROK_HOME: '/opt/grok' }))).toBe('\\\\wsl.localhost\\Ubuntu\\opt\\grok');
  });

  it('trust is written, read and removed in the distro\'s store, keyed by the /mnt path with Linux case', async () => {
    const distroHome = makeDirectory('kangentic-grok-wsl-home-');
    const target = targetOn('nat', distroHome);
    const store = path.join(distroHome, '.grok', 'trusted_folders.toml');
    const project = path.join(makeDirectory('kangentic-grok-wsl-project-'), 'Repo');
    const worktree = path.join(project, '.kangentic', 'worktrees', '1');
    const projectKey = cliPathForTarget(path.resolve(project), target);
    const worktreeKey = cliPathForTarget(path.resolve(worktree), target);

    // An ancestor decided under other casing is another folder on Linux.
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, `[folders.'${projectKey.toLowerCase()}']\ntrusted = false\n`);
    await ensureWorktreeTrust(worktree, target);
    expect(fs.readFileSync(store, 'utf-8')).toContain(`[folders.'${worktreeKey}']`);
    expect(isFolderTrusted(worktree, target)).toBe(true);

    await removeWorktreeTrust(worktree);
    expect(fs.readFileSync(store, 'utf-8')).toContain(`[folders.'${worktreeKey}']`);
    await removeWorktreeTrust(worktree, target);
    expect(fs.readFileSync(store, 'utf-8')).not.toContain(`[folders.'${worktreeKey}']`);
    expect(isFolderTrusted(worktree, target)).toBe(false);
  });

  it('the sign-in probe asks the distro\'s Grok through wsl.exe', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await new GrokAdapter().probeAuth('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.grok\\bin\\grok')).toBe(true);
    expect(executed).toHaveLength(1);
    expect(executed[0].file.endsWith('wsl.exe')).toBe(true);
    expect(executed[0].args.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
    expect(executed[0].args.slice(-2)).toEqual(['/home/dev/.grok/bin/grok', 'models']);
  });
});
