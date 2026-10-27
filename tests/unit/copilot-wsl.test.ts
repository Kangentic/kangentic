/**
 * A GitHub Copilot CLI installed in a WSL distro (#286).
 *
 * Each session gets its own config home (`--config-dir`), seeded from the
 * distro's Copilot home so the session keeps the distro's sign-in. Its hooks
 * and status line publish through the WSL hook transport, the config home is
 * named in the distro's form, and on NAT networking Kangentic's server is the
 * transport's stdio bridge.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopilotAdapter } from '../../src/main/agent/adapters/copilot';
import { copilotHomeDir } from '../../src/main/agent/adapters/copilot/copilot-home';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const TOKEN = 'copilot-wsl-token-0123456789';
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

function targetOn(networkingMode: 'nat' | 'mirrored', homeUnc: string, env: Record<string, string> = {}): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/copilot',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env, networkingMode },
  };
}

function sessionOptions(cliTarget: CliTarget): SpawnCommandOptions {
  const project = makeDirectory('kangentic-copilot-wsl-project-');
  const sessionDirectory = path.join(project, '.kangentic', 'sessions', 'session-1');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\copilot',
    taskId: 'task-1',
    cwd: project,
    permissionMode: 'default',
    shell: 'wsl -d Ubuntu',
    statusOutputPath: path.join(sessionDirectory, 'status.json'),
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerEnabled: true,
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: 'session-1',
    cliTarget,
  };
}

describe('a Copilot session in a WSL distro', () => {
  it('starts the Linux path with its config home seeded from the distro\'s, hooks and status line through the transport', () => {
    const distroHome = makeDirectory('kangentic-copilot-wsl-home-');
    fs.mkdirSync(path.join(distroHome, '.copilot'));
    fs.writeFileSync(path.join(distroHome, '.copilot', 'config.json'), JSON.stringify({ logged_in_users: [{ login: 'distro-user' }] }));
    const target = targetOn('nat', distroHome);
    const options = sessionOptions(target);
    const sessionDirectory = path.dirname(options.eventsOutputPath!);
    const configHome = path.join(sessionDirectory, 'copilot-config');
    const command = new CopilotAdapter().buildCommand(options);

    expect(command.startsWith('/home/dev/.local/bin/copilot ')).toBe(true);
    expect(command).toContain(cliPathForTarget(configHome, target));
    expect(command).not.toContain(TOKEN);

    const seeded = JSON.parse(fs.readFileSync(path.join(configHome, 'config.json'), 'utf-8')) as { logged_in_users?: unknown; statusLine?: { command: string } };
    expect(seeded.logged_in_users).toEqual([{ login: 'distro-user' }]);
    expect(seeded.statusLine?.command).toContain('wsl-hook.sh');
    expect(seeded.statusLine?.command).toContain(' status ');

    const hooksFile = JSON.parse(fs.readFileSync(path.join(configHome, 'hooks', 'kangentic.json'), 'utf-8')) as { hooks: Record<string, Array<{ command: string }>> };
    const commands = Object.values(hooksFile.hooks).flat().map((entry) => entry.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const hookCommand of commands) {
      expect(hookCommand, hookCommand).toContain(cliPathForTarget(wslHookPaths(sessionDirectory).script, target));
      expect(hookCommand).not.toContain('event-bridge');
      expect(hookCommand).not.toContain('</dev/null');
    }
    expect(commands.some((hookCommand) => hookCommand.includes(' reply background-shell-hint '))).toBe(true);

    const mcpConfig = JSON.parse(fs.readFileSync(path.join(sessionDirectory, 'copilot-mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(mcpConfig.mcpServers.kangentic).toEqual({
      type: 'stdio',
      command: 'sh',
      args: [cliPathForTarget(wslHookPaths(sessionDirectory).script, target), 'mcp', MCP_URL],
      env: { KANGENTIC_MCP_TOKEN: TOKEN },
    });
    expect(command).toContain(`@${cliPathForTarget(path.join(sessionDirectory, 'copilot-mcp.json'), target)}`);
  });

  it('on mirrored networking keeps the http entry', () => {
    const options = sessionOptions(targetOn('mirrored', makeDirectory('kangentic-copilot-wsl-home-')));
    new CopilotAdapter().buildCommand(options);
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(path.dirname(options.eventsOutputPath!), 'copilot-mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(mcpConfig.mcpServers.kangentic).toEqual({ type: 'http', url: MCP_URL, headers: { 'X-Kangentic-Token': TOKEN } });
  });

  it('reads the distro\'s Copilot home, its own COPILOT_HOME when set', () => {
    expect(copilotHomeDir(targetOn('nat', '\\\\wsl.localhost\\Ubuntu\\home\\dev'))).toBe(path.join('\\\\wsl.localhost\\Ubuntu\\home\\dev', '.copilot'));
    expect(copilotHomeDir(targetOn('nat', '\\\\wsl.localhost\\Ubuntu\\home\\dev', { COPILOT_HOME: '/opt/copilot' }))).toBe('\\\\wsl.localhost\\Ubuntu\\opt\\copilot');
  });
});
