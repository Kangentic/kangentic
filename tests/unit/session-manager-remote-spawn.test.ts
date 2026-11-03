/**
 * An agent session on a remote host, through the whole path (#913): a real `SessionManager` spawns it,
 * `performSpawn` registers it with the relay and starts the PTY through the pty host's router, the
 * router sends it to the link hub, the link carries it to a real helper (the host's side, with a fake
 * PTY), and the hook files the host publishes come back through the relay into the real hook inbox.
 *
 * What a user loses if it breaks: a remote agent that never starts, one that starts with no hooks (no
 * activity, no plan approval, no MCP), or one whose last events are lost when it exits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import type { PtyHostCommand, PtyHostEvent, PtyHostMethod, PtyHostRequestMap, RendererPort } from '../../src/main/pty/host/protocol';
import type { PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import { HostRouter } from '../../src/main/remote/host-router';
import { RemoteHostService } from '../../src/main/remote/remote-host-service';
import { RemoteSessionRelay } from '../../src/main/remote/remote-session-relay';
import { prepareWslHookTransport } from '../../src/main/agent/shared/wsl-hook-transport';
import { toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { dialHelper, makeHelperRig, type HelperRig } from './helpers/remote-link-rig';

const teardown: Array<() => void> = [];
let scratch: string;
let shellFolder: string;
let hostHome: string;
let hostProject: string;

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface Rig {
  manager: SessionManager;
  helperRig: HelperRig;
  relay: RemoteSessionRelay;
  place: SshCliPlace;
  localSession: string;
  hostSession: string;
  eventsPath: string;
  statusPath: string;
}

/** The pty host as main sees it, with the router in front of a real core, in this process. */
function routedTransport(router: HostRouter, listenerRef: { current: ((event: PtyHostEvent) => void) | null }): PtyHostTransport {
  return {
    hostPid: null,
    post: (command: PtyHostCommand) => router.handleCommand(command),
    attachRendererPort: (rendererId: number, port: RendererPort) => router.attachRendererPort(rendererId, port),
    request: <M extends PtyHostMethod>(method: M, params: PtyHostRequestMap[M]['params']) => router.handleRequest(method, params),
    setEventListener: (listener) => { listenerRef.current = listener; },
    shutdown: () => undefined,
  };
}

async function makeRig(): Promise<Rig> {
  const helperRig = makeHelperRig(1, { homeDirectory: hostHome, baseEnv: { SHELL: '/bin/zsh' } });
  const listenerRef: { current: ((event: PtyHostEvent) => void) | null } = { current: null };
  const emit = (event: PtyHostEvent): void => listenerRef.current?.(event);
  const core = new PtyHostCore({ emit, resolveAgent: () => undefined, transcriptSinkFor: () => null, coalesceMs: 0, platform: 'linux', spawnPty: vi.fn() as never });
  const router = new HostRouter({
    core,
    emit,
    connectTo: () => async () => dialHelper(helperRig),
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  });
  teardown.push(() => router.hub.removeHost('host-a'), () => helperRig.helper.dispose());

  const manager = new SessionManager({ ptyHostTransport: routedTransport(router, listenerRef) });
  teardown.push(() => manager.killAll());

  const service = new RemoteHostService({
    sshPath: 'ssh',
    hosts: { getById: () => undefined, list: () => [] },
    send: (request) => router.handleRequest('remote', request),
    asset: () => null,
    identity: { installId: 'install-a', label: 'a test computer' },
  });
  await router.handleRequest('remote', {
    op: 'addHost',
    hostId: 'host-a',
    connection: { sshPath: 'ssh', args: ['host-a'], remoteCommand: 'relay', installId: 'install-a', label: 'a test computer' },
  });
  await service.hostInfo('host-a');

  const relay = new RemoteSessionRelay({ files: service });
  manager.setRemoteSessionRelay(relay);

  const place: SshCliPlace = {
    kind: 'ssh',
    hostId: 'host-a',
    home: hostHome.replace(/\\/g, '/'),
    shellName: 'zsh',
    localHome: path.join(scratch, 'mirror'),
    roots: [{ local: shellFolder, host: hostProject.replace(/\\/g, '/') }],
    linuxCliPath: 'claude',
  };
  const localSession = path.join(shellFolder, '.kangentic', 'sessions', 's1');
  fs.mkdirSync(localSession, { recursive: true });
  prepareWslHookTransport(localSession);
  fs.writeFileSync(path.join(localSession, 'settings.json'), '{"hooks":{}}');
  return {
    manager,
    helperRig,
    relay,
    place,
    localSession,
    hostSession: path.join(hostProject, '.kangentic', 'sessions', 's1'),
    eventsPath: path.join(localSession, 'events.jsonl'),
    statusPath: path.join(localSession, 'status.json'),
  };
}

