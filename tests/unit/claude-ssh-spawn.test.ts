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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  /**
   * The MCP tools the plan-mode approval hook may answer for, read back out of the hook command. The builder carries
   * the user's own `permissions.allow` only into this hook (it is not copied into the settings file), so it is the one
   * place a value from `~/.claude/settings.json` can be seen in what the builder wrote.
   */
  function toolsTheHookMayApprove(settings: Record<string, unknown>): string[] {
    for (const command of hookCommands(settings)) {
      const encoded = command.split(' ').pop() ?? '';
      try {
        const spec = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { toolField?: string; tools?: string[] };
        if (spec.toolField === 'tool_name' && Array.isArray(spec.tools)) return spec.tools;
      } catch {
        // Not a spec: an event command's last word.
      }
    }
    throw new Error('the settings carry no plan-mode tool approval hook');
  }

  it('merges the project settings pulled from the host, and the user settings from the mirror', () => {
    fs.mkdirSync(path.join(shellFolder, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(shellFolder, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    fs.mkdirSync(path.join(localHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(localHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__docs__search'] } }));

    const { settings } = buildForHost('ssh-merged');

    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(ls)');
    // The mirror's user setting reached the hook the builder derives from the user's allow rules.
    expect(toolsTheHookMayApprove(settings)).toContain('mcp__docs__search');
  });

  describe('with this computer\'s own home holding a settings file of its own', () => {
    let ownHome: string;

    beforeEach(() => {
      ownHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-ssh-own-home-'));
      fs.mkdirSync(path.join(ownHome, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(ownHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__thiscomputer__tool'] } }));
      // os.homedir() reads these on each call: USERPROFILE on Windows, HOME elsewhere.
      vi.stubEnv('HOME', ownHome);
      vi.stubEnv('USERPROFILE', ownHome);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(ownHome, { recursive: true, force: true });
    });

    it('does not read this computer\'s own ~/.claude/settings.json for a host\'s session, only the mirror', () => {
      // Without this the sentinel could not show up either way: the stub must really have moved the home.
      expect(path.resolve(os.homedir())).toBe(path.resolve(ownHome));
      fs.mkdirSync(path.join(localHome, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(localHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__mirror__tool'] } }));

      const { settings } = buildForHost('ssh-no-local-user-settings');

      const tools = toolsTheHookMayApprove(settings);
      expect(tools).toContain('mcp__mirror__tool');
      expect(tools).not.toContain('mcp__thiscomputer__tool');
      expect(JSON.stringify(settings)).not.toContain('thiscomputer');
    });
  });
});
