/**
 * What a user loses if these reports go quiet: a phone is told a move, a pause
 * or a start worked and the rest of it failed, a paired phone is silently
 * unpaired or stops getting notifications, a transcript stops following its
 * session, a stale notification stays on the phone, or a device never connects
 * because its socket could not be built. Each of those used to end in a log
 * line only, and the capability router never sees any of them, because it
 * reports a verb handler's throw and nothing else.
 *
 * Each case runs the real module, makes one dependency throw, and reads the
 * call that reached `reportHandledError`: the source `mobile_bridge`, the
 * `stage` tag, and that nothing a user or a phone wrote left with it. The
 * negatives pin what must never report: a relay dial that did not open, a
 * socket that dropped mid-send, bytes on a public relay slot that nothing
 * authenticated, a refusal, and a worker that is down.
 *
 * Each describe installs its own module mocks with doMock and loads a fresh
 * module graph (`vi.resetModules`), because the reporter latches a key once per
 * run and the describes mock different halves of the bridge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKKHandshake,
  createPairingInitiatorHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  encodeMessage,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  MAX_DECODED_LENGTH,
  PUSH_CLEAR_DATA_KEY,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeEvent,
  type BridgeMessage,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type CapabilityVerb,
  type HandshakeState,
  type RosterDeviceEntry,
  type SecretstreamDirectionPair,
  type Transport,
  type TransportState,
} from '@kangentic/protocol';
import type { BoardChangedEvent } from '../../src/main/mobile-bridge/board-event-bus';
import type { PushNotifierOptions } from '../../src/main/mobile-bridge/push/push-notifier';
import type { WakeMessage, WakeResult } from '../../src/main/mobile-bridge/push/wake-channel';
import type { RelayWebSocketConstructor } from '../../src/main/mobile-bridge/transport/relay-client';
import type { QueueSnapshot } from '../../src/shared/types';
import { reportedText as sharedReportedText } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError,
  // transport-factory records each dial's outcome through this one.
  addRelayDialBreadcrumb: vi.fn(),
}));

/** What the fake `safeStorage` does when asked whether it can encrypt. */
const electronControl = vi.hoisted(() => ({ safeStorageError: null as Error | null }));
vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage({
      isAsyncEncryptionAvailable: () => {
        if (electronControl.safeStorageError) throw electronControl.safeStorageError;
        return true;
      },
    }),
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  };
});

/** Text a user or a phone could have written. No report may carry it. */
const USER_TEXT = 'Fix Acme billing';

/** A code defect whose message quotes user text, as V8's own messages do. */
function codeDefect(): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}')`);
}

const installedMockPaths = new Set<string>();

/** doMock each path, remembering it so the next test starts without it. */
function installMocks(factories: Record<string, () => unknown>): void {
  for (const [modulePath, factory] of Object.entries(factories)) {
    installedMockPaths.add(modulePath);
    vi.doMock(modulePath, factory);
  }
}

let temporaryDirectory = '';

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  electronControl.safeStorageError = null;
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-mobile-bridge-report-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const modulePath of installedMockPaths) vi.doUnmock(modulePath);
  installedMockPaths.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

/** The tags of the one report that was sent. */
function onlyReportTags(): Record<string, string> {
  expect(reportHandledError).toHaveBeenCalledTimes(1);
  return reportHandledError.mock.calls[0][1] as Record<string, string>;
}

/** Everything every report carried, as text, so user text cannot hide in any field. */
const reportedText = (): string => sharedReportedText(reportHandledError);

/** One report, from the bridge's reporter, with these tags and no user text. */
function expectOneReport(expectedTags: Record<string, string>): void {
  expect(onlyReportTags()).toMatchObject({ source: 'mobile_bridge', ...expectedTags });
  expect(reportedText()).not.toMatch(/acme/i);
}

/** A turn of the event loop, for work a handler left running behind its answer. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function capabilityRequest(verb: CapabilityVerb, payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb, payload: payload as CapabilityRequestMessage['payload'] };
}

/** A context whose project registry knows every id it is asked for. */
function knownProjectContext(): { currentProjectId: null; currentProjectPath: null; projectRepo: { getById: (projectId: string) => { id: string; path: string } } } {
  return {
    currentProjectId: null,
    currentProjectPath: null,
    projectRepo: { getById: (projectId: string) => ({ id: projectId, path: path.join(temporaryDirectory, 'project') }) },
  };
}

function testIdentity(): { staticKeyPair: ReturnType<typeof generateX25519KeyPair>; masterSigningKeyPair: ReturnType<typeof generateEd25519KeyPair>; createdAt: string } {
  return {
    staticKeyPair: generateX25519KeyPair(),
    masterSigningKeyPair: generateEd25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
}

/** Two transports joined back to back, as a relay joins a desktop and a phone. */
function createLoopbackTransportPair(): [Transport, Transport] {
  const listenersOfFirst = new Set<(frame: Uint8Array) => void>();
  const listenersOfSecond = new Set<(frame: Uint8Array) => void>();
  const first: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      for (const listener of listenersOfSecond) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listenersOfFirst.add(listener);
      return () => listenersOfFirst.delete(listener);
    },
    onStateChange: () => () => undefined,
  };
  const second: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      for (const listener of listenersOfFirst) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listenersOfSecond.add(listener);
      return () => listenersOfSecond.delete(listener);
    },
    onStateChange: () => () => undefined,
  };
  return [first, second];
}

// ---------------------------------------------------------------------------
// Verbs that answer on commit or acceptance, and run the rest behind it
// ---------------------------------------------------------------------------

