/**
 * An OpenCode on a remote host over SSH (#913), run through the real adapter code, the real file sync
 * and the real activity plugin against a fake host (tests/unit/helpers/fake-ssh-host.ts). It proves the
 * files, command and records Kangentic builds, not that OpenCode accepts them on a real machine.
 *
 * What a user loses if a test here fails:
 * - the plugin file tests: the board shows no activity for an OpenCode task on the host (no turn ends,
 *   no waits on the user), or the plugin of the wrong major is installed and OpenCode never loads it.
 * - the command tests: OpenCode 2 on the host is handed OpenCode 1 flags it rejects, or its MCP bridge
 *   names a path of this computer.
 * - the record tests: the plugin's events never reach the host's hook folder, so the helper has
 *   nothing to send back, or reach it in a shape Kangentic reads differently from a direct append.
 * - the release test: Kangentic's plugin stays in the user's repository on the host after the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import { resolvePluginScript } from '../../src/main/agent/shared/bridge-utils';
import { pullHostFilesFor, rememberHostFileSync, settleHostFiles } from '../../src/main/remote/host-file-sync';
import { prepareWslHookTransport, wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { WslHookInbox } from '../../src/main/pty/readers/wsl-hook-inbox';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import { makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';

const TOKEN = 'opencode-ssh-token-0123456789';
const MCP_URL = 'http://127.0.0.1:47123/mcp/project-1/session-1';
const SESSION_ID = 'session-1';
const workspaces: FakeSshWorkspace[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function newWorkspace(hostVersionOutput: string | null): Promise<FakeSshWorkspace> {
  const workspace = await makeFakeSshWorkspace();
  workspaces.push(workspace);
  if (hostVersionOutput !== null) {
    workspace.host.commandResults.set('opencode', () => ({ code: 0, stdout: hostVersionOutput, stderr: '', timedOut: false }));
  }
  return workspace;
}

function spawnOptions(workspace: FakeSshWorkspace): SpawnCommandOptions {
  const sessionDirectory = path.join(workspace.projectFolder, '.kangentic', 'sessions', SESSION_ID);
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return {
    agentPath: 'opencode',
    taskId: 'task-1',
    cwd: workspace.projectFolder,
    projectRoot: workspace.projectFolder,
    permissionMode: 'acceptEdits',
    shell: 'bash',
    prompt: 'fix the bug',
    eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    mcpServerEnabled: true,
    mcpServerUrl: MCP_URL,
    mcpServerToken: TOKEN,
    ptySessionId: SESSION_ID,
    cliTarget: { ...workspace.place, linuxCliPath: 'opencode' },
  };
}

async function spawnOnHost(adapter: OpenCodeAdapter, workspace: FakeSshWorkspace): Promise<{ command: string; env: Record<string, string> | null }> {
  const sync = await pullHostFilesFor(adapter, workspace.projectFolder, workspace.place);
  if (!sync) throw new Error('the adapter declared no host files');
  await adapter.ensureTrust(workspace.projectFolder, workspace.place);
  const options = spawnOptions(workspace);
  const command = adapter.buildCommand(options);
  const env = adapter.buildEnv(options);
  await sync.push();
  rememberHostFileSync(SESSION_ID, sync);
  return { command, env };
}

const v1PluginPath = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.opencode/plugins/kangentic-activity.js`;
const v2PluginPath = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.opencode/plugins/kangentic-activity/index.js`;
const sourceOf = (name: string): string => fs.readFileSync(resolvePluginScript('opencode', name), 'utf8');

describe('an OpenCode 1 session on a remote host', () => {
  it('declares the CLI name and both plugin layouts', () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.remoteCliName).toBe('opencode');
    expect(adapter.remoteFiles()).toEqual({
      home: [],
      project: ['.opencode/plugins/kangentic-activity.js', '.opencode/plugins/kangentic-activity/index.js'],
    });
  });

  it('installs the OpenCode 1 plugin on the host and nothing for OpenCode 2', async () => {
    const workspace = await newWorkspace('1.18.31\n');
    const { command } = await spawnOnHost(new OpenCodeAdapter(), workspace);

    expect(workspace.host.commands[0].args).toEqual(['--version']);
    expect(workspace.host.commands[0].file).toBe('opencode');
    expect(command).toContain('--agent build');
    expect(command).not.toContain('--standalone');
    expect(workspace.host.files.get(v1PluginPath(workspace))).toBe(sourceOf('kangentic-activity'));
    expect(workspace.host.files.get(v1PluginPath(workspace))?.split('\n')[0]).toBe('// kangentic-activity');
    expect(workspace.host.files.has(v2PluginPath(workspace))).toBe(false);
    expect(workspace.host.modes.get(v1PluginPath(workspace))).toBe(0o644);
  });

  it('gives the MCP bridge on the host path through the environment, and sends nothing of this computer', async () => {
    const workspace = await newWorkspace('1.18.31');
    const { env } = await spawnOnHost(new OpenCodeAdapter(), workspace);

    const config = JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}') as { mcp: { kangentic: unknown } };
    expect(config.mcp.kangentic).toEqual({
      type: 'local',
      command: ['sh', `${workspace.hostProject}/.kangentic/sessions/${SESSION_ID}/wsl-hooks/wsl-hook.sh`, 'mcp', MCP_URL],
      environment: { KANGENTIC_MCP_TOKEN: TOKEN },
      enabled: true,
    });
    const pushed = [...workspace.host.files.values(), env?.OPENCODE_CONFIG_CONTENT ?? ''];
    for (const content of pushed) {
      for (const local of [workspace.projectFolder, workspace.mirrorHome, os.tmpdir()]) {
        expect(content).not.toContain(local);
        expect(content).not.toContain(local.replace(/\\/g, '/'));
        expect(content).not.toContain(local.replace(/\\/g, '\\\\'));
      }
    }
  });

  it('removes the plugin from the host when the session releases, leaving the user\'s other plugins', async () => {
    const workspace = await newWorkspace('1.18.31');
    const adapter = new OpenCodeAdapter();
    await spawnOnHost(adapter, workspace);
    expect(workspace.host.files.has(v1PluginPath(workspace))).toBe(true);

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(v1PluginPath(workspace))).toBe(false);
  });

  it('starts with OpenCode 1 flags when the host\'s version cannot be read', async () => {
    const workspace = await newWorkspace(null);
    const { command } = await spawnOnHost(new OpenCodeAdapter(), workspace);
    expect(command).toContain('--agent build');
    expect(workspace.host.files.has(v1PluginPath(workspace))).toBe(true);
  });
});

describe('an OpenCode 2 session on a remote host', () => {
  it('uses the OpenCode 2 command line and plugin layout', async () => {
    const workspace = await newWorkspace('opencode v2.2.5\n');
    const { command, env } = await spawnOnHost(new OpenCodeAdapter(), workspace);

    expect(command.startsWith('opencode --standalone')).toBe(true);
    expect(command).not.toContain('--agent');
    expect(JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({ default_agent: 'build' });
    expect(workspace.host.files.get(v2PluginPath(workspace))).toBe(sourceOf('kangentic-activity-v2'));
    expect(workspace.host.files.has(v1PluginPath(workspace))).toBe(false);
  });

  it('removes its plugin on release', async () => {
    const workspace = await newWorkspace('opencode v2.2.5');
    const adapter = new OpenCodeAdapter();
    await spawnOnHost(adapter, workspace);
    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);
    expect(workspace.host.files.has(v2PluginPath(workspace))).toBe(false);
  });
});

/** Events as the plugin builds them, covering every shape it publishes. */
const PLUGIN_EVENTS = [
  { ts: 1717000000000, type: 'session_start', hookContext: JSON.stringify({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' }) },
  { ts: 1717000000001, type: 'prompt' },
  { ts: 1717000000002, type: 'tool_start', tool: 'bash', detail: 'ls -la "my folder"' },
  { ts: 1717000000003, type: 'tool_end', tool: 'bash' },
  { ts: 1717000000004, type: 'idle', detail: 'permission', waitKind: 'question' },
  { ts: 1717000000005, type: 'notification', detail: 'question.replied' },
  { ts: 1717000000006, type: 'idle' },
  { ts: 1717000000007, type: 'idle', detail: 'error' },
];

interface PluginHelpers {
  publishToHookDirectory(directory: string, event: unknown, now?: number): void;
  hookRecordFor(event: unknown): string;
}

async function loadHelpers(which: 'v1' | 'v2'): Promise<PluginHelpers> {
  if (which === 'v1') {
    const module = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs');
    return module.KangenticActivity.helpers as unknown as PluginHelpers;
  }
  const module = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity-v2.mjs');
  return module.default.helpers as unknown as PluginHelpers;
}

function newSessionDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-inbox-'));
  temporaryDirectories.push(directory);
  prepareWslHookTransport(directory);
  return directory;
}

/** What Kangentic appends to events.jsonl for the records in a session folder, read by the real inbox. */
function eventsFromInbox(sessionDirectory: string): unknown[] {
  const eventsOutputPath = path.join(sessionDirectory, 'events.jsonl');
  const inbox = new WslHookInbox({ sessionDirectory, eventsOutputPath, onAppended: () => undefined });
  inbox.start();
  inbox.drainSync();
  inbox.close();
  if (!fs.existsSync(eventsOutputPath)) return [];
  return fs.readFileSync(eventsOutputPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

describe.each(['v1', 'v2'] as const)('the %s activity plugin on a host with only a hook folder', (which) => {
  it('publishes each event as a record Kangentic reads back as the event it would have appended', async () => {
    const helpers = await loadHelpers(which);
    const sessionDirectory = newSessionDirectory();
    const hookDirectory = wslHookPaths(sessionDirectory).directory;
    for (const event of PLUGIN_EVENTS) helpers.publishToHookDirectory(hookDirectory, event, event.ts);

    expect(eventsFromInbox(sessionDirectory)).toEqual(PLUGIN_EVENTS);
  });

  it('names records like the hook script does, leaves no staging file, and signals the watcher', async () => {
    const helpers = await loadHelpers(which);
    const sessionDirectory = newSessionDirectory();
    const paths = wslHookPaths(sessionDirectory);
    helpers.publishToHookDirectory(paths.directory, PLUGIN_EVENTS[2], PLUGIN_EVENTS[2].ts);
    helpers.publishToHookDirectory(paths.directory, PLUGIN_EVENTS[3], PLUGIN_EVENTS[3].ts);

    const names = fs.readdirSync(paths.inbox);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^\d{19}-\d+\.rec$/);
    expect(fs.readFileSync(paths.signal, 'utf8')).toBe('xx');
    // A record is the format's header, the event type, the directives line, then the hook's stdin.
    const first = fs.readFileSync(path.join(paths.inbox, names.slice().sort()[0]), 'utf8').split('\n');
    expect(first[0]).toBe('K1');
    expect(first[1]).toBe('tool_start');
  });

  it('keeps events in order when several share one millisecond', async () => {
    const helpers = await loadHelpers(which);
    const sessionDirectory = newSessionDirectory();
    const hookDirectory = wslHookPaths(sessionDirectory).directory;
    const sameMillisecond = [
      { ts: 1717000000100, type: 'tool_start', tool: 'read', detail: 'a.ts' },
      { ts: 1717000000100, type: 'tool_end', tool: 'read' },
      { ts: 1717000000100, type: 'idle' },
    ];
    for (const event of sameMillisecond) helpers.publishToHookDirectory(hookDirectory, event, event.ts);
    expect(eventsFromInbox(sessionDirectory)).toEqual(sameMillisecond);
  });
});

describe('the v1 plugin module with the spawn\'s environment', () => {
  const savedEvents = process.env.KANGENTIC_EVENTS_PATH;
  const savedHookDirectory = process.env.KANGENTIC_WSL_HOOK_DIR;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEvents === undefined) delete process.env.KANGENTIC_EVENTS_PATH;
    else process.env.KANGENTIC_EVENTS_PATH = savedEvents;
    if (savedHookDirectory === undefined) delete process.env.KANGENTIC_WSL_HOOK_DIR;
    else process.env.KANGENTIC_WSL_HOOK_DIR = savedHookDirectory;
    vi.resetModules();
  });

  async function runSessionCreated(): Promise<void> {
    const { KangenticActivity } = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs');
    const hooks = await (KangenticActivity as unknown as () => Promise<{
      event: (payload: { event: unknown }) => Promise<void>;
      'tool.execute.before': (input: unknown, output: unknown) => Promise<void>;
    }>)();
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_2349b5c91ffeKd6qajuUTR4clq' } } } });
    await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'ls' } });
  }

  it('on a host (hook folder, no events path) publishes records and captures the session id', async () => {
    const sessionDirectory = newSessionDirectory();
    delete process.env.KANGENTIC_EVENTS_PATH;
    process.env.KANGENTIC_WSL_HOOK_DIR = wslHookPaths(sessionDirectory).directory;
    await runSessionCreated();

    const events = eventsFromInbox(sessionDirectory) as Array<{ type: string; hookContext?: string; tool?: string; detail?: string }>;
    expect(events.map((event) => event.type)).toEqual(['session_start', 'tool_start']);
    expect(JSON.parse(events[0].hookContext ?? '{}')).toEqual({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' });
    expect(events[1]).toMatchObject({ tool: 'bash', detail: 'ls' });
  });

  it('with an events path (this computer, or a WSL distro) still appends to the events file and publishes nothing', async () => {
    const sessionDirectory = newSessionDirectory();
    const eventsPath = path.join(sessionDirectory, 'direct-events.jsonl');
    process.env.KANGENTIC_EVENTS_PATH = eventsPath;
    process.env.KANGENTIC_WSL_HOOK_DIR = wslHookPaths(sessionDirectory).directory;
    await runSessionCreated();

    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    expect(lines.map((line) => line.type)).toEqual(['session_start', 'tool_start']);
    expect(fs.readdirSync(wslHookPaths(sessionDirectory).inbox)).toEqual([]);
  });

  it('with neither variable does nothing and does not throw', async () => {
    delete process.env.KANGENTIC_EVENTS_PATH;
    delete process.env.KANGENTIC_WSL_HOOK_DIR;
    await expect(runSessionCreated()).resolves.toBeUndefined();
  });
});

