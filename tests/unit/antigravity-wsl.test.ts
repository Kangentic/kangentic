/**
 * An Antigravity CLI (agy) installed in a WSL distro (#286).
 *
 * agy splits a hook command on whitespace and keeps quotes literal, so a hook
 * may hold no quote and no space: a distro session's hooks run
 * `sh <space-free .agents-relative token> event ...`, the token naming the
 * session's copy of the WSL hook transport's script. On NAT networking the MCP
 * plugin names the transport's stdio bridge. agy's data root, trust store and
 * transcripts are the distro's, keyed by the `/mnt` path with Linux case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityAdapter } from '../../src/main/agent/adapters/antigravity';
import { antigravityTranscriptPath } from '../../src/main/agent/adapters/antigravity/data-paths';
import { ensureWorkspaceTrust, removeWorkspaceTrust } from '../../src/main/agent/adapters/antigravity/trust-manager';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const TOKEN = 'agy-wsl-token-0123456789';
const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1/session-1';
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function targetOn(networkingMode: 'nat' | 'mirrored', homeUnc = '\\\\wsl.localhost\\Ubuntu\\home\\dev'): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/agy',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode },
  };
}

function sessionOptions(cliTarget: CliTarget, project: string): SpawnCommandOptions {
  const sessionDirectory = path.join(project, '.kangentic', 'sessions', 'session-1');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\agy',
    taskId: 'task-1',
    cwd: project,
    permissionMode: 'default',
    shell: 'wsl -d Ubuntu',
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: 'session-1',
    cliTarget,
  };
}

function kangenticHookCommands(project: string): string[] {
  const file = JSON.parse(fs.readFileSync(path.join(project, '.agents', 'hooks.json'), 'utf-8')) as Record<string, {
    PreInvocation?: Array<{ command: string }>;
    PostToolUse?: Array<{ hooks: Array<{ command: string }> }>;
    Stop?: Array<{ command: string }>;
  }>;
  const named = file['kangentic-events'];
  return [
    ...(named.PreInvocation ?? []).map((handler) => handler.command),
    ...(named.PostToolUse ?? []).flatMap((group) => group.hooks.map((handler) => handler.command)),
    ...(named.Stop ?? []).map((handler) => handler.command),
  ];
}

function readPluginEntry(project: string): unknown {
  const text = fs.readFileSync(path.join(project, '.agents', 'plugins', 'kangentic', 'mcp_config.json'), 'utf-8');
  return (JSON.parse(text) as { mcpServers: Record<string, unknown> }).mcpServers.kangentic;
}

describe('an Antigravity session in a WSL distro', () => {
  it('starts the Linux path and hooks with a space-free, unquoted token to the session\'s transport script', () => {
    const target = targetOn('nat');
    const project = makeDirectory('kangentic-agy-wsl-project-');
    const options = sessionOptions(target, project);
    const sessionDirectory = path.dirname(options.eventsOutputPath!);
    const command = new AntigravityAdapter().buildCommand(options);

    expect(command.startsWith('/home/dev/.local/bin/agy')).toBe(true);
    const commands = kangenticHookCommands(project);
    expect(commands.length).toBeGreaterThan(0);
    for (const hookCommand of commands) {
      const [program, scriptToken, mode] = hookCommand.split(' ');
      expect(program, hookCommand).toBe('sh');
      expect(mode).toBe('event');
      expect(hookCommand).not.toMatch(/["']/);
      expect(hookCommand).not.toContain('node ');
      // agy runs hooks from `<cwd>/.agents`, which the token is relative to.
      expect(path.resolve(project, '.agents', scriptToken)).toBe(wslHookPaths(sessionDirectory).script);
    }
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
  });

  it('on NAT networking names the transport\'s stdio bridge in the MCP plugin', () => {
    const target = targetOn('nat');
    const project = makeDirectory('kangentic-agy-wsl-project-');
    const options = sessionOptions(target, project);
    new AntigravityAdapter().buildCommand(options);
    expect(readPluginEntry(project)).toEqual({
      command: 'sh',
      args: [cliPathForTarget(wslHookPaths(path.dirname(options.eventsOutputPath!)).script, target), 'mcp', MCP_URL],
      env: { KANGENTIC_MCP_TOKEN: TOKEN },
    });
  });

  it('on mirrored networking keeps the serverUrl entry', () => {
    const project = makeDirectory('kangentic-agy-wsl-project-');
    new AntigravityAdapter().buildCommand(sessionOptions(targetOn('mirrored'), project));
    expect(readPluginEntry(project)).toEqual({ serverUrl: MCP_URL, headers: { 'X-Kangentic-Token': TOKEN } });
  });
});

describe('agy\'s own files for an agy in a WSL distro', () => {
  it('are under the distro\'s ~/.gemini/antigravity-cli', () => {
    expect(antigravityTranscriptPath('3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', targetOn('nat'))).toBe(path.join(
      '\\\\wsl.localhost\\Ubuntu\\home\\dev', '.gemini', 'antigravity-cli', 'brain', '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f',
      '.system_generated', 'logs', 'transcript.jsonl',
    ));
  });

  it('trust is written to and removed from the distro\'s settings by the /mnt path, with Linux case', async () => {
    const distroHome = makeDirectory('kangentic-agy-wsl-home-');
    const target = targetOn('nat', distroHome);
    const settingsPath = path.join(distroHome, '.gemini', 'antigravity-cli', 'settings.json');
    const worktree = path.join(makeDirectory('kangentic-agy-wsl-project-'), 'Repo', '.kangentic', 'worktrees', '1');
    const entry = cliPathForTarget(path.resolve(worktree), target);

    // The same folder under other casing is another folder on Linux.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ trustedWorkspaces: [entry.toLowerCase()] }));
    await ensureWorkspaceTrust(worktree, target);
    const read = (): string[] => (JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { trustedWorkspaces: string[] }).trustedWorkspaces;
    expect(read()).toContain(entry);

    await removeWorkspaceTrust(worktree);
    expect(read()).toContain(entry);
    await removeWorkspaceTrust(worktree, target);
    expect(read()).not.toContain(entry);
  });
});