describe('a verb that answered the phone and failed afterwards', { timeout: 30_000 }, () => {
  const handleTaskMove = vi.fn();
  const pauseTaskSession = vi.fn();
  const startTaskSession = vi.fn();
  const openTaskSession = vi.fn();
  const MOVE_PAYLOAD = { taskId: 'task-1', targetSwimlaneId: 'lane-2', targetPosition: 0, projectId: 'proj-1' };
  const TASK_PAYLOAD = { taskId: 'task-1', projectId: 'proj-1' };

  beforeEach(() => {
    handleTaskMove.mockReset();
    pauseTaskSession.mockReset();
    startTaskSession.mockReset();
    openTaskSession.mockReset();
    installMocks({
      '../../src/main/ipc/handlers/task-move': () => ({ handleTaskMove }),
      '../../src/main/ipc/handlers/session-pause': () => ({ pauseTaskSession }),
      '../../src/main/ipc/handlers/session-start': () => ({ startTaskSession, openTaskSession }),
    });
  });

  /** A move that commits, tells the handler so, and then fails with `error`. */
  function moveThatFailsAfterCommit(error: Error): void {
    handleTaskMove.mockImplementation((...moveArguments: unknown[]) => {
      (moveArguments[5] as { onCommitted?: () => void }).onCommitted?.();
      return Promise.reject(error);
    });
  }

  it('reports a move that failed after it committed, under stage move_after_commit', async () => {
    moveThatFailsAfterCommit(codeDefect());
    const { handleMoveTask } = await import('../../src/main/mobile-bridge/handlers/move-task');

    const response = await handleMoveTask(capabilityRequest('move-task', MOVE_PAYLOAD), knownProjectContext() as never);
    await settle();

    expect(response.ok).toBe(true);
    expectOneReport({ stage: 'move_after_commit', error_name: 'TypeError' });
  });

  it('leaves a move that failed before it committed to the router, which reports the throw', async () => {
    handleTaskMove.mockImplementation(() => Promise.reject(codeDefect()));
    const { handleMoveTask } = await import('../../src/main/mobile-bridge/handlers/move-task');

    await expect(handleMoveTask(capabilityRequest('move-task', MOVE_PAYLOAD), knownProjectContext() as never)).rejects.toThrow(TypeError);
    await settle();

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('skips a failure the move itself already reported', async () => {
    const { markReported } = await import('../../src/main/analytics/handled-report');
    const alreadyReported = codeDefect();
    markReported(alreadyReported);
    moveThatFailsAfterCommit(alreadyReported);
    const { handleMoveTask } = await import('../../src/main/mobile-bridge/handlers/move-task');

    await handleMoveTask(capabilityRequest('move-task', MOVE_PAYLOAD), knownProjectContext() as never);
    await settle();

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a pause that failed after it was accepted, under stage pause_after_accept', async () => {
    pauseTaskSession.mockImplementation((...pauseArguments: unknown[]) => {
      (pauseArguments[2] as { onAccepted: () => void }).onAccepted();
      return Promise.reject(codeDefect());
    });
    const { handlePauseSession } = await import('../../src/main/mobile-bridge/handlers/pause-session');

    const response = await handlePauseSession(capabilityRequest('pause-session', TASK_PAYLOAD), knownProjectContext() as never);
    await settle();

    expect(response.ok).toBe(true);
    expectOneReport({ stage: 'pause_after_accept', error_name: 'TypeError' });
  });

  it('reports an open whose resume failed after the phone was told it is starting, under stage open_after_accept', async () => {
    openTaskSession.mockImplementation(async () => ({ outcome: 'starting', settled: Promise.reject(codeDefect()) }));
    const { handleStartSession } = await import('../../src/main/mobile-bridge/handlers/start-session');

    const response = await handleStartSession(capabilityRequest('start-session', { ...TASK_PAYLOAD, trigger: 'open' }), knownProjectContext() as never);
    await settle();

    expect(response).toMatchObject({ ok: true, payload: { outcome: 'starting' } });
    expectOneReport({ stage: 'open_after_accept', error_name: 'TypeError' });
  });

  it('reports a start that failed after it was accepted, under stage start_after_accept', async () => {
    startTaskSession.mockImplementation(async () => ({ outcome: 'starting', settled: Promise.reject(codeDefect()) }));
    const { handleStartSession } = await import('../../src/main/mobile-bridge/handlers/start-session');

    const response = await handleStartSession(capabilityRequest('start-session', TASK_PAYLOAD), knownProjectContext() as never);
    await settle();

    expect(response).toMatchObject({ ok: true, payload: { outcome: 'starting' } });
    expectOneReport({ stage: 'start_after_accept', error_name: 'TypeError' });
  });
});

// ---------------------------------------------------------------------------
// command-terminal: the handler answers ok:false, so the router never sees it
// ---------------------------------------------------------------------------

describe('a Command Terminal start a phone asked for', { timeout: 30_000 }, () => {
  const startCommandTerminal = vi.fn();
  const START_REQUEST = { action: 'start', projectId: 'proj-1' };

  beforeEach(() => {
    startCommandTerminal.mockReset();
    installMocks({
      // The real module, so the refusal below is the class production throws.
      '../../src/main/ipc/handlers/transient-sessions': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/ipc/handlers/transient-sessions')>('../../src/main/ipc/handlers/transient-sessions')),
        startCommandTerminal,
      }),
    });
  });

  function commandTerminalContext(): unknown {
    return { ...knownProjectContext(), sessionManager: { endCommandTerminal: vi.fn() }, commandTerminalHistory: { list: vi.fn(async () => []) } };
  }

  it('reports a start that failed for no reason the phone can act on, under stage command_terminal_start', async () => {
    startCommandTerminal.mockRejectedValue(codeDefect());
    const { handleCommandTerminal } = await import('../../src/main/mobile-bridge/handlers/command-terminal');

    const response = await handleCommandTerminal(capabilityRequest('command-terminal', START_REQUEST), commandTerminalContext() as never);

    expect(response).toMatchObject({ ok: false, code: 'command-terminal-start-failed' });
    expectOneReport({ stage: 'command_terminal_start', error_name: 'TypeError' });
  });

  it('reports nothing for a refusal the start made on purpose (CommandTerminalStartError)', async () => {
    const { CommandTerminalStartError } = await import('../../src/main/ipc/handlers/transient-sessions');
    startCommandTerminal.mockRejectedValue(new CommandTerminalStartError('command-terminal-limit', `No room beside ${USER_TEXT}`));
    const { handleCommandTerminal } = await import('../../src/main/mobile-bridge/handlers/command-terminal');

    const response = await handleCommandTerminal(capabilityRequest('command-terminal', START_REQUEST), commandTerminalContext() as never);

    expect(response).toMatchObject({ ok: false, code: 'command-terminal-limit' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing for an agent CLI the user has not installed (AgentCliNotFoundError)', async () => {
    const { AgentCliNotFoundError } = await import('../../src/main/agent/shared/agent-cli-not-found');
    startCommandTerminal.mockRejectedValue(new AgentCliNotFoundError('claude', 'Claude Code'));
    const { handleCommandTerminal } = await import('../../src/main/mobile-bridge/handlers/command-terminal');

    const response = await handleCommandTerminal(capabilityRequest('command-terminal', START_REQUEST), commandTerminalContext() as never);

    expect(response).toMatchObject({ ok: false, code: 'agent-unavailable' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// read-stream: the resumable read, and the transcript reads behind a subscribe
// ---------------------------------------------------------------------------

describe('read-stream reads that fail behind an answered subscribe', { timeout: 30_000 }, () => {
  const retrievalCall = vi.fn();
  const reposControl = { error: null as Error | null };

  interface StreamSessionRow {
    id: string;
    taskId: string;
    projectId: string;
    status: string;
    resuming: boolean;
  }

  class FakeSessionManager extends EventEmitter {
    row: StreamSessionRow = { id: 'sess-1', taskId: 'task-1', projectId: 'proj-1', status: 'running', resuming: false };
    getSession = vi.fn((): StreamSessionRow | undefined => this.row);
    listSessions = vi.fn(() => [this.row]);
    getSessionProjectId = vi.fn(() => 'proj-1');
    getActivityCache = vi.fn(() => ({}));
    getActivityReason = vi.fn(() => null);
    getUsageCache = vi.fn(() => ({}));
    getActivityStatsSnapshot = vi.fn(() => ({ permissionPending: false, permissionAwaitedToolId: null }));
    getDimensions = vi.fn(() => null);
  }

  let sessionManager: FakeSessionManager;
  /** Every registry a test subscribed through, so each is torn down after it. */
  let subscriptionRegistries: Array<{ dispose: () => void }> = [];

  beforeEach(() => {
    retrievalCall.mockReset();
    retrievalCall.mockResolvedValue({ payloads: [], preview: null });
    reposControl.error = null;
    sessionManager = new FakeSessionManager();
    subscriptionRegistries = [];
    installMocks({
      '../../src/main/db/database': () => ({ getProjectDb: vi.fn(() => ({})) }),
      '../../src/main/ipc/helpers/project-repos': () => ({
        getProjectRepos: () => {
          if (reposControl.error) throw reposControl.error;
          return {
            tasks: { getById: () => ({ id: 'task-1', swimlane_id: 'lane-review', archived_at: null }) },
            swimlanes: { getById: () => ({ id: 'lane-review', role: null }) },
          };
        },
      }),
      // The real module, so the worker-down error below is the class production throws.
      '../../src/main/retrieval/retrieval-client': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/retrieval/retrieval-client')>('../../src/main/retrieval/retrieval-client')),
        retrievalClient: { call: retrievalCall, notifyRunning: vi.fn() },
      }),
    });
  });

  afterEach(() => {
    for (const registry of subscriptionRegistries) registry.dispose();
  });

  /** Subscribes a list-only feed to `sess-1` and returns its response and registry. */
  async function subscribe(): Promise<{ response: CapabilityResponseMessage; subscriptions: { remove: (key: string) => void; dispose: () => void } }> {
    const { handleReadStream } = await import('../../src/main/mobile-bridge/handlers/read-stream');
    const { SubscriptionRegistry } = await import('../../src/main/mobile-bridge/session/subscription-registry');
    const subscriptions = new SubscriptionRegistry();
    subscriptionRegistries.push(subscriptions);
    const bridgeSession = { deviceId: 'device-1', isEstablished: true, sendMessage: vi.fn(), capabilities: new Set(['read-stream']) };
    const response = await handleReadStream(
      capabilityRequest('read-stream', { sessionId: 'sess-1', action: 'subscribe', terminal: false }),
      bridgeSession as never,
      { sessionManager } as never,
      subscriptions,
    );
    return { response, subscriptions };
  }

  it('reports a task read that fails for a paused session, under stage resumable, and answers not resumable', async () => {
    sessionManager.row = { ...sessionManager.row, status: 'suspended' };
    reposControl.error = codeDefect();

    const { response } = await subscribe();

    expect(response).toMatchObject({ ok: true, payload: { resumable: false } });
    expectOneReport({ stage: 'resumable', error_name: 'TypeError' });
  });

  it('reports a seed the worker failed, under stage transcript_seed', async () => {
    retrievalCall.mockRejectedValueOnce(codeDefect());

    const { response } = await subscribe();
    await settle();

    expect(response.ok).toBe(true);
    expect(retrievalCall).toHaveBeenCalledWith('transcript.mobileSync', expect.objectContaining({ mode: 'seed' }));
    expectOneReport({ stage: 'transcript_seed', error_name: 'TypeError' });
  });

  it('reports a transcript read the worker failed, under stage transcript_read', async () => {
    vi.useFakeTimers();
    await subscribe();
    await vi.advanceTimersByTimeAsync(0);
    retrievalCall.mockRejectedValueOnce(codeDefect());

    sessionManager.emit('event', 'sess-1', { ts: 1, type: 'tool_start' });
    await vi.advanceTimersByTimeAsync(300);

    expect(retrievalCall).toHaveBeenLastCalledWith('transcript.mobileSync', expect.objectContaining({ mode: 'diff' }));
    expectOneReport({ stage: 'transcript_read', error_name: 'TypeError' });
  });

  it('reports nothing for a retrieval worker that is down, on the seed or on a read', async () => {
    const { RetrievalUnavailableError } = await import('../../src/main/retrieval/retrieval-client');
    vi.useFakeTimers();
    retrievalCall.mockRejectedValue(new RetrievalUnavailableError('The retrieval worker is restarting'));

    await subscribe();
    await vi.advanceTimersByTimeAsync(0);
    sessionManager.emit('event', 'sess-1', { ts: 1, type: 'tool_start' });
    await vi.advanceTimersByTimeAsync(300);

    expect(retrievalCall).toHaveBeenCalledTimes(2);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing for a seed that fails after its subscription ended', async () => {
    let failSeed: (error: Error) => void = () => {};
    retrievalCall.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failSeed = reject;
    }));
    const { subscriptions } = await subscribe();
    expect(retrievalCall).toHaveBeenLastCalledWith('transcript.mobileSync', expect.objectContaining({ mode: 'seed' }));

    subscriptions.dispose();
    failSeed(codeDefect());
    await settle();

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing for a read that fails after its subscription ended', async () => {
    vi.useFakeTimers();
    const { subscriptions } = await subscribe();
    await vi.advanceTimersByTimeAsync(0);
    let failRead: (error: Error) => void = () => {};
    retrievalCall.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failRead = reject;
    }));
    sessionManager.emit('event', 'sess-1', { ts: 1, type: 'tool_start' });
    await vi.advanceTimersByTimeAsync(300);
    expect(retrievalCall).toHaveBeenLastCalledWith('transcript.mobileSync', expect.objectContaining({ mode: 'diff' }));

    // The session or its project went away while the read was in flight.
    subscriptions.dispose();
    failRead(codeDefect());
    await vi.advanceTimersByTimeAsync(0);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendEvent: only a payload this side built past the frame cap
// ---------------------------------------------------------------------------

describe('an event the desktop pushes to a phone', () => {
  it('reports an event built past the frame cap, under stage event_oversize, with its kind and none of its content', async () => {
    const { sendEvent } = await import('../../src/main/mobile-bridge/handlers/send-event');
    // The real encoder decides it is too large, as the session's sendMessage does.
    const bridgeSession = { isEstablished: true, sendMessage: (message: BridgeMessage) => encodeMessage(message).byteLength };
    const oversize: BridgeEvent = {
      kind: 'terminal',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { data: `${USER_TEXT} `.repeat(Math.ceil(MAX_DECODED_LENGTH / USER_TEXT.length) + 1) },
    };

    expect(() => sendEvent(bridgeSession as never, oversize)).not.toThrow();

    expectOneReport({ stage: 'event_oversize', event_kind: 'terminal' });
  });

  it('reports nothing for a session that was torn down mid-send', async () => {
    const { sendEvent } = await import('../../src/main/mobile-bridge/handlers/send-event');
    const bridgeSession = {
      isEstablished: true,
      sendMessage: () => {
        throw new Error('RelayClient.send() called while not connected');
      },
    };

    expect(() => sendEvent(bridgeSession as never, { kind: 'diff', taskId: 'task-1', payload: null })).not.toThrow();

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The roster and the push registrations, read back from disk
// ---------------------------------------------------------------------------

describe('bridge state files that are there and will not load', () => {
  beforeEach(() => {
    installMocks({
      '../../src/main/config/paths': () => ({ PATHS: { configDir: temporaryDirectory } }),
    });
  });

  it('reports a roster that will not parse, under stage roster_load, and starts empty', async () => {
    fs.writeFileSync(path.join(temporaryDirectory, 'mobile-bridge-roster.json'), `{"devices": "${USER_TEXT}`);
    const { loadRoster } = await import('../../src/main/mobile-bridge/roster-store');

    const roster = loadRoster(testIdentity());

    expect(roster.devices).toEqual([]);
    expectOneReport({ stage: 'roster_load', error_name: 'SyntaxError' });
  });

  it('reports nothing for a roster that was never written', async () => {
    const { loadRoster } = await import('../../src/main/mobile-bridge/roster-store');

    expect(loadRoster(testIdentity()).devices).toEqual([]);

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports push registrations that will not parse, under stage push_registrations_load, with why, and starts empty', async () => {
    fs.writeFileSync(path.join(temporaryDirectory, 'mobile-push-registrations.json'), `{"device-1": "${USER_TEXT}`);
    const { PushRegistrationStore } = await import('../../src/main/mobile-bridge/push/push-registration-store');

    expect(new PushRegistrationStore().list()).toEqual([]);

    // JSON.parse quotes its input, so the parse error rides only as cause_name.
    expectOneReport({
      stage: 'push_registrations_load',
      load_cause: 'truncated',
      error_name: 'PushRegistrationsCorruptError',
      cause_name: 'SyntaxError',
    });
  });

  /** The next read of `fileName` fails as a file another program holds, then reads work again. */
  function holdFileOnce(fileName: string): void {
    const realRead = fs.readFileSync.bind(fs);
    let held = true;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      if (held && String(target).endsWith(fileName)) {
        held = false;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(target)}'`), { code: 'EBUSY', syscall: 'open' });
      }
      return realRead(target, options as never);
    }) as typeof fs.readFileSync);
  }

  const pairing = (deviceId: string, displayName: string) => ({
    deviceId,
    staticPublicKey: generateX25519KeyPair().publicKey,
    displayName,
    capabilities: ['read-stream'] as CapabilityVerb[],
    expiresAt: null,
  });

  // A read that failed fell back to an empty roster. Saving a pairing made to
  // that replaced a whole file with one device and unpaired every other phone.
  it('leaves a roster it could not read as it is, and tells the user the pairing was not saved', async () => {
    const { setSyncWriteFailureNotifier, __resetForTest } = await import('../../src/main/config/write-failure-notice');
    __resetForTest();
    const notices: string[] = [];
    setSyncWriteFailureNotifier((message) => { notices.push(message); return true; });
    const { addOrReplaceDevice, loadRoster } = await import('../../src/main/mobile-bridge/roster-store');
    const identity = testIdentity();
    addOrReplaceDevice(identity, pairing('device-1', USER_TEXT));
    addOrReplaceDevice(identity, pairing('device-2', 'Second phone'));
    const rosterFile = path.join(temporaryDirectory, 'mobile-bridge-roster.json');
    const before = fs.readFileSync(rosterFile, 'utf8');
    reportHandledError.mockReset();

    holdFileOnce('mobile-bridge-roster.json');
    const answered = addOrReplaceDevice(identity, pairing('device-3', 'Third phone'));

    // The caller still gets the roster its change made, as after a write that failed.
    expect(answered.devices.map((device) => device.deviceId)).toEqual(['device-3']);
    expect(fs.readFileSync(rosterFile, 'utf8')).toBe(before);
    expect(loadRoster(identity).devices.map((device) => device.deviceId)).toEqual(['device-1', 'device-2']);
    expect(notices).toHaveLength(1);
    // One report, as the write that could not be made, and none as a failed load.
    expect(onlyReportTags()).toMatchObject({ source: 'mobile_bridge_roster', stage: 'read_before_write', errno: 'EBUSY', syscall: 'open' });
    expect(reportedText()).not.toMatch(/acme/i);
    expect(reportedText()).not.toContain(temporaryDirectory);
  });

  it('leaves a roster it could not read as it is on a revoke, and revokes once it reads again', async () => {
    const { addOrReplaceDevice, revokeDevice, loadRoster } = await import('../../src/main/mobile-bridge/roster-store');
    const identity = testIdentity();
    addOrReplaceDevice(identity, pairing('device-1', 'First phone'));
    addOrReplaceDevice(identity, pairing('device-2', 'Second phone'));

    holdFileOnce('mobile-bridge-roster.json');
    revokeDevice(identity, 'device-1');
    expect(loadRoster(identity).devices.map((device) => device.deviceId)).toEqual(['device-1', 'device-2']);

    revokeDevice(identity, 'device-1');
    expect(loadRoster(identity).devices.map((device) => device.deviceId)).toEqual(['device-2']);
  });

  // A rename or a capability change looked its device up through the reporting read, so a
  // roster that would not read answered "No such paired device" for a phone that is paired.
  it('refuses nothing for a rename against a roster it could not read, and tells the user it was not saved', async () => {
    const { setSyncWriteFailureNotifier, __resetForTest } = await import('../../src/main/config/write-failure-notice');
    __resetForTest();
    const notices: string[] = [];
    setSyncWriteFailureNotifier((message) => { notices.push(message); return true; });
    const { addOrReplaceDevice, setDeviceDisplayName, loadRoster } = await import('../../src/main/mobile-bridge/roster-store');
    const identity = testIdentity();
    addOrReplaceDevice(identity, pairing('device-1', 'First phone'));
    const rosterFile = path.join(temporaryDirectory, 'mobile-bridge-roster.json');
    const before = fs.readFileSync(rosterFile, 'utf8');
    reportHandledError.mockReset();

    holdFileOnce('mobile-bridge-roster.json');
    expect(() => setDeviceDisplayName(identity, 'device-1', USER_TEXT)).not.toThrow();

    expect(fs.readFileSync(rosterFile, 'utf8')).toBe(before);
    expect(notices).toHaveLength(1);
    // One report, as the write that could not be made, and none as a failed load.
    expect(onlyReportTags()).toMatchObject({ source: 'mobile_bridge_roster', stage: 'read_before_write', errno: 'EBUSY', syscall: 'open' });
    expect(reportedText()).not.toMatch(/acme/i);
    expect(reportedText()).not.toContain(temporaryDirectory);

    // The same change lands once the file reads again.
    setDeviceDisplayName(identity, 'device-1', 'Renamed phone');
    expect(loadRoster(identity).devices.map((device) => device.displayName)).toEqual(['Renamed phone']);
  });

  it('leaves a roster it could not read as it is on a capability change, and still refuses a device that is not paired', async () => {
    const { addOrReplaceDevice, setDeviceCapabilities, loadRoster } = await import('../../src/main/mobile-bridge/roster-store');
    const identity = testIdentity();
    addOrReplaceDevice(identity, pairing('device-1', 'First phone'));

    holdFileOnce('mobile-bridge-roster.json');
    expect(() => setDeviceCapabilities(identity, 'device-1', [])).not.toThrow();
    expect(loadRoster(identity).devices.map((device) => device.capabilities)).toEqual([['read-stream']]);

    // Only a roster that did read can say a device is not paired.
    expect(() => setDeviceCapabilities(identity, 'device-9', [])).toThrow(/No such paired device/);
    setDeviceCapabilities(identity, 'device-1', []);
    expect(loadRoster(identity).devices.map((device) => device.capabilities)).toEqual([[]]);
  });

  it('reports a roster read that failed outside a change as a failed load, once', async () => {
    const { addOrReplaceDevice, loadRoster } = await import('../../src/main/mobile-bridge/roster-store');
    const identity = testIdentity();
    addOrReplaceDevice(identity, pairing('device-1', USER_TEXT));
    reportHandledError.mockReset();

    holdFileOnce('mobile-bridge-roster.json');
    expect(loadRoster(identity).devices).toEqual([]);

    expectOneReport({ stage: 'roster_load', errno: 'EBUSY' });
    // The next read works, and nothing was lost.
    expect(loadRoster(identity).devices).toHaveLength(1);
  });

  it('keeps every other phone registered when the registrations could not be read at an upsert', async () => {
    const { PushRegistrationStore } = await import('../../src/main/mobile-bridge/push/push-registration-store');
    const registration = (token: string) => ({ expoPushToken: token, pushKeyHex: 'ab'.repeat(32), platform: 'android' as const, registeredAt: '2026-07-16T00:00:00.000Z' });
    new PushRegistrationStore().upsert('device-1', registration('ExponentPushToken[one]'));
    new PushRegistrationStore().upsert('device-2', registration('ExponentPushToken[two]'));
    const registrationsFile = path.join(temporaryDirectory, 'mobile-push-registrations.json');
    const before = fs.readFileSync(registrationsFile, 'utf8');
    reportHandledError.mockReset();

    // A store that has read nothing yet, as after a launch.
    const store = new PushRegistrationStore();
    holdFileOnce('mobile-push-registrations.json');
    store.upsert('device-3', registration('ExponentPushToken[three]'));

    expect(fs.readFileSync(registrationsFile, 'utf8')).toBe(before);
    const stages = reportHandledError.mock.calls.map((call) => (call[1] as Record<string, string>).stage);
    expect(stages).toEqual(['push_registrations_load', 'read_before_write']);
    // The failed read was not kept as the mirror: the same store reads the file again.
    expect(store.list().map((entry) => entry.deviceId)).toEqual(['device-1', 'device-2']);
    store.upsert('device-3', registration('ExponentPushToken[three]'));
    expect(new PushRegistrationStore().list().map((entry) => entry.deviceId)).toEqual(['device-1', 'device-2', 'device-3']);
  });

  it('writes a registration through the guarded writer and reads it back, with nothing reported', async () => {
    const { PushRegistrationStore } = await import('../../src/main/mobile-bridge/push/push-registration-store');
    const registration = { expoPushToken: 'ExponentPushToken[abc]', pushKeyHex: 'ab'.repeat(32), platform: 'android' as const, registeredAt: '2026-07-16T00:00:00.000Z' };

    new PushRegistrationStore().upsert('device-1', registration);

    expect(new PushRegistrationStore().list()).toEqual([{ deviceId: 'device-1', ...registration }]);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MobileBridgeService: secure storage, a roster dial, a response over the cap
// ---------------------------------------------------------------------------

describe('the bridge service', { timeout: 30_000 }, () => {
  const fakeIdentity = {
    staticKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) },
  };
  const fakeDevice: RosterDeviceEntry = {
    deviceId: 'device-A',
    displayName: 'Phone A',
    staticPublicKey: new Uint8Array(32).fill(3),
    capabilities: ['read-board'],
    pairedAt: new Date(0).toISOString(),
    expiresAt: null,
  } as RosterDeviceEntry;

  /** A real EventEmitter, so a test drives 'message' as the real session does. */
  class FakeBridgeSession extends EventEmitter {
    readonly deviceId: string;
    capabilities: Set<string>;
    connectionState = 'idle';
    transportState: TransportState = 'idle';
    transportBufferedBytes: number | null = null;
    start = vi.fn();
    dispose = vi.fn();
    sendMessage = vi.fn();
    sendGoodbye = vi.fn();
    get relayLinkState(): TransportState {
      return this.transportState;
    }
    constructor(options: { deviceId: string; capabilities: Set<string> }) {
      super();
      this.deviceId = options.deviceId;
      this.capabilities = options.capabilities;
      createdSessions.push(this);
    }
  }
  let createdSessions: FakeBridgeSession[] = [];

  /** The transport a roster session is given: a stand-in, or null for the real RelayClient. */
  const transportControl = { transport: null as Transport | null, created: [] as Transport[] };

  function standInTransport(connect: () => Promise<void>): Transport {
    return {
      state: 'connecting',
      connect,
      send: () => undefined,
      close: () => undefined,
      onFrame: () => () => undefined,
      onStateChange: () => () => undefined,
    };
  }

  beforeEach(() => {
    createdSessions = [];
    transportControl.transport = standInTransport(() => Promise.resolve());
    transportControl.created = [];
    installMocks({
      '../../src/main/analytics/analytics': () => ({ trackEvent: vi.fn(), sanitizeErrorMessage: (message: string) => message }),
      '../../src/main/config/paths': () => ({ PATHS: { configDir: temporaryDirectory } }),
      '../../src/main/mobile-bridge/identity': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/mobile-bridge/identity')>('../../src/main/mobile-bridge/identity')),
        loadBridgeIdentity: async () => fakeIdentity,
        loadOrCreateBridgeIdentity: async () => fakeIdentity,
      }),
      '../../src/main/mobile-bridge/roster-store': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/mobile-bridge/roster-store')>('../../src/main/mobile-bridge/roster-store')),
        loadRoster: () => ({ devices: [fakeDevice] }),
        revokeDevice: vi.fn(),
        setDeviceCapabilities: vi.fn(),
      }),
      // The session is a stand-in; MessageEncodeError and the refusal stay real.
      '../../src/main/mobile-bridge/session/bridge-session': async () => ({
        ...(await vi.importActual<typeof import('../../src/main/mobile-bridge/session/bridge-session')>('../../src/main/mobile-bridge/session/bridge-session')),
        BridgeSession: FakeBridgeSession,
      }),
      '../../src/main/mobile-bridge/transport/transport-factory': async () => {
        const actual = await vi.importActual<typeof import('../../src/main/mobile-bridge/transport/transport-factory')>(
          '../../src/main/mobile-bridge/transport/transport-factory',
        );
        return {
          createTransport: (options: Parameters<typeof actual.createTransport>[0]) => {
            const transport = transportControl.transport ?? actual.createTransport(options);
            transportControl.created.push(transport);
            return transport;
          },
        };
      },
    });
  });

  afterEach(() => {
    // The stand-in session never closes its transport, and a real RelayClient
    // that failed a dial has a redial armed.
    for (const transport of transportControl.created) transport.close();
  });

  type BridgeService = InstanceType<typeof import('../../src/main/mobile-bridge/mobile-bridge-service').MobileBridgeService>;

  async function createService(): Promise<BridgeService> {
    const { MobileBridgeService } = await import('../../src/main/mobile-bridge/mobile-bridge-service');
    return new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
  }

  /** Enables the bridge for the one-device roster and returns the session it opened. */
  async function openSession(service: BridgeService): Promise<FakeBridgeSession> {
    const fakeSessionManager = Object.assign(new EventEmitter(), { setMobileTerminalProbe: vi.fn() });
    service.attachContext({ sessionManager: fakeSessionManager, boardEvents: { emitBoardChanged: vi.fn(), onBoardChanged: vi.fn(() => () => {}) } } as never);
    await service.whenStorageReady();
    service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await settle();
    const session = createdSessions.at(-1);
    if (!session) throw new Error('the service opened no session for the roster device');
    return session;
  }

  it('reports secure storage that throws, under stage secure_storage, and tries again on the next call', async () => {
    electronControl.safeStorageError = codeDefect();
    const service = await createService();

    await service.whenStorageReady();

    expectOneReport({ stage: 'secure_storage', error_name: 'TypeError' });
    electronControl.safeStorageError = null;
    await service.whenStorageReady();
    expect(service.getStatus().secureStorageAvailable).toBe(true);
    service.dispose();
  });

  it('reports a roster dial that fails for a reason the transport did not report, under stage roster_dial', async () => {
    transportControl.transport = standInTransport(() => Promise.reject(codeDefect()));
    const service = await createService();

    await openSession(service);

    expectOneReport({ stage: 'roster_dial', error_name: 'TypeError' });
    service.dispose();
  });

  it('reports nothing for a roster dial that never opened (RelayDialError)', async () => {
    const { RelayDialError } = await import('../../src/main/mobile-bridge/transport/relay-client');
    const connect = vi.fn(() => Promise.reject(new RelayDialError({ kind: 'closed', errorFirst: true, closeCode: 1006, stack: 'node' })));
    transportControl.transport = standInTransport(connect);
    const service = await createService();

    await openSession(service);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
    service.dispose();
  });

  it('sends one report for one dial whose socket could not be built, from the client, and the service skips its copy', async () => {
    // The real transport factory and the real RelayClient, dialing with a
    // global WebSocket that cannot be constructed.
    transportControl.transport = null;
    vi.stubGlobal('WebSocket', class {
      constructor(url: string) {
        throw new SyntaxError(`The URL '${url}' is invalid for ${USER_TEXT}`);
      }
    });
    const service = await createService();

    await openSession(service);

    expect(transportControl.created).toHaveLength(1);
    expectOneReport({ stage: 'relay_socket_build', error_name: 'SyntaxError' });
    service.dispose();
  });

  it('reports a response built past the frame cap, under stage response_encode with the verb, and answers a refusal', async () => {
    const { MessageEncodeError } = await import('../../src/main/mobile-bridge/session/bridge-session');
    const service = await createService();
    const session = await openSession(service);
    service.capabilityRouter.register('read-board', () => ({ type: 'capability-response', requestId: 'req-1', ok: true, payload: { title: USER_TEXT } }));
    session.sendMessage.mockImplementationOnce(() => {
      throw new MessageEncodeError(new Error(`Encoded bridge message exceeds 1048576 bytes (${USER_TEXT})`));
    });

    session.emit('message', capabilityRequest('read-board', {}));
    await settle();

    expectOneReport({ stage: 'response_encode', verb: 'read-board', error_name: 'MessageEncodeError' });
    expect(session.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, code: 'response-too-large' }));
    service.dispose();
  });

  it('reports nothing for a response whose session dropped mid-send', async () => {
    const service = await createService();
    const session = await openSession(service);
    service.capabilityRouter.register('read-board', () => ({ type: 'capability-response', requestId: 'req-1', ok: true }));
    session.sendMessage.mockImplementationOnce(() => {
      throw new Error('BridgeSession is not established yet');
    });

    session.emit('message', capabilityRequest('read-board', {}));
    await settle();

    expect(session.sendMessage).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
    service.dispose();
  });
});

