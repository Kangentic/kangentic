/**
 * A Gemini CLI on a remote host over SSH (#913), run through the real adapter code and the real file
 * sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). It proves the files and the command
 * Kangentic builds, not that Gemini accepts them on a real machine.
 *
 * What a user loses if a test here fails:
 * - the trust test: Gemini disables every MCP server in the folder (so the agent has no Kangentic
 *   tools), or the entries the user already trusts on the host are overwritten.
 * - the settings test: the hooks name a script that is not on the host, the user's own Gemini settings
 *   there are lost, or this computer's paths and the session token are written to the host.
 * - the release test: Kangentic's hooks and MCP entry stay in the user's project settings after the
 *   session, or a settings file the user never had stays behind.
 * - the session id test: a session on a host waits half a minute for chat files that cannot be there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { GeminiSessionHistoryParser } from '../../src/main/agent/adapters/gemini/session-history-parser';
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

const USER_SETTINGS = {
  theme: 'dark',
  hooks: { BeforeTool: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
  mcpServers: { docs: { httpUrl: 'https://docs.example.test/mcp' } },
};

const trustFile = (workspace: FakeSshWorkspace): string => `${workspace.hostHome}/.gemini/trustedFolders.json`;
const settingsFile = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.gemini/settings.json`;
const hookScript = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.kangentic/gemini-wsl-hook.sh`;

interface HookEntry { hooks: Array<{ command: string }> }

function allHookCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, HookEntry[]>;
  return Object.values(hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

describe('a Gemini session on a remote host', () => {
  it('declares the CLI name and the files it edits', () => {
    const adapter = new GeminiAdapter();
    expect(adapter.remoteCliName).toBe('gemini');
    expect(adapter.remoteFiles()).toEqual({
      home: ['.gemini/trustedFolders.json'],
      project: ['.gemini/settings.json', '.kangentic/gemini-wsl-hook.sh'],
    });
  });

  it('trusts the project folder on the host and keeps what the user already trusts there', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(trustFile(workspace), JSON.stringify({ '/srv/other': 'TRUST_FOLDER', '/srv/denied': 'DO_NOT_TRUST' }));
    await spawnOnHost(new GeminiAdapter(), workspace, 'gemini');

    expect(hostJson(workspace, trustFile(workspace))).toEqual({
      '/srv/other': 'TRUST_FOLDER',
      '/srv/denied': 'DO_NOT_TRUST',
      [workspace.hostProject]: 'TRUST_FOLDER',
    });
    expect(workspace.host.modes.get(trustFile(workspace))).toBe(0o600);
  });

  it('writes nothing to the trust file when an ancestor on the host is already trusted', async () => {
    const workspace = await newWorkspace();
    const before = JSON.stringify({ [workspace.hostHome]: 'TRUST_FOLDER' });
    workspace.host.files.set(trustFile(workspace), before);
    await spawnOnHost(new GeminiAdapter(), workspace, 'gemini');

    expect(workspace.host.files.get(trustFile(workspace))).toBe(before);
    expect(workspace.host.writes).not.toContain(trustFile(workspace));
  });

  it('merges hooks and the MCP reference into the user\'s settings on host paths, with no token in any file', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(settingsFile(workspace), JSON.stringify(USER_SETTINGS));
    const spawn = await spawnOnHost(new GeminiAdapter(), workspace, 'gemini');

    const settings = hostJson(workspace, settingsFile(workspace));
    expect(settings.theme).toBe('dark');
    expect((settings.mcpServers as Record<string, unknown>).docs).toEqual(USER_SETTINGS.mcpServers.docs);
    expect((settings.mcpServers as Record<string, unknown>).kangentic).toEqual({
      command: 'sh',
      args: ['${KANGENTIC_MCP_BRIDGE_SCRIPT}', 'mcp', '${KANGENTIC_MCP_URL}'],
      env: { KANGENTIC_MCP_TOKEN: '${KANGENTIC_MCP_TOKEN}' },
    });
    expect((settings.hooks as Record<string, HookEntry[]>).BeforeTool[0].hooks[0].command).toBe('echo user-hook');

    const commands = allHookCommands(settings).filter((command) => command !== 'echo user-hook');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith(`sh "${hookScript(workspace)}" `), command.slice(0, 80)).toBe(true);
      expect(command).not.toContain('event-bridge');
    }

    // The values the references name are in the session's environment, as host paths.
    expect(spawn.env).toEqual({
      KANGENTIC_MCP_URL: MCP_URL,
      KANGENTIC_MCP_TOKEN: MCP_TOKEN,
      KANGENTIC_MCP_BRIDGE_SCRIPT: `${sessionFolders(workspace).host}/wsl-hooks/wsl-hook.sh`,
    });
    expect(spawn.command.startsWith('gemini ')).toBe(true);
    expect(spawn.command).not.toContain(MCP_TOKEN);
    for (const content of workspace.host.files.values()) expect(content).not.toContain(MCP_TOKEN);
    expectNoLocalPaths(workspace, spawn);
  });

  it('puts the hook script on the host, executable', async () => {
    const workspace = await newWorkspace();
    await spawnOnHost(new GeminiAdapter(), workspace, 'gemini');

    expect(workspace.host.files.get(hookScript(workspace))).toBe(WSL_HOOK_SCRIPT);
    expect(workspace.host.modes.get(hookScript(workspace))).toBe(0o755);
  });

  it('puts the settings on the host from the cwd\'s file, not from another folder of this computer', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(settingsFile(workspace), JSON.stringify(USER_SETTINGS));
    // A project root that is not the cwd would read an empty folder here and write that over the host's file.
    await spawnOnHost(new GeminiAdapter(), workspace, 'gemini', { projectRoot: `${workspace.mirrorHome}` });

    expect(hostJson(workspace, settingsFile(workspace)).theme).toBe('dark');
  });

  it('leaves the user\'s settings as they were when the session releases, and keeps the trust entry and script', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(settingsFile(workspace), JSON.stringify(USER_SETTINGS));
    const adapter = new GeminiAdapter();
    await spawnOnHost(adapter, workspace, 'gemini');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);

    expect(hostJson(workspace, settingsFile(workspace))).toEqual(USER_SETTINGS);
    // By design the trust entry and the script copy stay: they are shared by every session in the folder.
    expect(hostJson(workspace, trustFile(workspace))[workspace.hostProject]).toBe('TRUST_FOLDER');
    expect(workspace.host.files.has(hookScript(workspace))).toBe(true);
  });

  it('creates the settings when the host has none, keeps them out of git, and removes them on release', async () => {
    const workspace = await newWorkspace();
    workspace.host.directories.add(`${workspace.hostProject}/.git/info`);
    const adapter = new GeminiAdapter();
    await spawnOnHost(adapter, workspace, 'gemini');

    expect(workspace.host.files.has(settingsFile(workspace))).toBe(true);
    const exclude = workspace.host.files.get(`${workspace.hostProject}/.git/info/exclude`) ?? '';
    expect(exclude).toContain('/.gemini/settings.json');
    expect(exclude).toContain('/.kangentic/gemini-wsl-hook.sh');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(settingsFile(workspace))).toBe(false);
  });

  it('finds no chat file and does not wait for one', async () => {
    const workspace = await newWorkspace();
    const stored = toStoredCliTarget(workspace.place);
    const started = Date.now();
    expect(await GeminiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd: workspace.projectFolder, cliTarget: stored })).toBeNull();
    expect(await GeminiSessionHistoryParser.locate({ agentSessionId: '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', cwd: workspace.projectFolder, cliTarget: stored })).toBeNull();
    expect(await new GeminiAdapter().parseTranscript('3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', workspace.projectFolder, workspace.place)).toEqual({ entries: [], sourcePath: null });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