function spawnRemote(rig: Rig) {
  return rig.manager.spawn({
    id: 's1',
    taskId: 'task-1',
    projectId: 'project-1',
    command: 'claude --session-id abc',
    cwd: shellFolder,
    statusOutputPath: rig.statusPath,
    eventsOutputPath: rig.eventsPath,
    exitSequence: ['\x03'],
    shell: 'zsh',
    cliTarget: toStoredCliTarget(rig.place),
    remote: { hostId: 'host-a', cwd: hostProject.replace(/\\/g, '/'), shellName: 'zsh' },
  });
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-remote-spawn-'));
  shellFolder = path.join(scratch, 'shell');
  hostHome = path.join(scratch, 'host-home');
  hostProject = path.join(hostHome, 'projects', 'api');
  fs.mkdirSync(shellFolder, { recursive: true });
  fs.mkdirSync(hostProject, { recursive: true });
});

afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('spawning an agent session on a host', () => {
  it('pushes the session\'s files before the agent exists, then starts the host\'s login shell in the project folder', async () => {
    const rig = await makeRig();

    const session = await spawnRemote(rig);

    expect(session.status).toBe('running');
    expect(session.pid).toBeNull();
    expect(fs.readFileSync(path.join(rig.hostSession, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    expect(fs.statSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox')).isDirectory()).toBe(true);
    const [file, args, options] = rig.helperRig.spawnPty.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(file).toBe('/bin/zsh');
    expect(args).toEqual(['--login']);
    expect(options.cwd).toBe(hostProject.replace(/\\/g, '/'));
    expect(options.env.KANGENTIC_TASK_ID).toBe('task-1');
    expect(Object.keys(options.env)).not.toContain('USERPROFILE');
  });

  it('types the agent\'s command into the host\'s shell, quoted for it', async () => {
    const rig = await makeRig();

    await spawnRemote(rig);

    await waitFor(() => rig.helperRig.fakes[0].write.mock.calls.some((call) => String(call[0]).includes('claude --session-id abc')));
    const typed = rig.helperRig.fakes[0].write.mock.calls.map((call) => String(call[0])).find((text) => text.includes('claude --session-id abc'));
    expect(typed).toBe('clear; claude --session-id abc\r');
  });

  it('turns a hook file the host publishes into an event in the session\'s events file', async () => {
    const rig = await makeRig();
    await spawnRemote(rig);

    fs.writeFileSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox', '1700000000000000000-4242.rec'), 'K1\nidle\n\n{}');

    await waitFor(() => fs.existsSync(rig.eventsPath) && fs.readFileSync(rig.eventsPath, 'utf8').includes('"idle"'));
  });

  it('delivers the last hook file published as the agent exited, before the exit is handled, and releases the session', async () => {
    const rig = await makeRig();
    const session = await spawnRemote(rig);
    const exits: string[] = [];
    rig.manager.on('exit', (sessionId: string) => exits.push(sessionId));

    fs.writeFileSync(path.join(rig.hostSession, 'wsl-hooks', 'inbox', '1700000000000000000-9.rec'), 'K1\nidle\n\n{}');
    rig.helperRig.fakes[0].exit(0);

    await waitFor(() => exits.includes(session.id));
    expect(fs.readFileSync(rig.eventsPath, 'utf8')).toContain('"idle"');
    await waitFor(() => !rig.relay.has('s1'));
  });

  it('ends the spawn as an exited session, not a throw, when the host has no connection, and starts nothing', async () => {
    const rig = await makeRig();
    rig.manager.setRemoteSessionRelay(new RemoteSessionRelay({
      files: {
        writeFiles: async () => { throw new Error('Connection refused'); },
        writeFileRaw: async () => ({}),
        watchHooks: async () => ({}),
        unwatchHooks: async () => ({}),
        removeFiles: async () => ({}),
      },
    }));

    // A throw here left a promoted queue row `queued` for good, so a failed registration ends the session
    // as an exited placeholder the board can show, with the host's words in its scrollback.
    const session = await spawnRemote(rig);

    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(-1);
    expect(rig.helperRig.spawnPty).not.toHaveBeenCalled();
  });
});
