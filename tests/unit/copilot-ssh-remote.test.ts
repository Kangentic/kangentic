/**
 * A GitHub Copilot CLI on a remote host over SSH (#913), run through the real host-file pull, the real
 * command builder and the real session relay against a fake host (tests/unit/helpers/fake-ssh-host.ts).
 * Verified only against that fake: nothing here has met a real Copilot or a real host.
 *
 * What a user loses if it breaks: a Copilot on the host that starts with this computer's paths in
 * `--config-dir`, a hooks file or an MCP config that never reaches the host (no activity, no Kangentic
 * tools), or a host without the signed-in account copied into the session's config home.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopilotAdapter, COPILOT_REMOTE_SESSION_FILES } from '../../src/main/agent/adapters/copilot/copilot-adapter';
import { RemoteSessionRelay, type RemoteSessionFiles } from '../../src/main/remote/remote-session-relay';
import type { HostFileWrite } from '../../src/main/remote/protocol/messages';
import { quoteArg, toForwardSlash } from '../../src/shared/paths';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';
import { MCP_TOKEN, SESSION_ID, sessionFolders, spawnOnHost, type HostSpawn } from './ssh-adapter-spawn-harness';

const SHELL = 'bash';
let workspace: FakeSshWorkspace;
let relays: RemoteSessionRelay[];

beforeEach(async () => {
  workspace = await makeFakeSshWorkspace();
  relays = [];
  workspace.host.files.set('/home/dev/.copilot/config.json', JSON.stringify({ logged_in_users: [{ login: 'host-user' }] }));
  workspace.host.files.set('/home/dev/.copilot/settings.json', JSON.stringify({ theme: 'dark' }));
  workspace.host.files.set('/home/dev/.copilot/mcp-config.json', JSON.stringify({ mcpServers: { own: { type: 'http', url: 'http://host.example/mcp' } } }));
});

afterEach(async () => {
  for (const relay of relays) relay.dispose();
  await workspace.dispose();
});

const sessionDirectory = (): string => sessionFolders(workspace).local;
const hostSessionDirectory = (): string => sessionFolders(workspace).host;

/** Every file under a folder, relative with forward slashes. */
function listFiles(root: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(root, relative));
    else found.push(relative);
  }
  return found;
}

/**
 * What differs from the harness's defaults: a URL that names no task session, so the builder adds no
 * background-shell hint hook and every hook below is an `event` one.
 */
const COPILOT_OVERRIDES = { mcpServerEnabled: true, mcpServerUrl: 'http://127.0.0.1:4000/mcp/project-1' } as const;

/** One spawn as the chokepoints run it. Copilot's session files are copied by the relay, so the host's account, settings and MCP servers are pulled and nothing is pushed into its own ~/.copilot. */
function prepare(adapter: CopilotAdapter): Promise<HostSpawn> {
  return spawnOnHost(adapter, workspace, 'copilot', COPILOT_OVERRIDES);
}

describe('a Copilot on a remote host: the files it declares', () => {
  it('is the host\'s own CLI by name, and pulls the account, settings and MCP servers into the mirror', async () => {
    const adapter = new CopilotAdapter();
    expect(adapter.remoteCliName).toBe('copilot');

    await prepare(adapter);

    for (const name of ['config.json', 'settings.json', 'mcp-config.json']) {
      expect(fs.readFileSync(path.join(workspace.mirrorHome, '.copilot', name), 'utf-8')).toBe(workspace.host.files.get(`/home/dev/.copilot/${name}`));
    }
  });

  it('seeds the session\'s config home from the pulled copies and pushes nothing into the host\'s own ~/.copilot', async () => {
    const adapter = new CopilotAdapter();
    await prepare(adapter);

    const configHome = path.join(sessionDirectory(), 'copilot-config');
    const config = JSON.parse(fs.readFileSync(path.join(configHome, 'config.json'), 'utf-8')) as { logged_in_users?: unknown; banner?: string; statusLine?: { command: string } };
    expect(config.logged_in_users).toEqual([{ login: 'host-user' }]);
    expect(config.banner).toBe('never');
    expect(config.statusLine?.command).toBe(`sh "${hostSessionDirectory()}/wsl-hooks/wsl-hook.sh" status "${hostSessionDirectory()}/status.json"`);
    expect(fs.readFileSync(path.join(configHome, 'mcp-config.json'), 'utf-8')).toBe(workspace.host.files.get('/home/dev/.copilot/mcp-config.json'));
    expect(workspace.host.writes).toEqual([]);
    expect(workspace.host.removals).toEqual([]);
  });

  it('seeds nothing on this computer for a resume: it would sit under the copy the host then sends, and leave stale bytes after it', async () => {
    const adapter = new CopilotAdapter();
    const agentSessionId = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
    const earlierCopy = path.join(workspace.projectFolder, '.kangentic', 'sessions', 'earlier', 'copilot-config', 'session-state', agentSessionId, 'events.jsonl');
    fs.mkdirSync(path.dirname(earlierCopy), { recursive: true });
    fs.writeFileSync(earlierCopy, '{"type":"session.start"}\n');

    await spawnOnHost(adapter, workspace, 'copilot', { ...COPILOT_OVERRIDES, resume: true, sessionId: agentSessionId });

    expect(fs.existsSync(path.join(sessionDirectory(), 'copilot-config', 'session-state', agentSessionId))).toBe(false);
  });
});

