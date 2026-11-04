/**
 * A Cursor CLI on a remote host over SSH (#913), run through the real adapter code and the real file
 * sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). It proves the files, command and
 * probe calls Kangentic builds, not that Cursor accepts them on a real machine.
 *
 * What a user loses if a test here fails:
 * - the MCP test: the agent has no Kangentic tools on the host, the user's own `.cursor/mcp.json`
 *   servers are overwritten or an unreadable file is rewritten, or a path of this computer reaches the
 *   host inside the file.
 * - the create-chat test: an interactive session on a host opens a chat id made by a Cursor on this
 *   computer, which the host's Cursor does not know, so the start fails.
 * - the release test: Kangentic's entry stays in the user's `.cursor/mcp.json` after the session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorAdapter } from '../../src/main/agent/adapters/cursor';
import { CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY } from '../../src/main/agent/adapters/cursor/answer-workspace';
import { cursorTranscriptFilePath } from '../../src/main/agent/adapters/cursor/session-paths';
import { pullHostFilesFor, rememberHostFileSync, settleHostFiles } from '../../src/main/remote/host-file-sync';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

const TOKEN = 'cursor-ssh-token-0123456789';
const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1/session-1';
const SESSION_ID = 'session-1';
const CHAT_ID = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
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
const mcpPath = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.cursor/mcp.json`;

function spawnOptions(workspace: FakeSshWorkspace): SpawnCommandOptions {
  const sessionDirectory = path.join(workspace.projectFolder, '.kangentic', 'sessions', SESSION_ID);
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: 'cursor-agent',
    taskId: 'task-1',
    cwd: workspace.projectFolder,
    permissionMode: 'default',
    shell: 'bash',
    prompt: 'fix the bug',
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: SESSION_ID,
    cliTarget: { ...workspace.place, linuxCliPath: 'cursor-agent' },
  };
}

async function spawnOnHost(adapter: CursorAdapter, workspace: FakeSshWorkspace): Promise<{ command: string; env: Record<string, string> | null }> {
  const sync = await pullHostFilesFor(adapter, workspace.projectFolder, workspace.place);
  if (!sync) throw new Error('the adapter declared no host files');
  await adapter.ensureTrust(workspace.projectFolder);
  const options = spawnOptions(workspace);
  const command = adapter.buildCommand(options);
  const env = adapter.buildEnv ? adapter.buildEnv(options) : null;
  await sync.push();
  rememberHostFileSync(SESSION_ID, sync);
  return { command, env };
}

describe('a Cursor session on a remote host', () => {
  it('declares the CLI name and the files it edits', () => {
    const adapter = new CursorAdapter();
    expect(adapter.remoteCliName).toBe('cursor-agent');
    expect(adapter.remoteFiles()).toEqual({
      home: [],
      project: ['.cursor/mcp.json', '.cursor/hooks.json', '.kangentic/cursor-wsl-hook.sh'],
    });
  });

  it('puts the activity hooks on the host, running the folder\'s script copy there, and takes them out on release', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(`${workspace.hostProject}/.cursor/hooks.json`, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo mine' }] } }));
    const adapter = new CursorAdapter();
    await spawnOnHost(adapter, workspace);

    const hooksPath = `${workspace.hostProject}/.cursor/hooks.json`;
    const hooks = JSON.parse(workspace.host.files.get(hooksPath) ?? '{}') as { hooks: Record<string, Array<{ command: string }>> };
    expect(hooks.hooks.stop.some((entry) => entry.command === 'echo mine')).toBe(true);
    const ours = hooks.hooks.stop.find((entry) => entry.command !== 'echo mine');
    expect(ours?.command).toContain(`${workspace.hostProject}/.kangentic/cursor-wsl-hook.sh`);
    expect(workspace.host.files.has(`${workspace.hostProject}/.kangentic/cursor-wsl-hook.sh`)).toBe(true);
    expect(workspace.host.modes.get(`${workspace.hostProject}/.kangentic/cursor-wsl-hook.sh`)).toBe(0o755);

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(JSON.parse(workspace.host.files.get(hooksPath) ?? '{}')).toEqual({ version: 1, hooks: { stop: [{ command: 'echo mine' }] } });
  });

  it('merges the static bridge entry into the user\'s file; the host paths and secrets ride the environment only', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(mcpPath(workspace), JSON.stringify(USER_MCP));
    const { command, env } = await spawnOnHost(new CursorAdapter(), workspace);

    expect(command.startsWith('cursor-agent --approve-mcps')).toBe(true);
    const written = JSON.parse(workspace.host.files.get(mcpPath(workspace)) ?? '{}') as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers.docs).toEqual(USER_MCP.mcpServers.docs);
    expect(written.mcpServers.kangentic).toEqual(CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY);
    expect(env).toEqual({
      // The flag the hook commands test before they publish, as for a distro.
      KANGENTIC_EVENTS_PATH_INTERACTIVE: '1',
      KANGENTIC_MCP_URL: MCP_URL,
      KANGENTIC_MCP_TOKEN: TOKEN,
      KANGENTIC_MCP_BRIDGE_SCRIPT: `${workspace.hostProject}/.kangentic/sessions/${SESSION_ID}/wsl-hooks/wsl-hook.sh`,
    });
    for (const [hostPath, content] of workspace.host.files) {
      expect(content, hostPath).not.toContain(TOKEN);
      for (const local of [workspace.projectFolder, workspace.mirrorHome, os.tmpdir()]) {
        expect(content, hostPath).not.toContain(local);
        expect(content, hostPath).not.toContain(local.replace(/\\/g, '/'));
        expect(content, hostPath).not.toContain(local.replace(/\\/g, '\\\\'));
      }
    }
  });

  it('leaves a file it cannot parse exactly as the user wrote it, and starts without the MCP approval flag', async () => {
    const workspace = await newWorkspace();
    const withComment = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    workspace.host.files.set(mcpPath(workspace), withComment);
    const { command } = await spawnOnHost(new CursorAdapter(), workspace);
    expect(workspace.host.files.get(mcpPath(workspace))).toBe(withComment);
    expect(command).not.toContain('--approve-mcps');
  });

  it('creates the file when the host has none, keeps it out of the host\'s git status, and removes it on release', async () => {
    const workspace = await newWorkspace();
    workspace.host.directories.add(`${workspace.hostProject}/.git/info`);
    const adapter = new CursorAdapter();
    await spawnOnHost(adapter, workspace);
    expect(workspace.host.files.has(mcpPath(workspace))).toBe(true);
    expect(workspace.host.files.get(`${workspace.hostProject}/.git/info/exclude`) ?? '').toContain('/.cursor/mcp.json');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(mcpPath(workspace))).toBe(false);
  });

  it('puts the user\'s own servers back when the session releases', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(mcpPath(workspace), JSON.stringify(USER_MCP));
    const adapter = new CursorAdapter();
    await spawnOnHost(adapter, workspace);

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(JSON.parse(workspace.host.files.get(mcpPath(workspace)) ?? '{}')).toEqual(USER_MCP);
  });

  it('makes the new chat on the host, in the project\'s folder there', async () => {
    const workspace = await newWorkspace();
    workspace.host.commandResults.set('cursor-agent', () => ({ code: 0, stdout: `${CHAT_ID}\n`, stderr: '', timedOut: false }));
    const created = await new CursorAdapter().createSessionId('cursor-agent', workspace.projectFolder, workspace.place);
    expect(created).toBe(CHAT_ID);
    expect(workspace.host.commands).toHaveLength(1);
    expect(workspace.host.commands[0].file).toBe('cursor-agent');
    expect(workspace.host.commands[0].args).toEqual(['create-chat']);
    expect(workspace.host.commands[0].cwd).toBe(workspace.hostProject);
  });

  it('starts without a chat id when the host cannot make one', async () => {
    const workspace = await newWorkspace();
    expect(await new CursorAdapter().createSessionId('cursor-agent', workspace.projectFolder, workspace.place)).toBeNull();
    workspace.host.commandResults.set('cursor-agent', () => ({ code: 1, stdout: '', stderr: 'not logged in', timedOut: false }));
    expect(await new CursorAdapter().createSessionId('cursor-agent', workspace.projectFolder, workspace.place)).toBeNull();
  });

  it('derives the transcript folder from the working directory as the host names it', async () => {
    const workspace = await newWorkspace();
    const transcript = cursorTranscriptFilePath(workspace.projectFolder, CHAT_ID, workspace.place);
    expect(transcript).toBe(path.join(workspace.mirrorHome, '.cursor', 'projects', 'home-dev-app', 'agent-transcripts', CHAT_ID, `${CHAT_ID}.jsonl`));
    // The mirror holds no transcript, so a read finds nothing and does not wait.
    expect(await new CursorAdapter().locateSessionHistoryFile(CHAT_ID, workspace.projectFolder, workspace.place)).toBeNull();
  });
});