// ---------------------------------------------------------------------------
// Pairing: an authenticated message whose reply could not be built
// ---------------------------------------------------------------------------

describe('a pairing ceremony', () => {
  beforeEach(() => {
    installMocks({
      '../../src/main/config/paths': () => ({ PATHS: { configDir: temporaryDirectory } }),
    });
  });

  it('reports a reply the handshake could not build, under stage pairing_write, and fails the ceremony', async () => {
    installMocks({
      '@kangentic/protocol': async () => ({
        ...(await vi.importActual<typeof import('@kangentic/protocol')>('@kangentic/protocol')),
        // A handshake that accepts the phone's message and cannot write its own.
        createPairingResponderHandshake: () => ({
          readMessage: () => ({ payload: new TextEncoder().encode(USER_TEXT) }),
          writeMessage: () => {
            throw codeDefect();
          },
          getRemoteStaticKey: () => null,
        }),
      }),
    });
    const { PairingService } = await import('../../src/main/mobile-bridge/pairing/pairing-service');
    const service = new PairingService(testIdentity() as never);
    const failures: Array<{ reason: string }> = [];
    service.on('failed', (failure: { reason: string }) => failures.push(failure));
    service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    phoneTransport.send(new Uint8Array([1, 2, 3]));

    expect(failures).toEqual([{ reason: 'Pairing handshake failed to construct the response' }]);
    expectOneReport({ stage: 'pairing_write', error_name: 'TypeError' });
  });

  it('reports nothing for bytes on the pairing slot that do not authenticate', async () => {
    const { PairingService } = await import('../../src/main/mobile-bridge/pairing/pairing-service');
    const service = new PairingService(testIdentity() as never);
    const failures: unknown[] = [];
    service.on('failed', (failure: unknown) => failures.push(failure));
    service.mintToken();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    service.start(desktopTransport);

    phoneTransport.send(new TextEncoder().encode(USER_TEXT));

    expect(failures).toEqual([]);
    expect(reportHandledError).not.toHaveBeenCalled();
    service.cancel();
  });

  it('reports nothing when the relay socket drops as the reply is sent', async () => {
    const { PairingService } = await import('../../src/main/mobile-bridge/pairing/pairing-service');
    const identity = testIdentity();
    const service = new PairingService(identity as never);
    const failures: Array<{ reason: string }> = [];
    service.on('failed', (failure: { reason: string }) => failures.push(failure));
    const token = service.mintToken();
    let deliverToDesktop: (frame: Uint8Array) => void = () => {};
    const droppedTransport: Transport = {
      state: 'reconnecting',
      connect: () => Promise.resolve(),
      send: () => {
        throw new Error('RelayClient.send() called while not connected');
      },
      close: () => undefined,
      onFrame: (listener) => {
        deliverToDesktop = listener;
        return () => undefined;
      },
      onStateChange: () => () => undefined,
    };
    service.start(droppedTransport);
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: generateX25519KeyPair(),
      remoteStatic: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
    });

    deliverToDesktop(phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message);

    expect(failures).toEqual([{ reason: 'Pairing handshake failed while sending the response' }]);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Push notifications: sealing, sending, clearing, and resolving on a board change
// ---------------------------------------------------------------------------

describe('push notifications', () => {
  const TASK_CONTEXT = { projectId: 'proj-1', taskId: 'task-1', taskTitle: USER_TEXT, swimlaneId: 'lane-1' };
  const REGISTRATION = {
    deviceId: 'device-1',
    expoPushToken: 'ExponentPushToken[acme-device-token]',
    pushKeyHex: 'ab'.repeat(32),
    platform: 'android' as const,
    registeredAt: '2026-07-16T00:00:00.000Z',
    acceptsClears: true,
  };

  class FakeSessionManager extends EventEmitter {
    getActivityStatsSnapshot = vi.fn(() => ({ activity: 'permission', permissionPending: true, permissionAwaitedToolId: 'tool-1' }));
  }

  let sessionManager: FakeSessionManager;
  let disposeNotifier: () => void = () => {};
  let emitBoardChanged: (event: BoardChangedEvent) => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new FakeSessionManager();
  });

  afterEach(() => {
    disposeNotifier();
  });

  async function startNotifier(overrides: Partial<PushNotifierOptions>): Promise<void> {
    const { PushNotifier } = await import('../../src/main/mobile-bridge/push/push-notifier');
    const { BoardEventBus } = await import('../../src/main/mobile-bridge/board-event-bus');
    const boardEvents = new BoardEventBus();
    emitBoardChanged = (event) => boardEvents.emitBoardChanged(event);
    const notifier = new PushNotifier({
      sessionManager: sessionManager as unknown as PushNotifierOptions['sessionManager'],
      registrationStore: { list: () => [REGISTRATION], remove: vi.fn() },
      boardEvents,
      isBridgeEnabled: () => true,
      getConnectedDeviceIds: () => new Set<string>(),
      resolveTaskContext: () => ({ ...TASK_CONTEXT }),
      resolveTaskContextByTaskId: () => ({ ...TASK_CONTEXT }),
      readTaskPlacement: () => ({ swimlaneId: 'lane-1', archived: false, lastMoveOrigin: null }),
      getDeviceStaticPublicKey: () => new Uint8Array(32).fill(9),
      sealEnvelope: (() => 'sealed-blob') as unknown as PushNotifierOptions['sealEnvelope'],
      sealClear: (() => 'sealed-clear') as unknown as PushNotifierOptions['sealClear'],
      wakeChannel: { send: async (): Promise<WakeResult> => ({ delivered: true }) },
      ...overrides,
    });
    notifier.start();
    disposeNotifier = () => notifier.dispose();
  }

  /** A send that quotes the device's token in its error, as a thrown client may. */
  function sendDefect(): TypeError {
    return new TypeError(`posting to ${REGISTRATION.expoPushToken} for ${USER_TEXT} failed`);
  }

  /** A crash: the one trigger that notifies with no debounce. */
  function crashSession(): void {
    sessionManager.emit('exit', 'sess-1', 1, false);
  }

  /** A permission prompt that is notified, then answered at the desk, which queues its clear. */
  async function notifyThenResolvePrompt(): Promise<void> {
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    await vi.advanceTimersByTimeAsync(2_000);
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    await vi.advanceTimersByTimeAsync(5_000);
  }

  it('reports a stored key that will not seal a notification, under stage push_key, and sends nothing', async () => {
    const send = vi.fn(async (): Promise<WakeResult> => ({ delivered: true }));
    await startNotifier({
      sealEnvelope: (() => {
        throw codeDefect();
      }) as unknown as PushNotifierOptions['sealEnvelope'],
      wakeChannel: { send },
    });

    crashSession();
    await vi.advanceTimersByTimeAsync(0);

    expect(send).not.toHaveBeenCalled();
    expectOneReport({ stage: 'push_key', error_name: 'TypeError' });
  });

  it('reports a send that throws, under stage push_send, with no token or title in the report', async () => {
    await startNotifier({
      wakeChannel: {
        send: async () => {
          throw sendDefect();
        },
      },
    });

    crashSession();
    await vi.advanceTimersByTimeAsync(0);

    expectOneReport({ stage: 'push_send', error_name: 'TypeError' });
  });

  it('reports nothing for a send the network refused', async () => {
    const networkFailure = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const send = vi.fn(async (): Promise<WakeResult> => {
      throw networkFailure;
    });
    await startNotifier({ wakeChannel: { send } });

    crashSession();
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a stored key that will not seal a clear, under stage push_key', async () => {
    await startNotifier({
      sealClear: (() => {
        throw codeDefect();
      }) as unknown as PushNotifierOptions['sealClear'],
    });

    await notifyThenResolvePrompt();

    expectOneReport({ stage: 'push_key', error_name: 'TypeError' });
  });

  it('reports a clear whose send throws, under stage push_clear', async () => {
    const sent: WakeMessage[] = [];
    await startNotifier({
      wakeChannel: {
        send: async (message) => {
          sent.push(message);
          if (message.dataKey === PUSH_CLEAR_DATA_KEY) throw sendDefect();
          return { delivered: true };
        },
      },
    });

    await notifyThenResolvePrompt();

    expect(sent.map((message) => message.dataKey)).toContain(PUSH_CLEAR_DATA_KEY);
    expectOneReport({ stage: 'push_clear', error_name: 'TypeError' });
  });

  it('reports a board change whose stale notifications could not be resolved, under stage push_resolve, without failing the move', async () => {
    await startNotifier({
      readTaskPlacement: () => {
        throw codeDefect();
      },
    });
    crashSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(reportHandledError).not.toHaveBeenCalled();

    expect(() => emitBoardChanged({ projectId: TASK_CONTEXT.projectId, change: 'task-updated', ids: [TASK_CONTEXT.taskId] })).not.toThrow();

    expectOneReport({ stage: 'push_resolve', error_name: 'TypeError' });
  });
});

