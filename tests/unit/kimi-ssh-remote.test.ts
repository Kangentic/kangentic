/**
 * A Kimi Code CLI on a remote host over SSH (#913), run through the real adapter code and the real file
 * sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). It proves the files, command and
 * environment Kangentic builds, not that Kimi accepts them on a real machine.
 *
 * What a user loses if a test here fails:
 * - the MCP test: the agent has no Kangentic tools on the host, the user's own `.kimi-code/mcp.json`
 *   servers are overwritten, or the token or a path of this computer is written into the file.
 * - the command test: Kimi starts by a path that exists only on this computer, or without the answers
 *   that keep its first prompt from being swallowed by a trust or migration screen.
 * - the release test: Kangentic's entry stays in the user's `.kimi-code/mcp.json` after the session.
 * - the id test: a session on a host waits 90 seconds on a session index that is not on this computer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi';
import { KimiSessionHistoryParser } from '../../src/main/agent/adapters/kimi/session-history-parser';
import { toStoredCliTarget } from '../../src/main/agent/shared/cli-target';
import { settleHostFiles } from '../../src/main/remote/host-file-sync';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';
import { MCP_TOKEN, MCP_URL, SESSION_ID, expectNoLocalPaths, hostJson, spawnOnHost } from './ssh-adapter-spawn-harness';

const workspaces: FakeSshWorkspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
});

async function newWorkspace(): Promise<FakeSshWorkspace> {
  const workspace = await makeFakeSshWorkspace();
  workspaces.push(workspace);
  return workspace;
}

const USER_MCP = { mcpServers: { docs: { url: 'https://docs.example.test/mcp' } } };
const mcpPath = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.kimi-code/mcp.json`;

describe('a Kimi Code session on a remote host', () => {
  it('declares the CLI name and the one file it edits', () => {
    const adapter = new KimiAdapter();
    expect(adapter.remoteCliName).toBe('kimi');
    expect(adapter.remoteFiles()).toEqual({ home: [], project: ['.kimi-code/mcp.json'] });
  });

  it('merges the stdio bridge into the user\'s file on host paths, with the token only in the environment', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(mcpPath(workspace), JSON.stringify(USER_MCP));
    const spawn = await spawnOnHost(new KimiAdapter(), workspace, 'kimi');

    const written = hostJson(workspace, mcpPath(workspace)) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.docs).toEqual(USER_MCP.mcpServers.docs);
    expect(written.mcpServers.kangentic).toEqual({
      command: 'sh',
      args: [`${workspace.hostProject}/.kangentic/sessions/${SESSION_ID}/wsl-hooks/wsl-hook.sh`, 'mcp', MCP_URL],
    });
    expect(spawn.env).toMatchObject({ KANGENTIC_MCP_TOKEN: MCP_TOKEN, KIMI_CODE_TRUST_WORKSPACE: '1', KIMI_CODE_NO_AUTO_UPDATE: '1' });
    for (const content of workspace.host.files.values()) expect(content).not.toContain(MCP_TOKEN);
    expectNoLocalPaths(workspace, spawn);
  });

  it('starts the host\'s own kimi by name, with nothing of this computer in the command', async () => {
    const workspace = await newWorkspace();
    const { command } = await spawnOnHost(new KimiAdapter(), workspace, 'kimi');
    expect(command.startsWith('kimi')).toBe(true);
    expect(command).not.toContain(workspace.projectFolder);
  });

  it('creates the file when the host has none, keeps it out of git status, and removes it on release', async () => {
    const workspace = await newWorkspace();
    workspace.host.directories.add(`${workspace.hostProject}/.git/info`);
    const adapter = new KimiAdapter();
    await spawnOnHost(adapter, workspace, 'kimi');
    expect(workspace.host.files.has(mcpPath(workspace))).toBe(true);
    expect(workspace.host.files.get(`${workspace.hostProject}/.git/info/exclude`) ?? '').toContain('/.kimi-code/mcp.json');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(mcpPath(workspace))).toBe(false);
  });

  it('puts the user\'s own servers back when the session releases', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(mcpPath(workspace), JSON.stringify(USER_MCP));
    const adapter = new KimiAdapter();
    await spawnOnHost(adapter, workspace, 'kimi');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(hostJson(workspace, mcpPath(workspace))).toEqual(USER_MCP);
  });

  it('looks for no session on this computer for a host session, and does not wait', async () => {
    const workspace = await newWorkspace();
    const started = Date.now();
    const cliTarget = toStoredCliTarget(workspace.place);

    expect(await KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd: workspace.projectFolder, cliTarget })).toBeNull();
    expect(await KimiSessionHistoryParser.locate({ agentSessionId: '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', cwd: workspace.projectFolder, cliTarget })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
