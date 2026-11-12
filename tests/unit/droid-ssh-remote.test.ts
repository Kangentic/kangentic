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
 * - the session id tests: a session on a host waits on a folder that is not there, its transcript is never
 *   named, or a resume starts a fresh conversation in place of the stored one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { captureSessionIdFromFilesystem } from '../../src/main/agent/adapters/droid/session-id-capture';
import { pullHostFilesFor, settleHostFiles } from '../../src/main/remote/host-file-sync';
import { toStoredCliTarget } from '../../src/main/agent/shared/cli-target';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
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
  it('declares the CLI name, the file it edits, the file it reads, and the hooks file the host must hold', () => {
    const adapter = new DroidAdapter();
    expect(adapter.remoteCliName).toBe('droid');
    expect(adapter.remoteFiles()).toEqual({ home: ['.factory/mcp.json'], project: ['.factory/mcp.json'] });
    expect(adapter.remoteSessionFiles()).toEqual(['droid-settings.json']);
  });

  it('reads the user\'s own servers from the host and writes nothing back to that file', async () => {
    const workspace = await newWorkspace();
    const userFile = '/home/dev/.factory/mcp.json';
    const content = JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } });
    workspace.host.files.set(userFile, content);

    await spawnOnHost(new DroidAdapter(), workspace, CLI_NAME);

    const settings = JSON.parse(fs.readFileSync(path.join(sessionFolders(workspace).local, 'droid-settings.json'), 'utf8')) as { hooks: unknown };
    expect(JSON.stringify(settings.hooks)).toContain('playwright');
    expect(workspace.host.files.get(userFile)).toBe(content);
    expect(workspace.host.writes).not.toContain(userFile);
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

  it('starts droid in the project\'s folder on the host, with a hooks file named by its path there', async () => {
    const workspace = await newWorkspace();
    const { command } = await spawnOnHost(new DroidAdapter(), workspace, CLI_NAME);
    expect(command.startsWith('droid --cwd ')).toBe(true);
    expect(command).toContain(workspace.hostProject);
    expect(command).not.toContain(workspace.projectFolder);
    expect(command).toContain(`--settings ${quoteArg(`${sessionFolders(workspace).host}/droid-settings.json`, workspace.place.shellName)}`);
    expect(fs.existsSync(path.join(sessionFolders(workspace).local, 'droid-settings.json'))).toBe(true);
  });

  it('publishes its hooks through the transport script on the host, so SessionStart reaches this computer', async () => {
    const workspace = await newWorkspace();
    await spawnOnHost(new DroidAdapter(), workspace, CLI_NAME);

    const settings = fs.readFileSync(path.join(sessionFolders(workspace).local, 'droid-settings.json'), 'utf8');
    const hooks = (JSON.parse(settings) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }).hooks;
    const command = hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain(`${sessionFolders(workspace).host}/wsl-hooks/wsl-hook.sh`);
    expect(settings).not.toContain(toForwardSlash(workspace.projectFolder));
    expect(settings).not.toContain('event-bridge.js');
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

  it('reads the id from its SessionStart hook, as the real 0.218.0 payload carries it, which is what names the transcript', () => {
    const adapter = new DroidAdapter();
    const payload = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'droid-hooks', 'droid-0.218.0-session-start.json'), 'utf8');

    expect(adapter.runtime.sessionId?.fromHook?.(payload)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('does not wait on the filesystem: the id comes from the hook, and only the host holds the session file', async () => {
    const workspace = await newWorkspace();
    const started = Date.now();
    const captured = await captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: workspace.projectFolder,
      cliTarget: toStoredCliTarget(workspace.place),
    });
    expect(captured).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('resumes the stored id on the host, which a session there could not do before the hook reached it', async () => {
    const workspace = await newWorkspace();
    const agentSessionId = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
    const { command } = await spawnOnHost(new DroidAdapter(), workspace, CLI_NAME, { resume: true, sessionId: agentSessionId });

    expect(command).toContain(`--resume ${agentSessionId}`);
  });

  it('starts fresh when no id was reported, as with a Droid that ignores its hooks', async () => {
    const workspace = await newWorkspace();
    const adapter = new DroidAdapter();
    const sync = await pullHostFilesFor(adapter, workspace.projectFolder, workspace.place);
    const command = adapter.buildCommand({ ...spawnOptions(workspace, CLI_NAME), resume: true, sessionId: undefined });
    await sync?.push();
    expect(command).not.toContain('--resume');
  });
});