// ---------------------------------------------------------------------------
// The bridge's own feeds: a read or a listener that throws
// ---------------------------------------------------------------------------

describe('the queue place feed', () => {
  const queuedSnapshot: QueueSnapshot = {
    columns: [],
    global: [{ sessionId: 'sess-a', taskId: 'task-a', projectId: 'proj-1', projectName: 'Alpha', title: USER_TEXT, displayId: 1 }],
  };

  async function createFeed(readSnapshot: () => QueueSnapshot): Promise<InstanceType<typeof import('../../src/main/mobile-bridge/queue-place-feed').QueuePlaceFeed>> {
    const { QueuePlaceFeed } = await import('../../src/main/mobile-bridge/queue-place-feed');
    return new QueuePlaceFeed({ sessionManager: new EventEmitter() as never, readSnapshot });
  }

  it('reports a queue read that throws, under stage queue_feed, and tells no listener', async () => {
    const feed = await createFeed(() => {
      throw codeDefect();
    });
    const listener = vi.fn();
    feed.onQueuePlacesChanged(listener);

    expect(() => feed.flush()).not.toThrow();

    expect(listener).not.toHaveBeenCalled();
    expectOneReport({ stage: 'queue_feed', error_name: 'TypeError' });
    feed.dispose();
  });

  it('reports a listener that throws, under stage queue_feed, and still tells the next one', async () => {
    const feed = await createFeed(() => queuedSnapshot);
    const laterListener = vi.fn();
    feed.onQueuePlacesChanged(() => {
      throw codeDefect();
    });
    feed.onQueuePlacesChanged(laterListener);

    expect(() => feed.flush()).not.toThrow();

    expect(laterListener).toHaveBeenCalledWith('proj-1', ['task-a']);
    expectOneReport({ stage: 'queue_feed', error_name: 'TypeError' });
    feed.dispose();
  });
});

