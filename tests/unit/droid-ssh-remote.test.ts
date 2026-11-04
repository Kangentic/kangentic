/**
 * A Factory Droid on a remote host over SSH (#913), run through the real adapter code and the real
 * file sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). It proves the files and the
 * command Kangentic builds, not that Droid accepts them on a real machine.
 *
 * What a user loses if a test here fails:
 * - the MCP test: the agent has no Kangentic tools on the host, the user's own MCP servers there are
 *   overwritten, or the session token is written into a file in the user's repository.
 * - the command test: Droid starts in a folder that exists only on this computer, or is handed a
 *   hooks file that is not on the host.
 * - the release test: Kangentic's MCP entry stays in the user's `.factory/mcp.json` after the session.
 * - the session id test: a session on a host waits on a folder that is not there, or errors, instead of
 *   starting fresh when it is resumed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { captureSessionIdFromFilesystem } from '../../src/main/agent/adapters/droid/session-id-capture';
import { pullHostFilesFor, settleHostFiles } from '../../src/main/remote/host-file-sync';
import { toStoredCliTarget } from '../../src/main/agent/shared/cli-target';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';
import { MCP_TOKEN, MCP_URL, SESSION_ID, expectNoLocalPaths, sessionFolders, spawnOnHost, spawnOptions } from './ssh-adapter-spawn-harness';

const CLI_NAME = 'droid';
const workspaces: FakeSshWorkspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
});

async function newWorkspace(): Promise<FakeSshWorkspace> {
  const workspace = await makeFakeSshWorkspace();
  workspaces.push(workspace);
  return workspace;
}

const USER_MCP = { mcpServers: { docs: { type: 'http', url: 'https://docs.example.test/mcp' } } };

const MCP_PATH = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.factory/mcp.json`;

describe('a Droid session on a remote host', () => {
  it('declares the CLI name and the one file it edits', () => {
    const adapter = new DroidAdapter();
    expect(adapter.remoteCliName).toBe('droid');
    expect(adapter.remoteFiles()).toEqual({ home: [], project: ['.factory/mcp.json'] });
  });

  it('merges the Kangentic MCP bridge into the user\'s file, on host paths, with the token only in the environment', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(MCP_PATH(workspace), JSON.stringify(USER_MCP));
    const spawn = await spawnOnHost(new DroidAdapter(), workspace, CLI_NAME);

    const written = JSON.parse(workspace.host.files.get(MCP_PATH(workspace)) ?? '{}') as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.docs).toEqual(USER_MCP.mcpServers.docs);
    expect(written.mcpServers.kangentic).toEqual({
      type: 'stdio',
      command: 'sh',
      args: [`${sessionFolders(workspace).host}/wsl-hooks/wsl-hook.sh`, 'mcp', MCP_URL],
      env: { KANGENTIC_MCP_TOKEN: '${KANGENTIC_MCP_TOKEN}' },
    });
    expect(spawn.env).toEqual({ KANGENTIC_MCP_TOKEN: MCP_TOKEN });
    for (const [hostPath, content] of workspace.host.files) expect(content, hostPath).not.toContain(MCP_TOKEN);
    expectNoLocalPaths(workspace, spawn);
  });

  it('starts droid in the project\'s folder on the host and passes no hooks file', async () => {
    const workspace = await newWorkspace();
    const { command } = await spawnOnHost(new DroidAdapter(), workspace, CLI_NAME);
    expect(command.startsWith('droid --cwd ')).toBe(true);
    expect(command).toContain(workspace.hostProject);
    expect(command).not.toContain(workspace.projectFolder);
    expect(command).not.toContain('--settings');
    expect(fs.existsSync(path.join(sessionFolders(workspace).local, 'droid-settings.json'))).toBe(false);
  });

  it('creates the file when the host has none, excludes it from git, and removes it again on release', async () => {
    const workspace = await newWorkspace();
    workspace.host.directories.add(`${workspace.hostProject}/.git/info`);
    const adapter = new DroidAdapter();
    await spawnOnHost(adapter, workspace, CLI_NAME);
    expect(workspace.host.files.has(MCP_PATH(workspace))).toBe(true);
    expect(workspace.host.files.get(`${workspace.hostProject}/.git/info/exclude`) ?? '').toContain('/.factory/mcp.json');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(MCP_PATH(workspace))).toBe(false);
  });

  it('leaves the user\'s own servers in place when the session releases', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(MCP_PATH(workspace), JSON.stringify(USER_MCP));
    const adapter = new DroidAdapter();
    await spawnOnHost(adapter, workspace, CLI_NAME);

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(JSON.parse(workspace.host.files.get(MCP_PATH(workspace)) ?? '{}')).toEqual(USER_MCP);
  });

  it('captures no session id and does not wait: a resume of a host session starts fresh', async () => {
    const workspace = await newWorkspace();
    const adapter = new DroidAdapter();
    const started = Date.now();
    const captured = await captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: workspace.projectFolder,
      cliTarget: toStoredCliTarget(workspace.place),
    });
    expect(captured).toBeNull();
    expect(await adapter.locateSessionHistoryFile('3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', workspace.projectFolder, workspace.place)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);

    // No captured id means no `--resume`: the command is a plain start.
    const sync = await pullHostFilesFor(adapter, workspace.projectFolder, workspace.place);
    const command = adapter.buildCommand({ ...spawnOptions(workspace, CLI_NAME), resume: true, sessionId: undefined });
    await sync?.push();
    expect(command).not.toContain('--resume');
  });
});
