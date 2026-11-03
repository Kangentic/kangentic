/**
 * A Claude running on a remote host over SSH (#913), built by the real command builder with a `ssh`
 * place. The builder writes the session's settings, MCP config and hook script on this computer, in
 * the project's shell folder, and names every file the way the host will see it. The relay then pushes
 * them (`remote-session-relay.ts`). The same checks as `claude-wsl-spawn.test.ts`, for the other kind
 * of place.
 *
 * What a user loses if it breaks: a settings file, hook script or MCP config named by a path that only
 * exists on this computer, or a hook that runs `node` on a host that may have none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandBuilder } from '../../src/main/agent/adapters/claude/command-builder';
import { cliPathForTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { quoteArg } from '../../src/shared/paths';

const SHELL = 'fish';
const HOST_PROJECT = '/home/dev/projects/api';
let shellFolder: string;
let localHome: string;
let place: SshCliPlace;

beforeEach(() => {
  shellFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-ssh-shell-'));
  localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-ssh-home-'));
  place = {
    kind: 'ssh',
    hostId: 'host-a',
    home: '/home/dev',
    shellName: SHELL,
    localHome,
    roots: [{ local: shellFolder, host: HOST_PROJECT }],
    // A place that builds a command carries the CLI as the host runs it: a bare name its login shell resolves.
    linuxCliPath: 'claude',
  };
});

afterEach(() => {
  fs.rmSync(shellFolder, { recursive: true, force: true });
  fs.rmSync(localHome, { recursive: true, force: true });
});

function sessionDirectory(sessionId: string): string {
  return path.join(shellFolder, '.kangentic', 'sessions', sessionId);
}

function hostSessionDirectory(sessionId: string): string {
  return `${HOST_PROJECT}/.kangentic/sessions/${sessionId}`;
}

function buildForHost(sessionId: string, overrides: Partial<Parameters<CommandBuilder['buildClaudeCommand']>[0]> = {}): { command: string; settings: Record<string, unknown> } {
  const directory = sessionDirectory(sessionId);
  const command = new CommandBuilder().buildClaudeCommand({
    cliPath: 'claude',
    taskId: 'task-1',
    cwd: shellFolder,
    projectRoot: shellFolder,
    permissionMode: 'default',
    shell: SHELL,
    statusOutputPath: path.join(directory, 'status.json'),
    eventsOutputPath: path.join(directory, 'events.jsonl'),
    mcpServerEnabled: true,
    mcpServerUrl: 'http://127.0.0.1:4000/mcp/project-1',
    mcpServerToken: 'token',
    cliTarget: place,
    ...overrides,
  });
  const settings = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf-8')) as Record<string, unknown>;
  return { command, settings };
}

function hookCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  return Object.values(hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
}

describe('a Claude on a remote host: the command', () => {
  it('runs the host\'s own CLI by name and names every file the host\'s way, never a path from this computer', () => {
    const { command } = buildForHost('ssh-command');

    expect(command.startsWith(quoteArg('claude', SHELL))).toBe(true);
    expect(command).toContain(`--settings ${quoteArg(`${hostSessionDirectory('ssh-command')}/settings.json`, SHELL)}`);
    expect(command).toContain(`--mcp-config ${quoteArg(`${hostSessionDirectory('ssh-command')}/mcp.json`, SHELL)}`);
    expect(command).not.toContain(shellFolder.replace(/\\/g, '/'));
    expect(command).not.toContain(os.tmpdir().replace(/\\/g, '/'));
  });

  it('is the same path the place maps for every session file', () => {
    const { command } = buildForHost('ssh-same');
    expect(command).toContain(cliPathForTarget(path.join(sessionDirectory('ssh-same'), 'settings.json'), place));
  });
});

describe('a Claude on a remote host: Kangentic\'s MCP server', () => {
  it('starts the stdio bridge by the host\'s script, with the token in its environment and never its arguments', () => {
    buildForHost('ssh-mcp');
    const config = JSON.parse(fs.readFileSync(path.join(sessionDirectory('ssh-mcp'), 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };

    expect(config.mcpServers.kangentic).toEqual({
      type: 'stdio',
      command: 'sh',
      args: [`${hostSessionDirectory('ssh-mcp')}/wsl-hooks/wsl-hook.sh`, 'mcp', 'http://127.0.0.1:4000/mcp/project-1'],
      env: { KANGENTIC_MCP_TOKEN: 'token' },
    });
  });

  it('never gives the host a URL to dial: the host cannot reach this computer\'s loopback', () => {
    buildForHost('ssh-no-http');
    const text = fs.readFileSync(path.join(sessionDirectory('ssh-no-http'), 'mcp.json'), 'utf-8');
    expect(text).not.toContain('"type": "http"');
    expect(text).not.toContain('X-Kangentic-Token');
  });
});

describe('a Claude on a remote host: its settings', () => {
  it('runs every hook and the status line through the transport script on the host, never node', () => {
    const { settings } = buildForHost('ssh-hooks');
    const script = `${hostSessionDirectory('ssh-hooks')}/wsl-hooks/wsl-hook.sh`;
    const commands = hookCommands(settings);

    expect(commands.length).toBeGreaterThan(10);
    for (const command of commands) {
      expect(command.startsWith(`sh "${script}" `)).toBe(true);
      expect(command).not.toContain('node ');
      expect(command).not.toContain(shellFolder.replace(/\\/g, '/'));
    }
    const statusLine = settings.statusLine as { command: string };
    expect(statusLine.command).toBe(`sh "${script}" status "${hostSessionDirectory('ssh-hooks')}/status.json"`);
  });

  it('prepares the transport folders and the script on this computer, for the relay to push', () => {
    buildForHost('ssh-transport');
    const paths = wslHookPaths(sessionDirectory('ssh-transport'));

    for (const folder of [paths.inbox, paths.requests, paths.responses]) expect(fs.statSync(folder).isDirectory()).toBe(true);
    expect(fs.readFileSync(paths.script, 'utf-8')).toContain('Kangentic hook transport');
    expect(fs.existsSync(paths.signal)).toBe(true);
  });

  it('merges the project settings pulled from the host, and the user settings from the mirror', () => {
    fs.mkdirSync(path.join(shellFolder, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(shellFolder, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    fs.mkdirSync(path.join(localHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(localHome, '.claude', 'settings.json'), JSON.stringify({ tui: 'default' }));

    const { settings } = buildForHost('ssh-merged');

    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(ls)');
  });

  it('does not read this computer\'s own ~/.claude/settings.json for a host\'s session', () => {
    // The local user's settings live in os.homedir(); a host's session must only ever see the mirror.
    const { settings } = buildForHost('ssh-no-local-user-settings');
    expect(JSON.stringify(settings)).not.toContain(os.homedir().replace(/\\/g, '/'));
  });
});