describe('the spawn progress feed', () => {
  const fakeWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };

  async function createFeed(resolveProjectIdForTask: (taskId: string) => string | null): Promise<{
    feed: InstanceType<typeof import('../../src/main/mobile-bridge/spawn-progress-feed').SpawnProgressFeed>;
    announceLabel: () => void;
  }> {
    const { SpawnProgressFeed } = await import('../../src/main/mobile-bridge/spawn-progress-feed');
    const { emitSpawnProgress, __resetSpawnProgressForTest } = await import('../../src/main/transition-engine/spawn-progress');
    __resetSpawnProgressForTest();
    const feed = new SpawnProgressFeed({ resolveProjectIdForTask });
    feed.start();
    return { feed, announceLabel: () => emitSpawnProgress(fakeWindow as never, 'task-1', 'fetching') };
  }

  it('reports a project lookup that throws, under stage spawn_feed, without throwing into the spawn', async () => {
    const { feed, announceLabel } = await createFeed(() => {
      throw codeDefect();
    });
    const listener = vi.fn();
    feed.onTaskSpawnProgressChanged(listener);

    expect(announceLabel).not.toThrow();

    expect(listener).not.toHaveBeenCalled();
    expectOneReport({ stage: 'spawn_feed', error_name: 'TypeError' });
    feed.dispose();
  });

  it('reports a listener that throws, under stage spawn_feed, and still tells the next one', async () => {
    const { feed, announceLabel } = await createFeed(() => 'proj-1');
    const laterListener = vi.fn();
    feed.onTaskSpawnProgressChanged(() => {
      throw codeDefect();
    });
    feed.onTaskSpawnProgressChanged(laterListener);

    expect(announceLabel).not.toThrow();

    expect(laterListener).toHaveBeenCalledWith('proj-1', 'task-1');
    expectOneReport({ stage: 'spawn_feed', error_name: 'TypeError' });
    feed.dispose();
  });
});

