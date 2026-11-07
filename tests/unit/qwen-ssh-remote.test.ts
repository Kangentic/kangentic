/**
 * A Qwen Code CLI on a remote host over SSH (#913), run through the real adapter code and the real file
 * sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). It proves the files and the command
 * Kangentic builds, not that Qwen accepts them on a real machine.
 *
 * What a user loses if a test here fails:
 * - the trust tests: with folder trust on, Qwen stops at its trust prompt on every session, or the
 *   user's own trusted folders on the host are overwritten; with it off, Kangentic writes a trust file
 *   the user never asked for.
 * - the settings test: the hooks name a script that is not on the host, the user's own Qwen settings
 *   there are lost, or this computer's paths are written to the host.
 * - the MCP test: the agent has no Kangentic tools, or is pointed at a config file on this computer.
 * - the release test: Kangentic's hooks stay in the user's project settings after the session.
 * - the session id test: a session on a host waits for chat files that cannot be there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code';
import { QwenSessionHistoryParser } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { WSL_HOOK_SCRIPT } from '../../src/main/agent/shared/wsl-hook-transport';
import { settleHostFiles } from '../../src/main/remote/host-file-sync';
import { toStoredCliTarget } from '../../src/main/agent/shared/cli-target';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';
import { MCP_TOKEN, SESSION_ID, expectNoLocalPaths, hostJson, sessionFolders, spawnOnHost } from './ssh-adapter-spawn-harness';

const workspaces: FakeSshWorkspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
});

async function newWorkspace(): Promise<FakeSshWorkspace> {
  const workspace = await makeFakeSshWorkspace();
  workspaces.push(workspace);
  return workspace;
}

const TRUST_ON = { security: { folderTrust: { enabled: true } }, ui: { theme: 'dark' } };
const USER_PROJECT_SETTINGS = {
  model: { name: 'user-model' },
  hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
};

const homeSettings = (workspace: FakeSshWorkspace): string => `${workspace.hostHome}/.qwen/settings.json`;
const trustFile = (workspace: FakeSshWorkspace): string => `${workspace.hostHome}/.qwen/trustedFolders.json`;
const settingsFile = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.qwen/settings.json`;
const hookScript = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.kangentic/qwen-wsl-hook.sh`;

interface HookEntry { hooks: Array<{ command: string }> }

describe('a Qwen Code session on a remote host', () => {
  it('declares the CLI name and the files it edits', () => {
    const adapter = new QwenAdapter();
    expect(adapter.remoteCliName).toBe('qwen');
    expect(adapter.remoteFiles()).toEqual({
      home: ['.qwen/settings.json', '.qwen/trustedFolders.json'],
      project: ['.qwen/settings.json', '.kangentic/qwen-wsl-hook.sh'],
    });
  });

  it('trusts the project folder when the host\'s Qwen has folder trust on, and keeps the user\'s entries', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(homeSettings(workspace), JSON.stringify(TRUST_ON));
    workspace.host.files.set(trustFile(workspace), JSON.stringify({ '/srv/other': 'TRUST_FOLDER' }));
    await spawnOnHost(new QwenAdapter(), workspace, 'qwen');

    expect(hostJson(workspace, trustFile(workspace))).toEqual({ '/srv/other': 'TRUST_FOLDER', [workspace.hostProject]: 'TRUST_FOLDER' });
    expect(workspace.host.modes.get(trustFile(workspace))).toBe(0o600);
    // The settings file was only read for the flag: the host's copy is untouched.
    expect(hostJson(workspace, homeSettings(workspace))).toEqual(TRUST_ON);
    expect(workspace.host.writes).not.toContain(homeSettings(workspace));
  });

  it('writes no trust file when the host\'s Qwen has folder trust off', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(homeSettings(workspace), JSON.stringify({ ui: { theme: 'dark' } }));
    await spawnOnHost(new QwenAdapter(), workspace, 'qwen');

    expect(workspace.host.files.has(trustFile(workspace))).toBe(false);
  });

  it('merges hooks into the user\'s settings on host paths and puts the script on the host, executable', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(settingsFile(workspace), JSON.stringify(USER_PROJECT_SETTINGS));
    const spawn = await spawnOnHost(new QwenAdapter(), workspace, 'qwen');

    const settings = hostJson(workspace, settingsFile(workspace));
    expect(settings.model).toEqual(USER_PROJECT_SETTINGS.model);
    const hooks = settings.hooks as Record<string, HookEntry[]>;
    expect(hooks.PreToolUse[0].hooks[0].command).toBe('echo user-hook');
    const commands = Object.values(hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command)).filter((command) => command !== 'echo user-hook');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith(`sh "${hookScript(workspace)}" `), command.slice(0, 80)).toBe(true);
      expect(command).not.toContain('event-bridge');
    }

    expect(workspace.host.files.get(hookScript(workspace))).toBe(WSL_HOOK_SCRIPT);
    expect(workspace.host.modes.get(hookScript(workspace))).toBe(0o755);
    expect(spawn.command.startsWith('qwen ')).toBe(true);
    expectNoLocalPaths(workspace, spawn);
  });

  it('reads the settings from the cwd\'s file, not from another folder of this computer', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(settingsFile(workspace), JSON.stringify(USER_PROJECT_SETTINGS));
    await spawnOnHost(new QwenAdapter(), workspace, 'qwen', { projectRoot: workspace.mirrorHome });

    expect(hostJson(workspace, settingsFile(workspace)).model).toEqual(USER_PROJECT_SETTINGS.model);
  });

  it('hands Qwen the session\'s MCP config by its host path, whose bridge runs the host\'s script', async () => {
    const workspace = await newWorkspace();
    const spawn = await spawnOnHost(new QwenAdapter(), workspace, 'qwen');
    const { local, host } = sessionFolders(workspace);

    expect(spawn.command).toContain(`--mcp-config ${host}/mcp.json `);
    // The file stays on this computer and the session relay sends it; the token is in it, not in the command.
    const mcpConfig = JSON.parse(fs.readFileSync(path.join(local, 'mcp.json'), 'utf8')) as { mcpServers: { kangentic: { command: string; args: string[]; env: Record<string, string> } } };
    expect(mcpConfig.mcpServers.kangentic.command).toBe('sh');
    expect(mcpConfig.mcpServers.kangentic.args[0]).toBe(`${host}/wsl-hooks/wsl-hook.sh`);
    expect(mcpConfig.mcpServers.kangentic.env).toEqual({ KANGENTIC_MCP_TOKEN: MCP_TOKEN });
    expect(spawn.command).not.toContain(MCP_TOKEN);
    for (const content of workspace.host.files.values()) expect(content).not.toContain(MCP_TOKEN);
  });

  it('leaves the user\'s settings as they were when the session releases', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(settingsFile(workspace), JSON.stringify(USER_PROJECT_SETTINGS));
    const adapter = new QwenAdapter();
    await spawnOnHost(adapter, workspace, 'qwen');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);

    expect(hostJson(workspace, settingsFile(workspace))).toEqual(USER_PROJECT_SETTINGS);
  });

  it('creates the settings when the host has none, keeps them out of git, and removes them on release', async () => {
    const workspace = await newWorkspace();
    workspace.host.directories.add(`${workspace.hostProject}/.git/info`);
    const adapter = new QwenAdapter();
    await spawnOnHost(adapter, workspace, 'qwen');

    expect(workspace.host.files.has(settingsFile(workspace))).toBe(true);
    expect(workspace.host.files.get(`${workspace.hostProject}/.git/info/exclude`) ?? '').toContain('/.qwen/settings.json');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(settingsFile(workspace))).toBe(false);
  });

  it('finds no chat file and does not wait for one', async () => {
    const workspace = await newWorkspace();
    const started = Date.now();
    expect(await QwenSessionHistoryParser.locate({
      agentSessionId: SESSION_ID,
      cwd: workspace.projectFolder,
      cliTarget: toStoredCliTarget(workspace.place),
    })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
