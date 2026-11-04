/**
 * An Antigravity CLI (agy) on a remote host over SSH (#913), run through the real adapter code and the
 * real file sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). Nothing here reaches a real
 * machine, so it proves the files and commands Kangentic builds, not that agy accepts them.
 *
 * What a user loses if a test here fails:
 * - the trust test: agy stops on its "trust this workspace" prompt on the host, which no one answers.
 * - the hooks test: the board never sees the session's activity, or the user's own hooks on the host
 *   are overwritten, or a hook names a path that exists only on this computer.
 * - the MCP test: the agent has no Kangentic tools, or the session's MCP token is readable by other
 *   accounts on the host.
 * - the release test: Kangentic's hooks and plugin stay on the host after the session, so the next
 *   agy run there starts a hook script that is gone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { AntigravityAdapter } from '../../src/main/agent/adapters/antigravity';
import { settleHostFiles } from '../../src/main/remote/host-file-sync';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';
import { MCP_TOKEN, MCP_URL, SESSION_ID, expectNoLocalPaths, sessionFolders, spawnOnHost } from './ssh-adapter-spawn-harness';

const CLI_NAME = 'agy';
const workspaces: FakeSshWorkspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
});

async function newWorkspace(): Promise<FakeSshWorkspace> {
  const workspace = await makeFakeSshWorkspace();
  workspaces.push(workspace);
  return workspace;
}

const USER_SETTINGS = { enableTelemetry: false, trustedWorkspaces: ['/home/dev/other'] };
const USER_HOOKS = {
  'my-lint': { Stop: [{ type: 'command', command: 'echo done' }] },
};

function seedUserFiles(workspace: FakeSshWorkspace): void {
  workspace.host.files.set('/home/dev/.gemini/antigravity-cli/settings.json', JSON.stringify(USER_SETTINGS));
  workspace.host.files.set(`${workspace.hostProject}/.agents/hooks.json`, JSON.stringify(USER_HOOKS));
}

function parse(workspace: FakeSshWorkspace, hostPath: string): Record<string, unknown> {
  return JSON.parse(workspace.host.files.get(hostPath) ?? 'null') as Record<string, unknown>;
}

describe('an Antigravity session on a remote host', () => {
  it('declares the CLI name and every file it edits, the MCP config owner-only', () => {
    const adapter = new AntigravityAdapter();
    const declaration = adapter.remoteFiles();
    expect(adapter.remoteCliName).toBe('agy');
    expect(declaration.home).toEqual(['.gemini/antigravity-cli/settings.json']);
    expect([...declaration.project].sort()).toEqual([
      '.agents/hooks.json',
      '.agents/plugins/kangentic/mcp_config.json',
      '.agents/plugins/kangentic/plugin.json',
    ]);
    expect(declaration.private).toEqual(['.agents/plugins/kangentic/mcp_config.json']);
  });

  it('trusts the host path of the working folder in the host\'s settings and keeps the user\'s entries', async () => {
    const workspace = await newWorkspace();
    seedUserFiles(workspace);
    const { command } = await spawnOnHost(new AntigravityAdapter(), workspace, CLI_NAME);

    expect(command.startsWith('agy')).toBe(true);
    const settings = parse(workspace, '/home/dev/.gemini/antigravity-cli/settings.json');
    expect(settings.enableTelemetry).toBe(false);
    expect(settings.trustedWorkspaces).toEqual(['/home/dev/other', workspace.hostProject]);
    expect(workspace.host.modes.get('/home/dev/.gemini/antigravity-cli/settings.json')).toBe(0o600);
  });

  it('merges its hooks into the user\'s hooks file with sh commands that name the session script by a relative path', async () => {
    const workspace = await newWorkspace();
    seedUserFiles(workspace);
    await spawnOnHost(new AntigravityAdapter(), workspace, CLI_NAME);

    const hooks = parse(workspace, `${workspace.hostProject}/.agents/hooks.json`) as Record<string, {
      PreInvocation?: Array<{ command: string }>;
      PostToolUse?: Array<{ hooks: Array<{ command: string }> }>;
      Stop?: Array<{ command: string }>;
    }>;
    expect(hooks['my-lint']).toEqual(USER_HOOKS['my-lint']);
    const named = hooks['kangentic-events'];
    const commands = [
      ...(named.PreInvocation ?? []).map((handler) => handler.command),
      ...(named.PostToolUse ?? []).flatMap((group) => group.hooks.map((handler) => handler.command)),
      ...(named.Stop ?? []).map((handler) => handler.command),
    ];
    expect(commands.length).toBeGreaterThan(0);
    const sessionDirectory = sessionFolders(workspace).local;
    for (const hookCommand of commands) {
      const [program, scriptToken, mode] = hookCommand.split(' ');
      expect(program).toBe('sh');
      expect(mode).toBe('event');
      expect(hookCommand).not.toMatch(/["']/);
      expect(hookCommand).not.toContain('node ');
      // agy runs hooks from `<cwd>/.agents`, and the folder layout is the same on the host.
      expect(path.resolve(workspace.projectFolder, '.agents', scriptToken)).toBe(wslHookPaths(sessionDirectory).script);
    }
  });

  it('writes the MCP plugin with a stdio bridge on the host path, owner-only, and sends nothing of this computer', async () => {
    const workspace = await newWorkspace();
    const spawn = await spawnOnHost(new AntigravityAdapter(), workspace, CLI_NAME);

    const configPath = `${workspace.hostProject}/.agents/plugins/kangentic/mcp_config.json`;
    const entry = (parse(workspace, configPath).mcpServers as Record<string, unknown>).kangentic;
    expect(entry).toEqual({
      command: 'sh',
      args: [`${sessionFolders(workspace).host}/wsl-hooks/wsl-hook.sh`, 'mcp', MCP_URL],
      env: { KANGENTIC_MCP_TOKEN: MCP_TOKEN },
    });
    expect(workspace.host.modes.get(configPath)).toBe(0o600);
    expect(workspace.host.files.has(`${workspace.hostProject}/.agents/plugins/kangentic/plugin.json`)).toBe(true);

    expectNoLocalPaths(workspace, spawn);
  });

  it('puts the Kangentic files in the host\'s git exclude, since they were created there', async () => {
    const workspace = await newWorkspace();
    workspace.host.directories.add(`${workspace.hostProject}/.git/info`);
    await spawnOnHost(new AntigravityAdapter(), workspace, CLI_NAME);
    const exclude = workspace.host.files.get(`${workspace.hostProject}/.git/info/exclude`) ?? '';
    expect(exclude).toContain('/.agents/plugins/kangentic/mcp_config.json');
    expect(exclude).toContain('/.agents/hooks.json');
  });

  it('returns the host to what the user had when the session releases', async () => {
    const workspace = await newWorkspace();
    seedUserFiles(workspace);
    const adapter = new AntigravityAdapter();
    await spawnOnHost(adapter, workspace, CLI_NAME);

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);

    expect(parse(workspace, `${workspace.hostProject}/.agents/hooks.json`)).toEqual(USER_HOOKS);
    expect(workspace.host.files.has(`${workspace.hostProject}/.agents/plugins/kangentic/mcp_config.json`)).toBe(false);
    expect(workspace.host.files.has(`${workspace.hostProject}/.agents/plugins/kangentic/plugin.json`)).toBe(false);
  });

  it('removes a hooks file it created when nothing of the user\'s was there', async () => {
    const workspace = await newWorkspace();
    const adapter = new AntigravityAdapter();
    await spawnOnHost(adapter, workspace, CLI_NAME);
    expect(workspace.host.files.has(`${workspace.hostProject}/.agents/hooks.json`)).toBe(true);

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(`${workspace.hostProject}/.agents/hooks.json`)).toBe(false);
  });

  it('degrades quietly where the transcript lives on the host: no wait, no file', async () => {
    const workspace = await newWorkspace();
    const adapter = new AntigravityAdapter();
    const started = Date.now();
    const located = await adapter.locateSessionHistoryFile('3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', workspace.projectFolder, workspace.place);
    expect(located).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    const parsed = await adapter.parseTranscript('3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', workspace.projectFolder, workspace.place);
    expect(parsed.entries).toEqual([]);
  });

});