// ---------------------------------------------------------------------------
// BridgeSession: a frame the paired phone sealed that this build cannot read
// ---------------------------------------------------------------------------

describe('a frame on an established session', () => {
  /** The phone's half of the KK session, driven by hand over a loopback transport. */
  class PhoneResponder {
    private readonly handshake: HandshakeState;
    streams: SecretstreamDirectionPair | null = null;
    readonly received: BridgeMessage[] = [];

    constructor(deviceStatic: ReturnType<typeof generateX25519KeyPair>, desktopStaticPublicKey: Uint8Array, private readonly transport: Transport) {
      this.handshake = createKKHandshake({ initiator: false, localStatic: deviceStatic, remoteStatic: desktopStaticPublicKey });
      transport.onFrame((frame) => this.onFrame(frame));
    }

    private onFrame(rawFrame: Uint8Array): void {
      const { kind, payload } = unwrapSessionFrame(rawFrame);
      if (kind === SessionFrameKind.Handshake) {
        this.handshake.readMessage(payload);
        const { message, split } = this.handshake.writeMessage(new Uint8Array(0));
        this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
        if (split) this.streams = deriveSecretstreamPair(this.handshake.getChainingKey(), false);
        return;
      }
      if (!this.streams) throw new Error('an application frame arrived before the handshake completed');
      this.received.push(decodeMessage(this.streams.receive.open(payload).plaintext));
    }

    /** Seals `plaintext` under the session's keys, whatever it holds. */
    sendSealed(plaintext: Uint8Array): void {
      if (!this.streams) throw new Error('cannot send before the session is established');
      this.transport.send(wrapSessionFrame(SessionFrameKind.Application, this.streams.send.seal(plaintext)));
    }
  }

  async function establishSession(): Promise<{
    session: InstanceType<typeof import('../../src/main/mobile-bridge/session/bridge-session').BridgeSession>;
    phone: PhoneResponder;
    phoneTransport: Transport;
    rejected: unknown[];
  }> {
    const { BridgeSession } = await import('../../src/main/mobile-bridge/session/bridge-session');
    const identity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport, phoneTransport] = createLoopbackTransportPair();
    const phone = new PhoneResponder(deviceStatic, identity.staticKeyPair.publicKey, phoneTransport);
    const session = new BridgeSession({
      identity: identity as never,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(['read-board']) as never,
      transport: desktopTransport,
    });
    const rejected: unknown[] = [];
    session.on('frameRejected', (error: unknown) => rejected.push(error));
    session.on('handshakeFailed', () => undefined);
    const established = new Promise<void>((resolve) => session.once('established', resolve));
    session.start();
    await established;
    return { session, phone, phoneTransport, rejected };
  }

  it('reports a frame the paired phone sealed that will not decode, under stage decode, with nothing the phone sent', async () => {
    const { session, phone, rejected } = await establishSession();

    phone.sendSealed(new TextEncoder().encode(JSON.stringify({ type: `a message kind for ${USER_TEXT}` })));

    expect(rejected).toHaveLength(1);
    expectOneReport({ stage: 'decode', error_name: 'Error' });
    session.dispose();
  });

  it('answers a verb this build does not carry, and reports nothing', async () => {
    const { session, phone, rejected } = await establishSession();

    phone.sendSealed(new TextEncoder().encode(JSON.stringify({ type: 'capability-request', requestId: 'req-9', verb: 'verb-from-a-newer-phone', payload: {} })));

    expect(phone.received).toEqual([expect.objectContaining({ type: 'capability-response', requestId: 'req-9', ok: false, code: 'unsupported-verb' })]);
    expect(rejected).toEqual([]);
    expect(reportHandledError).not.toHaveBeenCalled();
    session.dispose();
  });

  it('reports nothing for bytes on the session slot that nothing authenticated', async () => {
    const { session, phoneTransport, rejected } = await establishSession();

    // Not sealed under the session's keys.
    phoneTransport.send(wrapSessionFrame(SessionFrameKind.Application, new TextEncoder().encode(USER_TEXT)));
    // Not a session frame at all.
    phoneTransport.send(new Uint8Array([250, 1, 2, 3]));
    // A handshake message with no handshake in progress.
    phoneTransport.send(wrapSessionFrame(SessionFrameKind.Handshake, new Uint8Array([9, 9, 9])));

    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(reportHandledError).not.toHaveBeenCalled();
    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// RelayClient: the two dial failures that are not the network, and the ones that are
// ---------------------------------------------------------------------------

describe('a relay dial', () => {
  /** A socket a test opens or fails by hand; it never does either on its own. */
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { type: string; message?: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    send(): void {}

    close(): void {}

    /** The dial never opened: undici fires onerror, then onclose with 1006. */
    failBeforeOpen(): void {
      this.onerror?.({ type: 'error', message: 'connect ECONNREFUSED' });
      this.onclose?.({ code: 1006, reason: '', wasClean: false });
    }
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });

  it('reports a socket that could not be built, under stage relay_socket_build, once however often it redials', async () => {
    const { RelayClient } = await import('../../src/main/mobile-bridge/transport/relay-client');
    class UnbuildableWebSocket {
      constructor(url: string) {
        throw new SyntaxError(`The URL '${url}' is invalid for ${USER_TEXT}`);
      }
    }
    const client = new RelayClient({
      relayUrl: 'wss://acme-relay.example.com',
      slotId: 'slot-1',
      webSocketConstructor: UnbuildableWebSocket as unknown as RelayWebSocketConstructor,
    });

    await expect(client.connect()).rejects.toBeInstanceOf(SyntaxError);
    expectOneReport({ stage: 'relay_socket_build', error_name: 'SyntaxError' });

    // The reconnect timer and a redial kick fail the same way.
    await vi.advanceTimersByTimeAsync(500);
    client.redialNow({ reason: 'test kick' });
    await vi.advanceTimersByTimeAsync(0);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('reports a relay address that will not parse, under stage relay_url, and never sends the address', async () => {
    const { RelayClient } = await import('../../src/main/mobile-bridge/transport/relay-client');
    const client = new RelayClient({ relayUrl: 'acme relay, not an address', slotId: 'slot-1' });

    await expect(client.connect()).rejects.toBeInstanceOf(TypeError);

    expect(client.state).toBe('closed');
    expectOneReport({ stage: 'relay_url', error_name: 'TypeError' });
    client.close();
  });

  it('reports nothing for a dial that never opened, at connect, on the reconnect timer, on a redial kick, or when closed mid-dial', async () => {
    const { RelayClient, RelayDialError } = await import('../../src/main/mobile-bridge/transport/relay-client');
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.com',
      slotId: 'slot-1',
      webSocketConstructor: FakeWebSocket as unknown as RelayWebSocketConstructor,
    });

    // The first dial, which a caller awaits.
    const firstDial = expect(client.connect()).rejects.toBeInstanceOf(RelayDialError);
    FakeWebSocket.instances[0].failBeforeOpen();
    await firstDial;

    // The reconnect timer's dial, which nothing awaits.
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].failBeforeOpen();
    await vi.advanceTimersByTimeAsync(0);

    // A redial kick from backoff.
    client.redialNow({ reason: 'test kick' });
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2].failBeforeOpen();
    await vi.advanceTimersByTimeAsync(0);

    // A dial in flight when the client is closed.
    client.redialNow({ reason: 'test kick' });
    expect(FakeWebSocket.instances).toHaveLength(4);
    client.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
