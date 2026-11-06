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
  postedCommands: PtyHostCommand[];
  helperRig: HelperRig;
  relay: RemoteSessionRelay;
  place: SshCliPlace;
  localSession: string;
  hostSession: string;
  eventsPath: string;
  statusPath: string;
}

/** The pty host as main sees it, with the router in front of a real core, in this process. */
function routedTransport(
  router: HostRouter,
  listenerRef: { current: ((event: PtyHostEvent) => void) | null },
  postedCommands?: PtyHostCommand[],
): PtyHostTransport {
  return {
    hostPid: null,
    post: (command: PtyHostCommand) => {
      postedCommands?.push(command);
      return router.handleCommand(command);
    },
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

  const postedCommands: PtyHostCommand[] = [];
  const manager = new SessionManager({ ptyHostTransport: routedTransport(router, listenerRef, postedCommands) });
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
    postedCommands,
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

describe('the host events a remote agent produces, through the manager\'s own host-event path', () => {
  // Every relay test delivers by hand. Without this, dropping a case in the manager's host-event switch
  // would lose every remote hook file or transcript chunk in the real app with all of those still green.
  it('hands a hookFile event to relay.deliver and a fileChunk event to relay.deliverChunk', () => {
    const listenerRef: { current: ((event: PtyHostEvent) => void) | null } = { current: null };
    const transport: PtyHostTransport = {
      hostPid: null,
      post: () => undefined,
      attachRendererPort: () => undefined,
      request: () => Promise.resolve(undefined as never),
      setEventListener: (listener) => { listenerRef.current = listener; },
      shutdown: () => undefined,
    };
    const manager = new SessionManager({ ptyHostTransport: transport });
    const relay = { deliver: vi.fn(), deliverChunk: vi.fn(), onSessionIdFound: vi.fn() };
    manager.setRemoteSessionRelay(relay as unknown as RemoteSessionRelay);

    const hookFile: PtyHostEvent = { type: 'hookFile', sessionId: 's1', folder: 'inbox', name: '1-2.rec', content: 'K1\nidle\n\n{}' };
    const fileChunk: PtyHostEvent = { type: 'fileChunk', sessionId: 's1', key: 'transcript', offset: 0, reset: false, size: 2, data: 'aGk=' };
    expect(listenerRef.current).not.toBeNull();
    listenerRef.current?.(hookFile);
    listenerRef.current?.(fileChunk);

    expect(relay.deliver).toHaveBeenCalledTimes(1);
    expect(relay.deliver).toHaveBeenCalledWith(hookFile);
    expect(relay.deliverChunk).toHaveBeenCalledTimes(1);
    expect(relay.deliverChunk).toHaveBeenCalledWith(fileChunk);
  });
});

describe('an id found after a session on a host has started', () => {
  // The relay's tests call `setAgentSessionId` by hand. Without this, a capture that stopped reaching the relay
  // would leave a fresh Kimi with a name on its card and a transcript that never starts copying.
  it('takes the same path as any captured id, and comes back to the relay, which starts copying', async () => {
    const foundListener = vi.spyOn(RemoteSessionRelay.prototype, 'onSessionIdFound');
    const rig = await makeRig();
    const told = vi.spyOn(rig.relay, 'setAgentSessionId');
    await spawnRemote(rig);
    const reportFound = foundListener.mock.lastCall?.[0];

    reportFound?.('s1', 'agent-from-index');

    expect(rig.manager.getSession('s1')?.agentSessionId).toBe('agent-from-index');
    expect(told).toHaveBeenCalledWith('s1', 'agent-from-index');
    foundListener.mockRestore();
  });

  // A hand-run CLI in the same folder can write the only new line. Latched, that wrong id would resume someone else's conversation.
  it('stays open to the agent\'s own report, which replaces it when the two differ', async () => {
    const foundListener = vi.spyOn(RemoteSessionRelay.prototype, 'onSessionIdFound');
    const rig = await makeRig();
    await spawnRemote(rig);
    const reportFound = foundListener.mock.lastCall?.[0];
    const told = vi.spyOn(rig.relay, 'setAgentSessionId');

    reportFound?.('s1', 'agent-from-index');
    // The call the pty host's output scan makes for the exit hint (`agentSessionId` in `handleHostEvent`).
    (rig.manager as unknown as { telemetry: { notifyAgentSessionId(sessionId: string, id: string): void } }).telemetry.notifyAgentSessionId('s1', 'agent-from-exit-hint');

    expect(rig.manager.getSession('s1')?.agentSessionId).toBe('agent-from-exit-hint');
    expect(told).toHaveBeenLastCalledWith('s1', 'agent-from-exit-hint');
    foundListener.mockRestore();
  });

  // A guessed id that closed the host's capture channel would latch: the agent's own report could never
  // replace it, and a resume would open someone else's conversation.
  it('keeps the host\'s capture channel open for an inferred id, and closes it for the agent\'s own report', async () => {
    const foundListener = vi.spyOn(RemoteSessionRelay.prototype, 'onSessionIdFound');
    const rig = await makeRig();
    await spawnRemote(rig);
    const reportFound = foundListener.mock.lastCall?.[0];
    const knownCommands = () => rig.postedCommands.filter((command) => command.type === 'setAgentSessionIdKnown');

    reportFound?.('s1', 'agent-from-index');
    expect(knownCommands()).toEqual([]);

    (rig.manager as unknown as { telemetry: { notifyAgentSessionId(sessionId: string, id: string): void } }).telemetry.notifyAgentSessionId('s1', 'agent-from-exit-hint');
    expect(knownCommands()).toEqual([{ type: 'setAgentSessionIdKnown', sessionId: 's1' }]);
    foundListener.mockRestore();
  });
});

describe('an agent session id that arrives for a session on a host', () => {
  type TelemetryAccess = { telemetry: { notifyAgentSessionId(sessionId: string, id: string): void } };
  type RegistryAccess = { registry: { get(sessionId: string): { hostId?: string } | undefined } };

  // A hook's id comes from the host and becomes part of a path here, so one that climbs out of a folder
  // must reach neither a row, the relay nor a listener.
  it('is dropped when it is no plain name: no row change, no relay call, no agent-session-id event', async () => {
    const rig = await makeRig();
    await spawnRemote(rig);
    const told = vi.spyOn(rig.relay, 'setAgentSessionId');
    const emitted: string[] = [];
    rig.manager.on('agent-session-id', (_sessionId: string, _taskId: string, _projectId: string, id: string) => emitted.push(id));
    const changed = vi.fn();
    rig.manager.on('session-changed', changed);
    const before = rig.manager.getSession('s1')?.agentSessionId;
    const knownBefore = rig.postedCommands.filter((command) => command.type === 'setAgentSessionIdKnown').length;

    (rig.manager as unknown as TelemetryAccess).telemetry.notifyAgentSessionId('s1', '../../x');

    expect(rig.manager.getSession('s1')?.agentSessionId).toBe(before);
    expect(told).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(rig.postedCommands.filter((command) => command.type === 'setAgentSessionIdKnown')).toHaveLength(knownBefore);
  });

  it('is taken when it is a plain name', async () => {
    const rig = await makeRig();
    await spawnRemote(rig);
    const told = vi.spyOn(rig.relay, 'setAgentSessionId');
    const emitted: string[] = [];
    rig.manager.on('agent-session-id', (_sessionId: string, _taskId: string, _projectId: string, id: string) => emitted.push(id));

    (rig.manager as unknown as TelemetryAccess).telemetry.notifyAgentSessionId('s1', 'agent-abc.1');

    expect(rig.manager.getSession('s1')?.agentSessionId).toBe('agent-abc.1');
    expect(told).toHaveBeenCalledWith('s1', 'agent-abc.1');
    expect(emitted).toEqual(['agent-abc.1']);
  });

  it('is not checked for a session that is not on a host', async () => {
    const rig = await makeRig();
    await spawnRemote(rig);
    // The same session read as a local one: only a host's id comes from somewhere this computer does not trust.
    const row = (rig.manager as unknown as RegistryAccess).registry.get('s1');
    if (!row) throw new Error('the session has no registry row');
    row.hostId = undefined;

    (rig.manager as unknown as TelemetryAccess).telemetry.notifyAgentSessionId('s1', '../../x');

    expect(rig.manager.getSession('s1')?.agentSessionId).toBe('../../x');
  });
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
        removeEmptyDirectories: async () => ({}),
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