describe('a Copilot on a remote host: the command', () => {
  it('names the config home and the MCP config by the host\'s paths, never this computer\'s', async () => {
    const { command } = await prepare(new CopilotAdapter());

    expect(command.startsWith('copilot ')).toBe(true);
    expect(command).toContain(`--config-dir ${quoteArg(`${hostSessionDirectory()}/copilot-config`, SHELL)}`);
    expect(command).toContain(`--additional-mcp-config ${quoteArg(`@${hostSessionDirectory()}/copilot-mcp.json`, SHELL)}`);
    expect(command).not.toContain(toForwardSlash(workspace.projectFolder));
    expect(command).not.toContain(toForwardSlash(os.tmpdir()));
    expect(command).not.toContain(MCP_TOKEN);
  });

  it('runs every hook through the transport script on the host, and gives the host no URL to dial', async () => {
    await prepare(new CopilotAdapter());
    const script = `${hostSessionDirectory()}/wsl-hooks/wsl-hook.sh`;

    const hooksFile = JSON.parse(fs.readFileSync(path.join(sessionDirectory(), 'copilot-config', 'hooks', 'kangentic.json'), 'utf-8')) as { hooks: Record<string, Array<{ command: string }>> };
    const commands = Object.values(hooksFile.hooks).flatMap((entries) => entries.map((entry) => entry.command));
    expect(commands.length).toBeGreaterThan(3);
    for (const command of commands) {
      expect(command.startsWith(`sh "${script}" event `)).toBe(true);
      expect(command).not.toContain('node ');
      expect(command).not.toContain(toForwardSlash(workspace.projectFolder));
    }

    const mcpText = fs.readFileSync(path.join(sessionDirectory(), 'copilot-mcp.json'), 'utf-8');
    const mcp = JSON.parse(mcpText) as { mcpServers: { kangentic: { type: string; command: string; args: string[] } } };
    expect(mcp.mcpServers.kangentic.type).toBe('stdio');
    expect(mcp.mcpServers.kangentic.command).toBe('sh');
    expect(mcp.mcpServers.kangentic.args[0]).toBe(script);
    expect(mcpText).not.toContain('X-Kangentic-Token');
  });
});

describe('a Copilot on a remote host: what the relay pushes', () => {
  it('declares exactly the files the builder wrote in the session folder, beyond the relay\'s own three', async () => {
    const adapter = new CopilotAdapter();
    await prepare(adapter);

    const written = listFiles(sessionDirectory()).filter((relative) => !relative.startsWith('wsl-hooks/'));
    expect([...(adapter.remoteSessionFiles()).slice()].sort()).toEqual(written.sort());
    expect(adapter.remoteSessionFiles()).toBe(COPILOT_REMOTE_SESSION_FILES);
  });

  it('writes each declared file to the same place on the host, owner-only, with the host\'s account and no local path', async () => {
    const adapter = new CopilotAdapter();
    await prepare(adapter);

    const pushed: HostFileWrite[] = [];
    const files: RemoteSessionFiles = {
      writeFiles: async (_hostId, batch) => { pushed.push(...batch); return undefined; },
      writeFileRaw: async () => undefined,
      watchHooks: async () => undefined,
      unwatchHooks: async () => undefined,
      removeFiles: async () => undefined,
      removeEmptyDirectories: async () => undefined,
    };
    const relay = new RemoteSessionRelay({ files });
    relays.push(relay);
    await relay.register({
      hostId: 'host-1',
      sessionId: SESSION_ID,
      place: workspace.place,
      localSessionDirectory: sessionDirectory(),
      statusOutputPath: path.join(sessionDirectory(), 'status.json'),
      extraFiles: adapter.remoteSessionFiles(),
    });
    await relay.release(SESSION_ID);

    const byPath = new Map(pushed.map((file) => [file.path, file]));
    for (const relative of adapter.remoteSessionFiles()) {
      const file = byPath.get(`${hostSessionDirectory()}/${relative}`);
      expect(file, relative).toBeDefined();
      expect(file?.mode).toBe(0o600);
      expect(file?.content).not.toContain(toForwardSlash(workspace.projectFolder));
      expect(file?.content).not.toContain(toForwardSlash(os.tmpdir()));
    }
    expect(byPath.get(`${hostSessionDirectory()}/copilot-config/config.json`)?.content).toContain('host-user');
    expect(byPath.get(`${hostSessionDirectory()}/wsl-hooks/wsl-hook.sh`)?.mode).toBe(0o755);
    for (const file of pushed) expect(file.path.startsWith(`${hostSessionDirectory()}/`)).toBe(true);
  });
});
