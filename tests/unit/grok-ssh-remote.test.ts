/**
 * A Grok Build CLI on a remote host over SSH (#913), run through the real adapter code and the real file
 * sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). It proves the files and the command
 * Kangentic builds, not that Grok accepts them on a real machine.
 *
 * What a user loses if a test here fails:
 * - the trust tests: Grok silently skips the project's hooks and MCP server in a task's worktree, or
 *   Kangentic answers a trust question on the host that only the user may answer (a project folder).
 * - the config test: the user's own `.grok/config.toml` on the host is lost or rewritten, the agent has
 *   no Kangentic tools, or the token is written to the host.
 * - the hooks test: the hooks name a script that is not on the host, or this computer's paths reach it.
 * - the release test: Kangentic's block and hooks stay in the user's project after the session.
 * - the session test: a session on a host waits a minute for session files that cannot be there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { GrokAdapter } from '../../src/main/agent/adapters/grok';
import { locateGrokUpdatesFile } from '../../src/main/agent/adapters/grok/session-paths';
import { WSL_HOOK_SCRIPT } from '../../src/main/agent/shared/wsl-hook-transport';
import { settleHostFiles } from '../../src/main/remote/host-file-sync';
import { toStoredCliTarget } from '../../src/main/agent/shared/cli-target';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';
import { MCP_TOKEN, MCP_URL, SESSION_ID, expectNoLocalPaths, hostJson, sessionFolders, spawnOnHost } from './ssh-adapter-spawn-harness';

const workspaces: FakeSshWorkspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
});

async function newWorkspace(): Promise<FakeSshWorkspace> {
  const workspace = await makeFakeSshWorkspace();
  workspaces.push(workspace);
  return workspace;
}

const USER_TRUST = "[folders.'/srv/other']\ntrusted = true\ndecided_at = 1786162868\n";
const USER_CONFIG = '[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n';

const trustFile = (workspace: FakeSshWorkspace): string => `${workspace.hostHome}/.grok/trusted_folders.toml`;
const configFile = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.grok/config.toml`;
const hooksFile = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.grok/hooks/kangentic.json`;
const hookScript = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.kangentic/grok-wsl-hook.sh`;

interface HookEntry { hooks: Array<{ command: string }> }

describe('a Grok session on a remote host', () => {
  it('declares the CLI name and the files it edits', () => {
    const adapter = new GrokAdapter();
    expect(adapter.remoteCliName).toBe('grok');
    expect(adapter.remoteFiles()).toEqual({
      home: ['.grok/trusted_folders.toml'],
      project: ['.grok/config.toml', '.grok/hooks/kangentic.json', '.kangentic/grok-wsl-hook.sh'],
    });
  });

  it('trusts a task worktree on the host, after the user\'s entries, and never the project folder', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(trustFile(workspace), USER_TRUST);
    const worktree = path.join(workspace.projectFolder, '.kangentic', 'worktrees', 'task-1');
    await spawnOnHost(new GrokAdapter(), workspace, 'grok', { cwd: worktree });

    const trust = workspace.host.files.get(trustFile(workspace)) ?? '';
    expect(trust.startsWith(USER_TRUST)).toBe(true);
    expect(trust).toContain(`[folders.'${workspace.hostProject}/.kangentic/worktrees/task-1']\ntrusted = true`);
    expect(workspace.host.modes.get(trustFile(workspace))).toBe(0o600);
  });

  it('leaves the trust store alone for the project folder itself', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(trustFile(workspace), USER_TRUST);
    await spawnOnHost(new GrokAdapter(), workspace, 'grok');

    expect(workspace.host.files.get(trustFile(workspace))).toBe(USER_TRUST);
    expect(workspace.host.writes).not.toContain(trustFile(workspace));
  });

  it('merges the MCP bridge block into the user\'s config, with the URL and token only in the environment', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(configFile(workspace), USER_CONFIG);
    const spawn = await spawnOnHost(new GrokAdapter(), workspace, 'grok');

    const config = workspace.host.files.get(configFile(workspace)) ?? '';
    expect(config.startsWith(USER_CONFIG)).toBe(true);
    expect(config).toContain('[mcp_servers.kangentic]\ncommand = "sh"');
    expect(config).toContain('${KANGENTIC_MCP_BRIDGE_SCRIPT}');
    expect(config).not.toContain(MCP_TOKEN);

    expect(spawn.env).toEqual({
      KANGENTIC_MCP_URL: MCP_URL,
      KANGENTIC_MCP_TOKEN: MCP_TOKEN,
      KANGENTIC_MCP_BRIDGE_SCRIPT: `${sessionFolders(workspace).host}/wsl-hooks/wsl-hook.sh`,
    });
    expect(spawn.command.startsWith('grok ')).toBe(true);
    expect(spawn.command).not.toContain(MCP_TOKEN);
    expectNoLocalPaths(workspace, spawn);
  });

  it('writes the hooks file on host paths and puts the script on the host, executable', async () => {
    const workspace = await newWorkspace();
    await spawnOnHost(new GrokAdapter(), workspace, 'grok');

    const hooks = (hostJson(workspace, hooksFile(workspace)).hooks) as Record<string, HookEntry[]>;
    const commands = Object.values(hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith(`sh "${hookScript(workspace)}" `), command.slice(0, 80)).toBe(true);
      expect(command).not.toContain('event-bridge');
    }
    expect(workspace.host.files.get(hookScript(workspace))).toBe(WSL_HOOK_SCRIPT);
    expect(workspace.host.modes.get(hookScript(workspace))).toBe(0o755);
  });

  it('sends the hooks no events path of this computer: the script finds the session\'s folder itself', async () => {
    const workspace = await newWorkspace();
    const spawn = await spawnOnHost(new GrokAdapter(), workspace, 'grok');

    expect(Object.keys(spawn.env ?? {})).not.toContain('KANGENTIC_EVENTS_PATH');
  });

  it('keeps the new files out of git and removes everything of Kangentic\'s on release, restoring the user\'s config', async () => {
    const workspace = await newWorkspace();
    workspace.host.directories.add(`${workspace.hostProject}/.git/info`);
    workspace.host.files.set(configFile(workspace), USER_CONFIG);
    const adapter = new GrokAdapter();
    await spawnOnHost(adapter, workspace, 'grok');

    const exclude = workspace.host.files.get(`${workspace.hostProject}/.git/info/exclude`) ?? '';
    expect(exclude).toContain('/.grok/hooks/kangentic.json');
    // The config was the user's own, so it is not excluded; the script copy is Kangentic's.
    expect(exclude).not.toContain('/.grok/config.toml');
    expect(exclude).toContain('/.kangentic/grok-wsl-hook.sh');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.get(configFile(workspace))).toBe(USER_CONFIG);
    expect(workspace.host.files.has(hooksFile(workspace))).toBe(false);
  });

  it('removes a config the host did not have, once the block is all that was in it', async () => {
    const workspace = await newWorkspace();
    const adapter = new GrokAdapter();
    await spawnOnHost(adapter, workspace, 'grok');
    expect(workspace.host.files.has(configFile(workspace))).toBe(true);

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(configFile(workspace))).toBe(false);
  });

  it('finds no session file, does not wait for one, and does not claim the folder is untrusted', async () => {
    const workspace = await newWorkspace();
    const started = Date.now();
    expect(await locateGrokUpdatesFile({
      agentSessionId: SESSION_ID,
      cwd: workspace.projectFolder,
      cliTarget: toStoredCliTarget(workspace.place),
    })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    // The mirror of the host's trust file is empty here, so it can never prove a folder untrusted.
    expect(new GrokAdapter().kangenticMcpBlockedReason(workspace.projectFolder, workspace.place)).toBeNull();
  });
});