describe('the v2 plugin module with a hook folder', () => {
  const savedEvents = process.env.KANGENTIC_EVENTS_PATH;
  const savedHookDirectory = process.env.KANGENTIC_WSL_HOOK_DIR;

  afterEach(() => {
    if (savedEvents === undefined) delete process.env.KANGENTIC_EVENTS_PATH;
    else process.env.KANGENTIC_EVENTS_PATH = savedEvents;
    if (savedHookDirectory === undefined) delete process.env.KANGENTIC_WSL_HOOK_DIR;
    else process.env.KANGENTIC_WSL_HOOK_DIR = savedHookDirectory;
    vi.resetModules();
  });

  it('sets up on a host with no events path and publishes a turn\'s events', async () => {
    vi.resetModules();
    const sessionDirectory = newSessionDirectory();
    delete process.env.KANGENTIC_EVENTS_PATH;
    process.env.KANGENTIC_WSL_HOOK_DIR = wslHookPaths(sessionDirectory).directory;
    const module = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity-v2.mjs');
    const plugin = module.default as unknown as { setup(context: unknown): Promise<(() => void) | undefined> };

    const hooks = new Map<string, (hookEvent: unknown) => void>();
    const context = {
      event: {
        subscribe: async function* subscribe(): AsyncGenerator<unknown> {
          yield { type: 'session.execution.started', data: { sessionID: 'ses_v2_0123456789abcdef' } };
          yield { type: 'session.execution.succeeded', data: { sessionID: 'ses_v2_0123456789abcdef' } };
        },
      },
      tool: { hook: async (name: string, handler: (hookEvent: unknown) => void) => { hooks.set(name, handler); } },
    };
    const cleanup = await plugin.setup(context);
    expect(typeof cleanup).toBe('function');
    hooks.get('execute.before')?.({ tool: 'bash', input: { command: 'ls' } });

    // The subscription runs on its own; wait for the four records without consuming them.
    const inboxFolder = wslHookPaths(sessionDirectory).inbox;
    await expect.poll(() => fs.readdirSync(inboxFolder).filter((name) => name.endsWith('.rec')).length, { timeout: 5000 }).toBe(4);
    cleanup?.();
    const types = (eventsFromInbox(sessionDirectory) as Array<{ type: string }>).map((event) => event.type).sort();
    expect(types).toEqual(['idle', 'prompt', 'session_start', 'tool_start']);
  });
});
