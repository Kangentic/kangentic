/**
 * What a user loses if these reports go quiet. Each failure below was caught where
 * it happened and only logged, so the app carried on wrong with nothing on screen
 * and nothing in Sentry:
 *
 * - a queued agent that never starts and a card that stays Queued, or a column's
 *   agent limit switched off by a gate that threw;
 * - a turn end or a resume whose listeners never ran, so a column's automations
 *   and a workflow's step check were skipped;
 * - a card with no model, tokens or activity because a status, events or history
 *   parser threw, and a distro CLI whose hook events or answers never landed;
 * - a pty host that dropped every transcript chunk of a project, left what a dead
 *   shell started running, or fell back to a slower process listing;
 * - a remote host whose terminals stayed blank after a reconnect.
 *
 * Main's sites report through `sessionManagerReporter` (source `session_manager`,
 * tag `stage`). Code that runs in the pty host cannot load a reporter, so it
 * relays a fixed code as a `handledError` event and main reports it (source
 * `pty_host`, tag `code`).
 *
 * Each case runs the real module, makes one dependency throw, and reads what left:
 * the source and stage that reached `reportHandledError`, or the event a fake
 * `emit` received. The thrown text names a made-up customer, and every case
 * asserts it is in nothing that was sent. Where a site guards an outcome that is
 * not a defect (a file that is not there yet, a host that is down, a dropped SSH
 * link), a second case asserts nothing is sent.
 *
 * Only `reportHandledError` is mocked on the reporting path. node-pty, the shell
 * lookup, analytics and, for the utility transport alone, Electron's fork are
 * replaced so the real SessionManager and transport can run in a test at all.
 * Modules are imported again per test (`vi.resetModules`): a reporter latches a
 * key once per run and stops at 25 keys.
 */
import { EventEmitter } from 'node:events';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { duplexPair, type Duplex } from 'node:stream';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as nodePty from 'node-pty';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { TurnStartCause } from '../../src/main/activity-engine/engine';
import type { DeadRootOrphanApi } from '../../src/main/pty/host/dead-root-orphans';
import type { HostSpawnService, ProcessTableProbe } from '../../src/main/pty/host/host-spawn-service';
import type { PtyHostEvent, PtyHostHandledErrorCode } from '../../src/main/pty/host/protocol';
import type { PtyHostLifecycleListener, PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { UtilityPtyHostTransport } from '../../src/main/pty/host/utility-pty-host-transport';
import type { TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';
import type { TaggedReapRequest } from '../../src/main/pty/process-tag/tagged-reap';
import type { StatusFileHook, StatusFileReaderCallbacks } from '../../src/main/pty/readers/status-file-reader';
import type { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import { EventType } from '../../src/shared/types';
import type { AdapterRuntimeStrategy, AgentParser, SessionEvent, SpawnSessionInput } from '../../src/shared/types';
import { reportedText } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

/** What node-pty's spawn and Electron's fork hand back, set per test. */
const harness = vi.hoisted(() => ({ ptySpawn: vi.fn(), fork: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: harness.ptySpawn }));

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

/** Text a user wrote, which a runtime error quotes and no report may carry. */
const USER_TEXT = 'Fix Acme billing export';
/** Task ids are uuids: anything else never reaches a process scan. */
const TASK_ID = '11111111-1111-4111-8111-111111111111';
/** `vi.waitFor`'s default budget is 1 s, short of a file watcher's 1 s poll under CI load. */
const WAIT = { timeout: 5_000, interval: 20 };

type SessionHistoryHook = NonNullable<AdapterRuntimeStrategy['sessionHistory']>;
type HandledErrorEvent = Extract<PtyHostEvent, { type: 'handledError' }>;
type ReportCall = [Error, Record<string, string>, unknown?, unknown?];

let tmpDir = '';
const cleanups: Array<() => void | Promise<void>> = [];
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  harness.ptySpawn.mockReset();
  harness.fork.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-pty-reports-'));
  // Every site logs beside its report; the log lines are not what these cases read.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  // Spies on `fs` come off first: the cleanup below removes files with it.
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.doUnmock('electron');
  vi.doUnmock('../../src/main/agent/background-shell-hint-bridge');
  vi.doUnmock('../../src/main/pty/process-tag/win32-reader');
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A code defect whose text quotes what a user wrote, as V8's own messages do. */
function defect(step: string): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${USER_TEXT}') in ${step}`);
}

/** A failure of the user's disk that is not "the file is not there". */
function accessDenied(): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, open '${USER_TEXT}'`), { code: 'EPERM', syscall: 'open' });
}

function reportsFor(source: string, tagName: string, tagValue: string): ReportCall[] {
  return (reportHandledError.mock.calls as ReportCall[])
    .filter(([, tags]) => tags.source === source && tags[tagName] === tagValue);
}

/** Nothing that reached Sentry's send carries the text the failure quoted. */
function expectNoUserText(): void {
  expect(reportedText(reportHandledError)).not.toMatch(/acme/i);
}

/** One report left main for this stage, with the fixed message. Returns its tags. */
function expectStageReported(stage: string): Record<string, string> {
  const matching = reportsFor('session_manager', 'stage', stage);
  expect(matching).toHaveLength(1);
  const [sent, tags] = matching[0];
  expect(tags).toMatchObject({ source: 'session_manager', stage });
  expect(sent.message).toBe(`Handled session_manager failure: ${tags.error_name}`);
  expectNoUserText();
  return tags;
}

function expectStageNotReported(stage: string): void {
  expect(reportsFor('session_manager', 'stage', stage)).toHaveLength(0);
}

function relayed(events: readonly PtyHostEvent[]): HandledErrorEvent[] {
  return events.filter((event): event is HandledErrorEvent => event.type === 'handledError');
}

function relayedCodes(events: readonly PtyHostEvent[]): PtyHostHandledErrorCode[] {
  return relayed(events).map((event) => event.code);
}

/**
 * The host relayed this code once, as the fixed code and the error's wire shape
 * and no field beside them. Returns the event.
 */
async function expectRelayedOnce(
  events: readonly PtyHostEvent[],
  code: PtyHostHandledErrorCode,
  thrown: unknown,
): Promise<HandledErrorEvent> {
  const { toPtyHostError } = await import('../../src/main/pty/host/protocol');
  const matching = relayed(events).filter((event) => event.code === code);
  expect(matching).toHaveLength(1);
  expect(matching[0]).toEqual({ type: 'handledError', code, error: toPtyHostError(thrown) });
  return matching[0];
}

/** Main's half of a relay: the code as a tag, the fixed message, and none of the host's text. */
async function expectMainReportsRelay(event: HandledErrorEvent): Promise<void> {
  const { reportPtyHostHandledError } = await import('../../src/main/pty/host/pty-host-report');
  reportPtyHostHandledError(event);
  const matching = reportsFor('pty_host', 'code', event.code);
  expect(matching).toHaveLength(1);
  expect(matching[0][0].message).toBe(`Handled pty_host failure: ${matching[0][1].error_name}`);
  expectNoUserText();
}

/** A fake PTY for node-pty's mocked spawn: a kill is followed by its exit. */
function createMockPty(): nodePty.IPty {
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;
  return {
    pid: 12345,
    cols: 120,
    rows: 30,
    onData: () => ({ dispose: () => undefined }),
    onExit: (callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
      return { dispose: () => { exitHandler = null; } };
    },
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: () => {
      const handler = exitHandler;
      if (handler) setTimeout(() => handler({ exitCode: 0 }), 0);
    },
  } as unknown as nodePty.IPty;
}

/** A fake PTY whose shell a test writes output for and ends by hand. */
function createExitablePty(pid: number): { pty: nodePty.IPty; feed(data: string): void; exit(exitCode: number): void } {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  const pty = {
    pid,
    cols: 120,
    rows: 30,
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
      return { dispose: () => { dataListener = null; } };
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => { exitListener = null; } };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as nodePty.IPty;
  return { pty, feed: (data) => dataListener?.(data), exit: (exitCode) => exitListener?.({ exitCode }) };
}

/** What a spawn request to the host carries, less the PTY id the client assigns. */
function hostSpawnParams(sessionId: string, hostId?: string) {
  return {
    sessionId,
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'mock-shell',
    args: [],
    cwd: tmpDir,
    env: {},
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
    taskId: 'task-1',
    hostId,
  };
}

function spawnInput(overrides: Partial<SpawnSessionInput>): SpawnSessionInput {
  return { taskId: 'task-1', projectId: 'project-1', command: '', cwd: tmpDir, ...overrides } as SpawnSessionInput;
}

/** A real SessionManager over the pty host core running in this process. */
async function startManager(prepareTransport?: (transport: PtyHostTransport) => void): Promise<SessionManager> {
  const { SessionManager: SessionManagerClass } = await import('../../src/main/pty/session-manager');
  const { InProcessPtyHostTransport } = await import('../../src/main/pty/host/pty-host-client');
  const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
  prepareTransport?.(transport);
  const manager = new SessionManagerClass({ ptyHostTransport: transport });
  cleanups.push(async () => {
    manager.killAll();
    // A killed fake PTY reports its exit on the next timer turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.dispose();
  });
  return manager;
}

/** Make the host answer one method with a failure, and every other as it would. */
function failRequest(transport: PtyHostTransport, method: string, failure: Error): void {
  const answer = transport.request.bind(transport) as unknown as (
    requested: string, params: unknown, options?: unknown,
  ) => Promise<unknown>;
  transport.request = ((requested: string, params: unknown, options?: unknown) => (
    requested === method ? Promise.reject(failure) : answer(requested, params, options)
  )) as unknown as PtyHostTransport['request'];
}

function telemetryOf(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

/** The callbacks the manager hands its telemetry, which the engine calls at a turn's edges. */
interface TurnEdgeCallbacks {
  onTurnStarted(sessionId: string, turnStartedAt: number, cause: TurnStartCause): void;
  onTurnEnded(sessionId: string, turnStartedAt: number | null, workSerial: number): void;
  onTurnEndedHeld(sessionId: string, turnStartedAt: number | null, workSerial: number): void;
}

function turnEdgesOf(manager: SessionManager): TurnEdgeCallbacks {
  return (telemetryOf(manager) as unknown as { callbacks: TurnEdgeCallbacks }).callbacks;
}

/** A task session with no PTY yet, which is all a turn edge needs. */
function placeholderSession(manager: SessionManager): string {
  const session = manager.registerSuspendedPlaceholder({ taskId: 'task-1', projectId: 'project-1', cwd: tmpDir });
  if (!session) throw new Error('The placeholder was not registered.');
  return session.id;
}

/** A history hook whose file is there and whose per-session parser cannot be made. */
function historyHookThatCannotStart(): SessionHistoryHook {
  const historyFile = path.join(tmpDir, 'history.jsonl');
  fs.writeFileSync(historyFile, '{"type":"message"}\n');
  return {
    locate: async () => historyFile,
    parse: () => ({ usage: null, events: [] }),
    createParse: () => { throw defect('the history parser'); },
    isFullRewrite: false,
  } as unknown as SessionHistoryHook;
}

describe('the session queue', () => {
  function queuedInput(id: string): SpawnSessionInput & { id: string } {
    return { ...spawnInput({ taskId: `task-${id}` }), id };
  }

  it('reports queue_gate when the gate cannot say whether a start must wait, and admits it', async () => {
    const { SessionQueue } = await import('../../src/main/pty/session-queue');
    const queue = new SessionQueue({ spawner: async () => undefined, getActiveCount: () => 0, maxConcurrent: 2 });
    queue.setGate({ mustWait: () => { throw defect('the column limit'); }, pick: () => 0, countBlocked: () => 0 });

    expect(queue.shouldQueue({ taskId: 'task-1', projectId: 'project-1' })).toBe(false);

    expectStageReported('queue_gate');
  });

  it('reports queue_gate when the gate cannot pick the next start, and starts the head', async () => {
    const { SessionQueue } = await import('../../src/main/pty/session-queue');
    const started: string[] = [];
    const queue = new SessionQueue({
      spawner: async (input) => { started.push(input.taskId); },
      getActiveCount: () => 0,
      maxConcurrent: 2,
    });
    queue.setGate({ mustWait: () => false, pick: () => { throw defect('the pick'); }, countBlocked: () => 0 });
    queue.enqueue(queuedInput('a'));

    queue.notifySlotFreed();

    await vi.waitFor(() => expect(started).toEqual(['task-a']));
    expectStageReported('queue_gate');
  });

  it('reports queue_gate when the gate cannot count who waits on it, and counts none', async () => {
    const { SessionQueue } = await import('../../src/main/pty/session-queue');
    const queue = new SessionQueue({ spawner: async () => undefined, getActiveCount: () => 5, maxConcurrent: 2 });
    queue.setGate({ mustWait: () => false, pick: () => 0, countBlocked: () => { throw defect('the count'); } });
    queue.enqueue(queuedInput('a'));

    expect(queue.blockedCount).toBe(0);

    expectStageReported('queue_gate');
  });

  it('reports queued_spawn when a queued agent fails to start, and goes on to the next one', async () => {
    const { SessionQueue } = await import('../../src/main/pty/session-queue');
    const started: string[] = [];
    const queue = new SessionQueue({
      spawner: async (input) => {
        if (input.taskId === 'task-a') throw defect('the queued start');
        started.push(input.taskId);
      },
      getActiveCount: () => 0,
      maxConcurrent: 2,
    });
    queue.enqueue(queuedInput('a'));
    queue.enqueue(queuedInput('b'));

    queue.notifySlotFreed();

    await vi.waitFor(() => expect(started).toEqual(['task-b']));
    expectStageReported('queued_spawn');
  });

  it('reports queue_loop when the loop itself throws, where no spawn was the cause', async () => {
    const { SessionQueue } = await import('../../src/main/pty/session-queue');
    const queue = new SessionQueue({
      spawner: async () => undefined,
      getActiveCount: () => { throw defect('the active count'); },
      maxConcurrent: 2,
    });
    queue.enqueue(queuedInput('a'));

    queue.notifySlotFreed();

    await vi.waitFor(() => expectStageReported('queue_loop'));
    // The entry is still waiting: nothing queued starts until the next slot frees.
    expect(queue.length).toBe(1);
  });
});

describe('SessionManager', { timeout: 30_000 }, () => {
  it('reports turn_ended_listener when a turn-ended listener throws, and the engine goes on', async () => {
    const manager = await startManager();
    const sessionId = placeholderSession(manager);
    manager.on('turn-ended', () => { throw defect('a turn-end automation'); });

    expect(() => turnEdgesOf(manager).onTurnEnded(sessionId, Date.now(), 1)).not.toThrow();

    expectStageReported('turn_ended_listener');
  });

  it('reports turn_ended_held_listener when a turn-ended-held listener throws', async () => {
    const manager = await startManager();
    const sessionId = placeholderSession(manager);
    manager.on('turn-ended-held', () => { throw defect('a held turn-end listener'); });

    expect(() => turnEdgesOf(manager).onTurnEndedHeld(sessionId, Date.now(), 1)).not.toThrow();

    expectStageReported('turn_ended_held_listener');
  });

  it('reports session_resumed_listener when a resume listener throws, and keeps the spawn', async () => {
    harness.ptySpawn.mockImplementation(() => createMockPty());
    const manager = await startManager();
    manager.on('session-resumed', () => { throw defect('the resume follow-up'); });

    const session = await manager.spawn(spawnInput({ taskId: 'task-resumed', resuming: true }));

    expect(session.status).toBe('running');
    expectStageReported('session_resumed_listener');
  });

  it('reports queued_command_rebuild when a waiting agent cannot take new settings', async () => {
    harness.ptySpawn.mockImplementation(() => createMockPty());
    const manager = await startManager();
    manager.setMaxConcurrent(1);
    await manager.spawn(spawnInput({ taskId: 'task-running' }));
    const queued = await manager.spawn(spawnInput({
      taskId: 'task-queued',
      command: 'original-command',
      rebuildCommand: () => { throw defect('the command build'); },
    }));
    expect(queued.status).toBe('queued');

    expect(manager.rebuildQueuedCommand(queued.id, { model: 'sonnet', effort: 'high' })).toBe(false);

    expectStageReported('queued_command_rebuild');
    expect(manager.listQueuedInputs().find((entry) => entry.id === queued.id)?.command).toBe('original-command');
  });

  it('reports message_trail_read when the transcript position cannot be read at a turn start', async () => {
    const manager = await startManager();
    const sessionId = placeholderSession(manager);
    manager.setTranscriptPositionSource({
      transcriptPosition: () => { throw defect('the trail position'); },
      hasPendingRead: () => false,
      hasReadInFlight: () => false,
    });

    expect(() => turnEdgesOf(manager).onTurnStarted(sessionId, Date.now(), 'plan-approval')).not.toThrow();

    expectStageReported('message_trail_read');
  });

  it('reports message_trail_read when the read-in-flight check throws at a turn start', async () => {
    const manager = await startManager();
    const sessionId = placeholderSession(manager);
    manager.setTranscriptPositionSource({
      transcriptPosition: () => null,
      hasPendingRead: () => false,
      hasReadInFlight: () => { throw defect('the read-in-flight check'); },
    });

    expect(() => turnEdgesOf(manager).onTurnStarted(sessionId, Date.now(), 'plan-approval')).not.toThrow();

    expectStageReported('message_trail_read');
  });

  it('reports earlier_run_totals when the earlier runs cannot be read, and still answers', async () => {
    const manager = await startManager();
    const sessionId = placeholderSession(manager);
    manager.setEarlierRunsSource({
      readToolTotals: () => { throw defect('the earlier runs'); },
      fillMissingResultTokens: async () => false,
    });

    expect(manager.refreshToolBreakdownAcrossRuns(sessionId)).toEqual([]);

    expectStageReported('earlier_run_totals');
  });

  it('reports task_tree_probe when a host that is up fails the probe, and answers could not tell', async () => {
    const manager = await startManager((transport) => failRequest(transport, 'probeTaskProcesses', defect('the probe')));

    const answer = await manager.probeTaskProcesses(tmpDir, [{ id: TASK_ID, worktreePath: null }], { connections: false });

    expect(answer).toBeNull();
    expectStageReported('task_tree_probe');
  });

  it('reports nothing for a probe the host was too slow to answer', async () => {
    const { PtyHostTimeoutError } = await import('../../src/main/pty/host/pty-host-request-errors');
    const manager = await startManager((transport) => failRequest(transport, 'probeTaskProcesses', new PtyHostTimeoutError('probeTaskProcesses')));

    const answer = await manager.probeTaskProcesses(tmpDir, [{ id: TASK_ID, worktreePath: null }], { connections: false });

    expect(answer).toBeNull();
    expectStageNotReported('task_tree_probe');
  });

  it('reports project_close when a host that is up cannot close a project database', async () => {
    const manager = await startManager((transport) => failRequest(transport, 'closeProject', defect('the close')));

    await expect(manager.closeProjectInPtyHost('project-1')).resolves.toBeUndefined();

    expectStageReported('project_close');
  });

  it('reports nothing for a close the host never got because it had exited', async () => {
    const { PtyHostExitedError } = await import('../../src/main/pty/host/pty-host-request-errors');
    const manager = await startManager((transport) => failRequest(transport, 'closeProject', new PtyHostExitedError()));

    await expect(manager.closeProjectInPtyHost('project-1')).resolves.toBeUndefined();

    expectStageNotReported('project_close');
  });

  it('reports history_attach when the history reader cannot attach to a captured conversation', async () => {
    const manager = await startManager();
    const agentParser = {
      runtime: { activity: { kind: 'pty' }, sessionHistory: historyHookThatCannotStart() },
    } as unknown as AgentParser;
    const registry = (manager as unknown as { registry: { set(id: string, session: ManagedSession): void } }).registry;
    registry.set('session-1', {
      id: 'session-1',
      taskId: 'task-1',
      projectId: 'project-1',
      pty: null,
      status: 'running',
      shell: 'bash',
      cwd: tmpDir,
      commandCwd: tmpDir,
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: [],
      agentParser,
    });

    // The agent reported its conversation id through a hook, as Codex and Gemini do.
    telemetryOf(manager).notifyAgentSessionId('session-1', 'agent-session-1', 'hook');

    await vi.waitFor(() => expectStageReported('history_attach'), WAIT);
  });

  it('reports history_attach when the reader cannot attach at spawn to a caller-owned conversation', async () => {
    harness.ptySpawn.mockImplementation(() => createMockPty());
    const manager = await startManager();
    const agentParser = {
      detectFirstOutput: () => false,
      removeHooks: () => undefined,
      runtime: { sessionHistory: historyHookThatCannotStart() },
    } as unknown as AgentParser;

    const session = await manager.spawn(spawnInput({ agentSessionId: 'agent-session-1', agentParser }));

    expect(session.status).toBe('running');
    await vi.waitFor(() => expectStageReported('history_attach'), WAIT);
  });

  it('reports launcher_write when the launcher file cannot be written, and types the command instead', async () => {
    // A command too long to type gets a launcher file beside the session's status
    // file. A folder already sits where that file goes, so the write fails.
    const sessionDirectory = path.join(tmpDir, 'session');
    fs.mkdirSync(path.join(sessionDirectory, 'launch.sh'), { recursive: true });
    harness.ptySpawn.mockImplementation(() => createMockPty());
    const manager = await startManager();
    // Only a POSIX terminal sources a launcher, so the spawn is read as one on every OS.
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const session = await manager.spawn(spawnInput({
      command: `agent --append-system-prompt '${'x'.repeat(1500)}'`,
      statusOutputPath: path.join(sessionDirectory, 'status.json'),
    }));
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);

    expect(session.status).toBe('running');
    expectStageReported('launcher_write');
  });
});

describe('main around a session', { timeout: 30_000 }, () => {
  it('reports hooks_release when an adapter cannot strip its hooks from a shared file', async () => {
    const { releaseCommandHold } = await import('../../src/main/pty/lifecycle/adapter-lifecycle');
    const agentParser = { removeHooks: () => { throw defect('the hook strip'); } } as unknown as AgentParser;

    expect(() => releaseCommandHold(agentParser, tmpDir, 'session-1')).not.toThrow();

    expectStageReported('hooks_release');
  });

  it('reports typed_text_record when Kangentic cannot record its own text, and still types it', async () => {
    const { TerminalSubmit } = await import('../../src/main/pty/terminal-submit');
    type SubmitArguments = ConstructorParameters<typeof TerminalSubmit>;
    const pasteAndSubmit = vi.fn(async () => undefined);
    const submit = new TerminalSubmit(
      { markUserInput: () => undefined } as unknown as SubmitArguments[0],
      { pasteAndSubmit } as unknown as SubmitArguments[1],
      () => { throw defect('the typed-text record'); },
    );

    await submit.submitContent('session-1', 'run the tests');

    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    expectStageReported('typed_text_record');
  });
});

describe('PtyHostClient after a host is lost', () => {
  async function startClient() {
    const { PtyHostClient } = await import('../../src/main/pty/host/pty-host-client');
    let lifecycle: PtyHostLifecycleListener | undefined;
    let eventListener: ((event: PtyHostEvent) => void) | undefined;
    const transport: PtyHostTransport = {
      post: () => undefined,
      attachRendererPort: () => undefined,
      request: (async () => ({ ok: true, pid: 4321 })) as unknown as PtyHostTransport['request'],
      setEventListener: (listener) => { eventListener = listener; },
      setLifecycleListener: (listener) => { lifecycle = listener; },
      stopLostPtyTree: () => undefined,
      hostPid: 1234,
      shutdown: () => undefined,
    };
    const client = new PtyHostClient(transport);
    const lostSessions: string[][] = [];
    client.setLifecycleHandler({ onHostLost: (ids) => lostSessions.push(ids), onHostRestarted: () => undefined });
    return {
      client,
      lostSessions,
      loseHost: () => lifecycle?.onHostDown(),
      emit: (event: PtyHostEvent) => eventListener?.(event),
    };
  }

  it('reports host_lost_exit when a session\'s exit handling throws, and still names the lost session', async () => {
    const { client, lostSessions, loseHost } = await startClient();
    const spawned = await client.spawn(hostSpawnParams('local-1'));
    if (!spawned.ok) throw new Error('The fake host refused the spawn.');
    client.onPtyExit(spawned.pty.ptyId, () => { throw defect('the exit handling'); });

    expect(() => loseHost()).not.toThrow();

    expectStageReported('host_lost_exit');
    expect(lostSessions).toEqual([['local-1']]);
  });

  it('reports host_lost_exit when an agent run cannot be failed after the host was lost', async () => {
    const { client, loseHost } = await startClient();
    const run = client.spawnCli('agent', ['--print'], {} as Parameters<typeof client.spawnCli>[2]);
    run.on('exit', () => { throw defect('the run\'s exit listener'); });

    expect(() => loseHost()).not.toThrow();

    expectStageReported('host_lost_exit');
  });

  it('reports host_lost_exit when the exit handling of a session its SSH host lost throws', async () => {
    const { client, lostSessions, emit } = await startClient();
    const spawned = await client.spawn(hostSpawnParams('remote-1', 'host-a'));
    if (!spawned.ok) throw new Error('The fake host refused the spawn.');
    client.onPtyExit(spawned.pty.ptyId, () => { throw defect('the remote exit handling'); });

    expect(() => emit({ type: 'remoteSessions', hostId: 'host-a', lost: ['remote-1'], adoptable: [] })).not.toThrow();

    expectStageReported('host_lost_exit');
    expect(lostSessions).toEqual([['remote-1']]);
  });
});

describe('the utility pty host transport', { timeout: 30_000 }, () => {
  class FakeHostProcess extends EventEmitter {
    readonly posted: unknown[] = [];
    readonly kill = vi.fn();
    constructor(readonly pid: number) {
      super();
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    lastRequestId(): number {
      const requests = this.posted.filter((message) => (message as { type?: string }).type === 'request');
      return (requests[requests.length - 1] as { id: number }).id;
    }
  }

  /** A forked host that said ready, with fake timers running. */
  async function startHost(): Promise<{ transport: UtilityPtyHostTransport; host: FakeHostProcess }> {
    vi.doMock('electron', () => ({ app: { isPackaged: false }, utilityProcess: { fork: harness.fork } }));
    const forks: FakeHostProcess[] = [];
    harness.fork.mockImplementation(() => {
      const forked = new FakeHostProcess(1000 + forks.length);
      forks.push(forked);
      return forked;
    });
    const { UtilityPtyHostTransport: Transport } = await import('../../src/main/pty/host/utility-pty-host-transport');
    vi.useFakeTimers();
    const transport = new Transport({ projectsDir: path.join(tmpDir, 'projects') });
    transport.setEventListener(() => undefined);
    transport.setLifecycleListener({ onHostDown: () => undefined, onHostUp: () => undefined });
    transport.start();
    const host = forks[0];
    host.emit('message', { type: 'ready' });
    cleanups.push(() => transport.shutdown());
    return { transport, host };
  }

  /** The host answers a request with an error of its own. */
  function failedReply(id: number): unknown {
    return { type: 'reply', id, ok: false, error: { message: `the handler broke on ${USER_TEXT}`, name: 'TypeError' } };
  }

  it('reports late_reap_answer when the late answer of a timed-out reap cannot be handled', async () => {
    const { transport, host } = await startHost();
    const request: TaggedReapRequest = { tasks: [], mainPid: 1, stop: true };
    const outcome = transport.request('reapTaggedProcesses', request, {
      timeoutMs: 1_000,
      onLateResult: () => { throw defect('the late reap answer'); },
    }).catch((error: unknown) => error);
    const requestId = host.lastRequestId();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await outcome).toMatchObject({ name: 'PtyHostTimeoutError' });

    // The host finishes the reap after main stopped waiting for it.
    host.emit('message', {
      type: 'reply',
      id: requestId,
      ok: true,
      result: { killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, failureCause: null, entries: [] },
    });

    expectStageReported('late_reap_answer');
  });

  it('reports heartbeat_ping when the host answers its ping with an error', async () => {
    const { host } = await startHost();
    await vi.advanceTimersByTimeAsync(5_000);

    host.emit('message', failedReply(host.lastRequestId()));
    await vi.advanceTimersByTimeAsync(0);

    expectStageReported('heartbeat_ping');
    // The beat never stalled, so no stall report goes with it.
    expect(reportsFor('pty_host', 'code', 'heartbeat_stall')).toHaveLength(0);
  });

  it('reports heartbeat_ping for a stalled beat too, and invents no stall outcome for it', async () => {
    const { host } = await startHost();
    await vi.advanceTimersByTimeAsync(5_000);
    const pingId = host.lastRequestId();
    // Past the 11 s threshold and short of the ping's own 15 s budget: the beat is stalled.
    await vi.advanceTimersByTimeAsync(12_000);

    host.emit('message', failedReply(pingId));
    await vi.advanceTimersByTimeAsync(0);

    expectStageReported('heartbeat_ping');
    // An error reply is neither an answer nor a lost host, so the stall is not reported as either.
    expect(reportsFor('pty_host', 'code', 'heartbeat_stall')).toHaveLength(0);
  });

  it('reports no heartbeat_ping for a host that exited before it answered', async () => {
    const { host } = await startHost();
    await vi.advanceTimersByTimeAsync(5_000);

    host.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);

    expectStageNotReported('heartbeat_ping');
  });
});

describe('the status file reader', () => {
  function statusHook(overrides: Partial<StatusFileHook>): StatusFileHook {
    return { parseStatus: () => null, parseEvent: () => null, isFullRewrite: true, ...overrides } as unknown as StatusFileHook;
  }

  async function startReader(callbacks: Partial<StatusFileReaderCallbacks> = {}) {
    const { StatusFileReader } = await import('../../src/main/pty/readers/status-file-reader');
    const reader = new StatusFileReader({
      onUsageParsed: () => undefined,
      onEventsParsed: () => undefined,
      onFirstStatus: () => undefined,
      ...callbacks,
    });
    cleanups.push(() => reader.disposeAll());
    return reader;
  }

  function statusFile(): string {
    const statusPath = path.join(tmpDir, 'status.json');
    fs.writeFileSync(statusPath, '{"model":"some-model"}');
    return statusPath;
  }

  function eventsFile(): string {
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '{"type":"prompt"}\n');
    return eventsPath;
  }

  const promptEvent: SessionEvent = { ts: 1, type: EventType.Prompt };

  it('reports status_parse when the adapter cannot read the events a status write carries', async () => {
    const reader = await startReader();

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusFile(),
      eventsOutputPath: null,
      statusFileHook: statusHook({ parseStatusEvents: () => { throw defect('the status events parser'); } }),
    });

    await vi.waitFor(() => expectStageReported('status_parse'), WAIT);
  });

  it('reports events_dispatch when the events a status write carries cannot be handed on', async () => {
    const reader = await startReader({ onEventsParsed: () => { throw defect('the engine'); } });

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusFile(),
      eventsOutputPath: null,
      statusFileHook: statusHook({ parseStatusEvents: () => [promptEvent] }),
    });

    await vi.waitFor(() => expectStageReported('events_dispatch'), WAIT);
  });

  it('reports status_usage_dispatch when the adapter cannot read a status write\'s usage', async () => {
    const reader = await startReader();

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: statusFile(),
      eventsOutputPath: null,
      statusFileHook: statusHook({ parseStatus: () => { throw defect('the usage parser'); } }),
    });

    await vi.waitFor(() => expectStageReported('status_usage_dispatch'), WAIT);
  });

  it('reports events_dispatch when new lines of the events file cannot be handed on', async () => {
    const reader = await startReader({ onEventsParsed: () => { throw defect('the engine'); } });
    const eventsPath = eventsFile();

    reader.attach({ sessionId: 'session-1', statusOutputPath: null, eventsOutputPath: eventsPath, statusFileHook: null });
    // A hook appends a line; the watcher or its poll reads the file from the start.
    fs.appendFileSync(eventsPath, '{"type":"tool_start"}\n');

    await vi.waitFor(() => expectStageReported('events_dispatch'), WAIT);
  });

  it('reports events_flush when a session\'s last events cannot be handed on at its exit', async () => {
    const reader = await startReader({ onEventsParsed: () => { throw defect('the engine'); } });
    reader.attach({ sessionId: 'session-1', statusOutputPath: null, eventsOutputPath: eventsFile(), statusFileHook: null });

    expect(() => reader.flushPendingEvents('session-1')).not.toThrow();

    expectStageReported('events_flush');
  });

  it('reports nothing for an events file that is not there at the exit flush', async () => {
    const reader = await startReader({ onEventsParsed: () => { throw defect('the engine'); } });
    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: null,
      eventsOutputPath: path.join(tmpDir, 'never-written', 'events.jsonl'),
      statusFileHook: null,
    });

    expect(() => reader.flushPendingEvents('session-1')).not.toThrow();

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing for a status file the agent has not written yet', async () => {
    const reader = await startReader();
    const missingStatusPath = path.join(tmpDir, 'status.json');

    reader.attach({
      sessionId: 'session-1',
      statusOutputPath: missingStatusPath,
      eventsOutputPath: null,
      statusFileHook: statusHook({ parseStatus: () => { throw defect('a parser that must not run'); } }),
    });
    // The reader's own read of the missing file was started first, and has failed by now.
    await expect(fsPromises.readFile(missingStatusPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the session history reader', () => {
  async function startReader() {
    const { SessionHistoryReader } = await import('../../src/main/pty/readers/session-history-reader');
    const reader = new SessionHistoryReader({
      onUsageUpdate: () => undefined,
      onEvents: () => undefined,
      onActivity: () => undefined,
      onFirstTelemetry: () => undefined,
    });
    cleanups.push(() => reader.disposeAll());
    return reader;
  }

  function historyHook(overrides: Partial<SessionHistoryHook>): SessionHistoryHook {
    return {
      locate: async () => null,
      parse: () => ({ usage: null, events: [] }),
      isFullRewrite: false,
      ...overrides,
    } as unknown as SessionHistoryHook;
  }

  it('reports history_locate when the adapter\'s locator throws', async () => {
    const reader = await startReader();

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
      cwd: tmpDir,
      hook: historyHook({ locate: async () => { throw defect('the locator'); } }),
    });

    expectStageReported('history_locate');
    expect(reader.isAttached('session-1')).toBe(false);
  });

  // A locator also runs other programs (a CLI's own listing, a distro's shell). Their
  // failure is a plain Error and theirs, so it is logged and not filed.
  it('reports nothing when the locator fails with another program\'s plain Error', async () => {
    const reader = await startReader();

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
      cwd: tmpDir,
      hook: historyHook({ locate: async () => { throw new Error('the CLI exited 1 while listing its sessions'); } }),
    });

    expect(reportHandledError).not.toHaveBeenCalled();
    expect(reader.isAttached('session-1')).toBe(false);
  });

  it('reports history_parse when the adapter cannot parse what the history file holds', async () => {
    const reader = await startReader();
    const historyFile = path.join(tmpDir, 'history.jsonl');
    fs.writeFileSync(historyFile, '{"type":"message"}\n');

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
      cwd: tmpDir,
      hook: historyHook({ locate: async () => historyFile, parse: () => { throw defect('the history parser'); } }),
    });

    expectStageReported('history_parse');
    // The tail stays up: the next change is parsed on its own.
    expect(reader.isAttached('session-1')).toBe(true);
  });

  it('reports nothing for a history file that is gone by the first read', async () => {
    const reader = await startReader();

    await reader.attach({
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
      cwd: tmpDir,
      hook: historyHook({
        locate: async () => path.join(tmpDir, 'gone.jsonl'),
        parse: () => { throw defect('a parser that must not run'); },
      }),
    });

    expect(reportHandledError).not.toHaveBeenCalled();
    expect(reader.isAttached('session-1')).toBe(false);
  });
});

describe('the WSL hook transport', { timeout: 30_000 }, () => {
  const RECORD_NAME = '1767225600000000001-7';
  const PLAN_APPROVAL_SPEC = Buffer.from(JSON.stringify({
    toolField: 'tool_name', tool: 'ExitPlanMode', inputField: 'tool_input',
    reply: { decision: 'allow', input: '{{toolInput}}', mode: '{{mode}}' },
  })).toString('base64');
  const PLAN_APPROVAL_STDIN = JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'do it' } });

  interface HookSession {
    sessionDirectory: string;
    eventsPath: string;
    inbox: string;
    requests: string;
    responses: string;
  }

  /** A prepared session folder, with the events file as a spawn leaves it or as a case breaks it. */
  async function prepareSession(eventsFile: 'file' | 'directory' | 'missing-folder' = 'file'): Promise<HookSession> {
    const { prepareWslHookTransport } = await import('../../src/main/agent/shared/wsl-hook-transport');
    const sessionDirectory = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const paths = prepareWslHookTransport(sessionDirectory);
    let eventsPath = path.join(sessionDirectory, 'events.jsonl');
    if (eventsFile === 'file') fs.writeFileSync(eventsPath, '');
    if (eventsFile === 'directory') fs.mkdirSync(eventsPath);
    if (eventsFile === 'missing-folder') eventsPath = path.join(sessionDirectory, 'gone', 'events.jsonl');
    return { sessionDirectory, eventsPath, inbox: paths.inbox, requests: paths.requests, responses: paths.responses };
  }

  /** The bytes of a published file: the version line, the head, the argument line, then the stdin. */
  function hookRecord(head: string, argument: string, body: string): string {
    return `K1\n${head}\n${argument}\n${body}`;
  }

  /** Publish a file as the hook script does: under a dotted temporary name, then renamed. */
  function publish(directory: string, fileName: string, content: string): string {
    const temporary = path.join(directory, `.${fileName}.tmp`);
    fs.writeFileSync(temporary, content);
    const published = path.join(directory, fileName);
    fs.renameSync(temporary, published);
    return published;
  }

  /**
   * Start the real inbox. Loading the status file reader first is what hands the
   * inbox main's reporter: the inbox is bundled into the pty host and imports none.
   */
  async function startInbox(session: HookSession, relayMcp?: () => Promise<string>): Promise<void> {
    await import('../../src/main/pty/readers/status-file-reader');
    const { WslHookInbox } = await import('../../src/main/pty/readers/wsl-hook-inbox');
    const inbox = new WslHookInbox({
      sessionDirectory: session.sessionDirectory,
      eventsOutputPath: session.eventsPath,
      onAppended: () => undefined,
      relayMcp,
    });
    cleanups.push(() => inbox.close());
    inbox.start();
  }

  it('reports wsl_hook_append when hook events cannot be appended to the events file', async () => {
    const session = await prepareSession('directory');
    publish(session.inbox, `${RECORD_NAME}.rec`, hookRecord('prompt', '', '{}'));

    await startInbox(session);

    await vi.waitFor(() => expectStageReported('wsl_hook_append'), WAIT);
    // The file stays for the next drain to try again.
    expect(fs.existsSync(path.join(session.inbox, `${RECORD_NAME}.rec`))).toBe(true);
  });

  it('reports nothing for hook events whose session folder is already gone', async () => {
    const session = await prepareSession('missing-folder');
    publish(session.inbox, `${RECORD_NAME}.rec`, hookRecord('prompt', '', '{}'));
    const append = vi.spyOn(fs, 'appendFileSync');

    await startInbox(session);

    await vi.waitFor(() => expect(append.mock.calls.some(([target]) => target === session.eventsPath)).toBe(true), WAIT);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports wsl_hook_remove when an ingested event file cannot be removed', async () => {
    const session = await prepareSession();
    publish(session.inbox, `${RECORD_NAME}.rec`, hookRecord('prompt', '', '{}'));
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw accessDenied(); });

    await startInbox(session);

    await vi.waitFor(() => expectStageReported('wsl_hook_remove'), WAIT);
  });

  it('reports wsl_hook_remove when an answered request cannot be removed', async () => {
    const session = await prepareSession();
    publish(session.requests, `${RECORD_NAME}.req`, hookRecord('no-such-kind', '', '{}'));
    vi.spyOn(fsPromises, 'rm').mockRejectedValue(accessDenied());

    await startInbox(session);

    await vi.waitFor(() => expectStageReported('wsl_hook_remove'), WAIT);
  });

  it('reports wsl_hook_response when the MCP relay throws on a call it already claimed', async () => {
    const session = await prepareSession();
    publish(session.requests, `${RECORD_NAME}.req`, hookRecord('mcp', 'token http://127.0.0.1:4100/mcp/p', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));

    await startInbox(session, async () => { throw defect('the MCP relay'); });

    await vi.waitFor(() => expectStageReported('wsl_hook_response'), WAIT);
  });

  it('reports wsl_hook_response when a hook\'s answer cannot be published', async () => {
    const session = await prepareSession();
    publish(session.requests, `${RECORD_NAME}.req`, hookRecord('no-such-kind', '', '{}'));
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(accessDenied());

    await startInbox(session);

    await vi.waitFor(() => expectStageReported('wsl_hook_response'), WAIT);
  });

  it('reports nothing for an answer whose responses folder went with its session', async () => {
    const session = await prepareSession();
    fs.rmSync(session.responses, { recursive: true, force: true });
    const requestPath = publish(session.requests, `${RECORD_NAME}.req`, hookRecord('no-such-kind', '', '{}'));

    await startInbox(session);

    // The request is removed after its answer was tried, so the failed write is behind us.
    await vi.waitFor(() => expect(fs.existsSync(requestPath)).toBe(false), WAIT);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports wsl_hook_append when a plan approval\'s marker cannot be written', async () => {
    const { planApprovalDecisionPath } = await import('../../src/main/agent/shared/plan-approval-hook');
    const session = await prepareSession('directory');
    fs.writeFileSync(
      planApprovalDecisionPath(session.sessionDirectory),
      JSON.stringify({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' }),
    );
    publish(session.requests, `${RECORD_NAME}.req`, hookRecord('plan-approval', PLAN_APPROVAL_SPEC, PLAN_APPROVAL_STDIN));

    await startInbox(session);

    await vi.waitFor(() => expectStageReported('wsl_hook_append'), WAIT);
  });

  it('reports wsl_hook_drain when a reply builder throws inside a drain', async () => {
    const backgroundShellHintReply = (): string => { throw defect('the hint reply'); };
    vi.doMock('../../src/main/agent/background-shell-hint-bridge', () => ({
      backgroundShellHintReply,
      default: { backgroundShellHintReply },
    }));
    const session = await prepareSession();
    publish(session.requests, `${RECORD_NAME}.req`, hookRecord('background-shell-hint', 'c3BlYw==', '{"tool_name":"Bash"}'));

    await startInbox(session);

    await vi.waitFor(() => expectStageReported('wsl_hook_drain'), WAIT);
  });

  const MCP_REQUEST = {
    argument: 'token http://127.0.0.1:4100/mcp/project',
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    server: null,
  };

  /** A 200 whose body fails as it is read. */
  function responseWhoseBodyFails(failure: unknown): typeof fetch {
    const response = { ok: true, status: 200, headers: new Headers(), text: async () => { throw failure; } };
    return (async () => response) as unknown as typeof fetch;
  }

  it('reports wsl_mcp_relay when the MCP server\'s answer does not arrive whole', async () => {
    await import('../../src/main/pty/readers/status-file-reader');
    const { relayMcpMessage } = await import('../../src/main/pty/readers/wsl-mcp-relay');

    const answer = await relayMcpMessage({ ...MCP_REQUEST, fetchImplementation: responseWhoseBodyFails(defect('the answer body')) });

    // The agent's call ends with an error for its own id. On a 2xx the relay used to
    // print nothing here, and the call waited with no reply.
    const reply = JSON.parse(answer) as { id: number; error: { message: string } };
    expect(reply.id).toBe(1);
    expect(reply.error.message).toContain('did not arrive whole');
    expect(reply.error.message).toContain('check what it changed before calling it again');
    expectStageReported('wsl_mcp_relay');
  });

  it('answers nothing for a notification whose answer did not arrive, since nobody waits on one', async () => {
    await import('../../src/main/pty/readers/status-file-reader');
    const { relayMcpMessage } = await import('../../src/main/pty/readers/wsl-mcp-relay');
    const notification = { ...MCP_REQUEST, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' };

    const answer = await relayMcpMessage({ ...notification, fetchImplementation: responseWhoseBodyFails(defect('the answer body')) });

    expect(answer).toBe('');
  });

  it('reports nothing for an MCP answer that ran out of time', async () => {
    await import('../../src/main/pty/readers/status-file-reader');
    const { relayMcpMessage } = await import('../../src/main/pty/readers/wsl-mcp-relay');
    const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    const answer = await relayMcpMessage({ ...MCP_REQUEST, fetchImplementation: responseWhoseBodyFails(timedOut) });

    // Slow is not a defect, but the call still gets its answer.
    expect((JSON.parse(answer) as { error: { message: string } }).error.message).toContain('did not finish its answer');
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the pty host relays what it handled', { timeout: 30_000 }, () => {
  async function relay(): Promise<{ events: PtyHostEvent[]; handledErrors: { report(code: PtyHostHandledErrorCode, error: unknown): void } }> {
    const { HostHandledErrors } = await import('../../src/main/pty/host/host-handled-error');
    const events: PtyHostEvent[] = [];
    return { events, handledErrors: new HostHandledErrors((event) => { events.push(event); }) };
  }

  async function transcriptSinks(): Promise<{ events: PtyHostEvent[]; projectsDir: string; sinkFor: (projectId: string) => unknown }> {
    const { configureProjectDbAccess } = await import('../../src/main/db/database');
    const { createTranscriptSinkFor } = await import('../../src/main/pty/host/host-transcript-sink');
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir);
    // As the host opens them: the file must exist, and nothing is migrated.
    configureProjectDbAccess({ projectsDir, migrate: false });
    const { events, handledErrors } = await relay();
    return { events, projectsDir, sinkFor: createTranscriptSinkFor(handledErrors) };
  }

  it('relays transcript_open when a project database that is there will not open', async () => {
    const { events, projectsDir, sinkFor } = await transcriptSinks();
    fs.writeFileSync(path.join(projectsDir, 'project-1.db'), `this is not a database: ${USER_TEXT}\n`.repeat(64));

    expect(sinkFor('project-1')).toBeNull();

    expect(relayedCodes(events)).toEqual(['transcript_open']);
    const [event] = relayed(events);
    expect(Object.keys(event).sort()).toEqual(['code', 'error', 'type']);
    expect(event.error.name).toBe('SqliteError');
    expect(event.error.code).toMatch(/^SQLITE_/);
    await expectMainReportsRelay(event);
  });

  it('relays nothing for a project whose database was deleted', async () => {
    const { events, sinkFor } = await transcriptSinks();

    expect(sinkFor('project-deleted')).toBeNull();

    expect(relayedCodes(events)).toEqual([]);
  });

  /** A host core on fake PTYs, as the utility host builds it on Windows. */
  async function startCore(loadOrphanApi: () => Promise<DeadRootOrphanApi>, shell = createExitablePty(4242)) {
    const { PtyHostCore } = await import('../../src/main/pty/host/pty-host-core');
    const events: PtyHostEvent[] = [];
    const core = new PtyHostCore({
      emit: (event) => { events.push(event); },
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      platform: 'win32',
      spawnPty: (() => shell.pty) as unknown as typeof nodePty.spawn,
      loadOrphanApi,
    });
    return { core, events, shell };
  }

  it('relays root_exit_read when a PTY root\'s exit time cannot be read, and the exit still reaches main', async () => {
    const thrown = defect('the pinned handle');
    const pinRoot = vi.fn(() => ({
      startedAtMs: Date.now(),
      readExitedAtMs: (): number | null => { throw thrown; },
      release: () => undefined,
    }));
    const { core, events, shell } = await startCore(async () => ({
      listProcesses: async () => [],
      identityOf: () => null,
      terminate: () => false,
      pinRoot,
    }));
    await core.spawn({ ...hostSpawnParams('session-1'), ptyId: 1 });
    await vi.waitFor(() => expect(pinRoot).toHaveBeenCalled());

    expect(() => shell.exit(1)).not.toThrow();

    const event = await expectRelayedOnce(events, 'root_exit_read', thrown);
    expect(events.some((hostEvent) => hostEvent.type === 'exit')).toBe(true);
    await expectMainReportsRelay(event);
  });

  it('relays orphan_api_load when the Windows process API will not load', async () => {
    const thrown = defect('the process API load');
    const { core, events } = await startCore(async () => { throw thrown; });
    await core.spawn({ ...hostSpawnParams('session-1'), ptyId: 1 });

    await vi.waitFor(() => expect(relayedCodes(events)).toContain('orphan_api_load'));

    const event = await expectRelayedOnce(events, 'orphan_api_load', thrown);
    await expectMainReportsRelay(event);
  });

  it('relays task_tree_probe when a probe\'s process scan fails in the host, and answers failed', async () => {
    const { PtyHostCore } = await import('../../src/main/pty/host/pty-host-core');
    const events: PtyHostEvent[] = [];
    const thrown = defect('the process scan');
    const reader = { scan: async () => { throw thrown; }, kill: async () => false } as unknown as TaggedProcessReader;
    const core = new PtyHostCore({
      emit: (event) => { events.push(event); },
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => reader,
    });

    // The request main sends, so the core handing its relay to the reaper is part of what runs.
    const answer = await core.handleRequest('probeTaskProcesses', {
      tasks: [{ taskId: TASK_ID, directories: [path.join(tmpDir, 'project')], worktreePath: null }],
      mainPid: process.pid,
      readConnections: false,
    });

    expect(answer).toEqual({ entries: [], failed: true });
    const event = await expectRelayedOnce(events, 'task_tree_probe', thrown);
    await expectMainReportsRelay(event);
  });

  it('relays process_table_fallback when the Toolhelp listing fails, and answers from the fallback', async () => {
    const { HostProcessTable } = await import('../../src/main/pty/host/host-process-table');
    const { events, handledErrors } = await relay();
    const thrown = defect('the Toolhelp listing');
    const fallbackRows = [{ pid: 4, ppid: 0, comm: 'system' }];
    const table = new HostProcessTable({
      platform: 'win32',
      listToolhelp: async () => { throw thrown; },
      handledErrors,
      createFallbackProbe: () => ({
        listAllProcesses: async () => fallbackRows,
        dispose: () => undefined,
      }) as unknown as ProcessTableProbe,
    });

    expect(await table.list()).toEqual(fallbackRows);

    const event = await expectRelayedOnce(events, 'process_table_fallback', thrown);
    await expectMainReportsRelay(event);
  });

  it('relays process_table_fallback through the core\'s own relay when the Toolhelp listing fails, and answers from the fallback', async () => {
    const thrown = defect('the Toolhelp listing');
    // The real listing is koffi's: it works on a Windows machine and fails on Linux, so the
    // case would read two ways. The failure is the one under test, so it is made the same on both.
    vi.doMock('../../src/main/pty/process-tag/win32-reader', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/main/pty/process-tag/win32-reader')>()),
      listWin32Processes: async () => { throw thrown; },
    }));
    const { PtyHostCore } = await import('../../src/main/pty/host/pty-host-core');
    const events: PtyHostEvent[] = [];
    const fallbackRows = [{ pid: 4, ppid: 0, comm: 'system' }];
    const spawnService = {
      processTableProbe: () => ({ listAllProcesses: async () => fallbackRows, dispose: () => undefined }) as unknown as ProcessTableProbe,
      liveCliCount: 0,
      dispose: () => undefined,
    } as unknown as HostSpawnService;
    const core = new PtyHostCore({
      emit: (event) => { events.push(event); },
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      platform: 'win32',
      createSpawnService: () => spawnService,
    });

    // The request main sends, so the core handing its own relay to the table is part of what runs.
    expect(await core.handleRequest('listProcesses', {})).toEqual(fallbackRows);

    const event = await expectRelayedOnce(events, 'process_table_fallback', thrown);
    await expectMainReportsRelay(event);
    // The table stays on the fallback, and reports its one failure once.
    expect(await core.handleRequest('listProcesses', {})).toEqual(fallbackRows);
    expect(relayedCodes(events)).toEqual(['process_table_fallback']);
  });

  it('relays drain_listener when a drain listener throws, and the replay still answers', async () => {
    const { PtyBufferManager } = await import('../../src/main/pty/buffer/pty-buffer-manager');
    const { events, handledErrors } = await relay();
    const thrown = defect('the data tap');
    const manager = new PtyBufferManager({
      onFlush: () => undefined,
      onDrain: () => { throw thrown; },
      handledErrors,
    });
    manager.initSession('session-1', '', 80, 24);
    manager.onData('session-1', 'output a phone is streaming');

    expect(manager.getScrollback('session-1')).toContain('output a phone is streaming');
    manager.removeSession('session-1');

    const event = await expectRelayedOnce(events, 'drain_listener', thrown);
    await expectMainReportsRelay(event);
  });

  it('relays drain_listener from the host core when a phone\'s tap cannot be sent during a replay', async () => {
    const { PtyHostCore } = await import('../../src/main/pty/host/pty-host-core');
    const events: PtyHostEvent[] = [];
    const thrown = defect('the tap send');
    const shell = createExitablePty(4242);
    const core = new PtyHostCore({
      // The tap is the one event that cannot be sent, as when its bytes will not clone.
      emit: (event) => {
        if (event.type === 'tap') throw thrown;
        events.push(event);
      },
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      platform: 'linux',
      spawnPty: (() => shell.pty) as unknown as typeof nodePty.spawn,
    });
    await core.spawn({ ...hostSpawnParams('session-1'), ptyId: 1 });
    core.handleCommand({ type: 'setTapped', sessionIds: ['session-1'] });
    shell.feed('output a phone is streaming');

    // A replay takes the pending bytes before their flush, and hands them to the tap.
    const scrollback = await core.handleRequest('getScrollback', { sessionId: 'session-1', settle: false });
    core.handleCommand({ type: 'setTapped', sessionIds: [] });

    expect(scrollback).toContain('output a phone is streaming');
    await expectRelayedOnce(events, 'drain_listener', thrown);
  });
});

describe('an SSH link to a remote host', { timeout: 30_000 }, () => {
  interface HelperRequest {
    id: number;
    method: string;
    params: unknown;
  }

  /** The helper answers a request with an error of its own, whose text crossed the wire. */
  function failedReply(id: number, name: string): unknown {
    return { t: 'reply', id, ok: false, error: { message: `the host could not read ${USER_TEXT}`, name } };
  }

  function answeredReply(id: number, result: unknown): unknown {
    return { t: 'reply', id, ok: true, result };
  }

  /** A snapshot in which the helper holds `session-1` alive under another PTY id. */
  function snapshotHoldingSession(): unknown {
    return {
      ownerEpoch: 1,
      daemonPid: 4242,
      daemonStartedAt: 1,
      sessions: [{
        sessionId: 'session-1',
        taskId: 'task-1',
        projectId: 'project-1',
        pid: 4242,
        alive: true,
        exitCode: null,
        wirePtyId: 3,
        inAltScreen: false,
      }],
    };
  }

  /** A stand-in for the host's helper: the real resume endpoint, answering as a case scripts it. */
  async function scriptedHelper(answer: (request: HelperRequest) => unknown): Promise<{ linkSide: Duplex; send(message: unknown): void }> {
    const { ResumeEndpoint } = await import('../../src/main/remote/protocol/resume-endpoint');
    const [linkSide, helperSide] = duplexPair();
    const endpoint = new ResumeEndpoint({
      onMessage: (json) => {
        const message = json as { t?: string; id?: number; method?: string; params?: unknown };
        if (message.t !== 'request' || typeof message.id !== 'number' || typeof message.method !== 'string') return;
        const reply = answer({ id: message.id, method: message.method, params: message.params });
        if (reply !== undefined) endpoint.send(reply);
      },
      onAttached: () => undefined,
      onDetached: () => undefined,
      onGap: () => undefined,
    }, { role: 'helper', protocol: { min: 1, max: 1 }, identity: {} });
    endpoint.attach(helperSide);
    cleanups.push(() => {
      endpoint.detach();
      linkSide.destroy();
      helperSide.destroy();
    });
    return { linkSide, send: (message) => endpoint.send(message) };
  }

  /** The real link over one in-memory connection. A redial after a drop waits, as for a host that stays away. */
  async function startLink(linkSide: Duplex, requestTimeoutMs?: number) {
    const { RemoteLink } = await import('../../src/main/remote/link/remote-link');
    const events: PtyHostEvent[] = [];
    const logLines: string[] = [];
    let dialed = false;
    const link = new RemoteLink({
      identity: { installId: 'install-1', bootId: 'boot-1', label: 'a test' },
      connect: () => {
        if (dialed) return new Promise<Duplex>(() => undefined);
        dialed = true;
        return Promise.resolve(linkSide);
      },
      requestTimeoutMs,
      log: (line) => logLines.push(line),
    });
    link.setEventListener((event) => { events.push(event); });
    cleanups.push(() => link.stop());
    return { link, events, logLines };
  }

  /** A relay of an error that crossed the wire: the fixed code, the name, and main's fixed message. */
  async function expectRelayedFromWire(events: readonly PtyHostEvent[], code: PtyHostHandledErrorCode, errorName: string): Promise<void> {
    expect(relayedCodes(events)).toEqual([code]);
    const [event] = relayed(events);
    expect(Object.keys(event).sort()).toEqual(['code', 'error', 'type']);
    expect(event.error.name).toBe(errorName);
    await expectMainReportsRelay(event);
  }

  it('relays remote_reconcile when the host fails the snapshot a connect asks for', async () => {
    const helper = await scriptedHelper((request) => (request.method === 'snapshot' ? failedReply(request.id, 'TypeError') : undefined));
    const { link, events } = await startLink(helper.linkSide);

    link.start();

    await vi.waitFor(() => expect(relayedCodes(events)).toEqual(['remote_reconcile']), WAIT);
    await expectRelayedFromWire(events, 'remote_reconcile', 'TypeError');
  });

  it('relays nothing for a snapshot the host never answered', async () => {
    const helper = await scriptedHelper(() => undefined);
    const { link, events, logLines } = await startLink(helper.linkSide, 40);

    link.start();

    await vi.waitFor(() => expect(logLines.some((line) => line.startsWith('snapshot failed'))).toBe(true), WAIT);
    expect(relayedCodes(events)).toEqual([]);
  });

  it('relays remote_rebind when a reconcile cannot rebind a session the host still runs', async () => {
    const helper = await scriptedHelper((request) => {
      if (request.method === 'snapshot') return answeredReply(request.id, snapshotHoldingSession());
      if (request.method === 'rebind') return failedReply(request.id, 'TypeError');
      return undefined;
    });
    const { link, events } = await startLink(helper.linkSide);
    link.adoptSessions([{ sessionId: 'session-1', ptyId: 7 }]);

    link.start();

    await vi.waitFor(() => expect(relayedCodes(events)).toEqual(['remote_rebind']), WAIT);
    await expectRelayedFromWire(events, 'remote_rebind', 'TypeError');
  });

  /** A connected link whose helper holds `session-1` and answers a rebind with `rebindFailure`. */
  async function linkWhoseRebindFails(rebindFailure: string) {
    const helper = await scriptedHelper((request) => {
      if (request.method === 'snapshot') return answeredReply(request.id, snapshotHoldingSession());
      if (request.method === 'rebind') return failedReply(request.id, rebindFailure);
      return undefined;
    });
    const started = await startLink(helper.linkSide);
    started.link.start();
    await vi.waitFor(() => expect(started.link.state).toBe('connected'), WAIT);
    return started;
  }

  it('relays remote_rebind when taking a running agent back fails on the host', async () => {
    const { link, events } = await linkWhoseRebindFails('TypeError');

    const outcomes = await link.rejoinSessions([{ sessionId: 'session-1', ptyId: 7 }]);

    expect(outcomes).toEqual([{ sessionId: 'session-1', rejoined: false }]);
    await expectRelayedFromWire(events, 'remote_rebind', 'TypeError');
  });

  it('relays nothing for a rebind the host never answered, which is a dropped link', async () => {
    const { link, events } = await linkWhoseRebindFails('HostRequestUnansweredError');

    const outcomes = await link.rejoinSessions([{ sessionId: 'session-1', ptyId: 7 }]);

    expect(outcomes).toEqual([{ sessionId: 'session-1', rejoined: false }]);
    expect(relayedCodes(events)).toEqual([]);
  });

  /** A connected link whose event listener throws `failure` for an exit the host reports. */
  async function linkWhoseExitHandlingThrows(failure: Error) {
    const helper = await scriptedHelper((request) => (
      request.method === 'snapshot'
        ? answeredReply(request.id, { ownerEpoch: 1, daemonPid: 4242, daemonStartedAt: 1, sessions: [] })
        : undefined
    ));
    const started = await startLink(helper.linkSide);
    started.link.setEventListener((event) => {
      if (event.type === 'exit') throw failure;
      started.events.push(event);
    });
    started.link.start();
    await vi.waitFor(() => expect(started.link.state).toBe('connected'), WAIT);
    helper.send({ t: 'event', event: { type: 'exit', ptyId: 9, sessionId: 'session-9', exitCode: 0, signal: null } });
    return started;
  }

  it('relays remote_handler when the link\'s own handling of a host message throws', async () => {
    const thrown = defect('the exit handling');

    const { events } = await linkWhoseExitHandlingThrows(thrown);

    await vi.waitFor(() => expect(relayedCodes(events)).toEqual(['remote_handler']), WAIT);
    const event = await expectRelayedOnce(events, 'remote_handler', thrown);
    await expectMainReportsRelay(event);
  });

  it('relays nothing when that handling fails because the host is not connected', async () => {
    const { HostUnreachableError } = await import('../../src/main/remote/link/host-unreachable-error');

    const { events, logLines } = await linkWhoseExitHandlingThrows(new HostUnreachableError('host-a', 'This host is not connected.'));

    await vi.waitFor(() => expect(logLines.some((line) => line.startsWith('a handler threw'))).toBe(true), WAIT);
    expect(relayedCodes(events)).toEqual([]);
  });

  /** A raw connection to the link, for bytes no real endpoint would send. */
  async function linkOverRawStream() {
    const [linkSide, helperSide] = duplexPair();
    cleanups.push(() => {
      linkSide.destroy();
      helperSide.destroy();
    });
    const started = await startLink(linkSide);
    started.link.start();
    return { ...started, helperSide };
  }

  it('relays remote_frame for a frame that cleared its checksums and is still not JSON', async () => {
    const { FRAME_HEADER_BYTES, FrameKind, encodeFrame } = await import('../../src/main/remote/protocol/frame-codec');
    // A valid frame whose body is swapped for text that does not parse, with both checksums made right again.
    const frame = encodeFrame({ kind: FrameKind.heartbeat, offset: 0, json: 'xx' });
    frame.write('{bad', FRAME_HEADER_BYTES, 'utf8');
    frame.writeUInt32BE(crc32(frame.subarray(FRAME_HEADER_BYTES)), 24);
    frame.writeUInt32BE(crc32(frame.subarray(0, 28)), 28);
    const { events, helperSide } = await linkOverRawStream();

    helperSide.write(frame);

    await vi.waitFor(() => expect(relayedCodes(events)).toEqual(['remote_frame']), WAIT);
    await expectRelayedFromWire(events, 'remote_frame', 'FrameError');
  });

  it('relays nothing for bytes damaged on the wire, which end the connection and resume', async () => {
    const { events, logLines, helperSide } = await linkOverRawStream();

    helperSide.write(Buffer.alloc(64, 0x41));

    await vi.waitFor(() => expect(logLines.some((line) => line.startsWith('connection ended'))).toBe(true), WAIT);
    expect(relayedCodes(events)).toEqual([]);
  });
});

describe('a forwarded dev-server port', () => {
  /** A forwarder for one connected host that wants one port, asking `requestListening` at once. */
  async function startForwarder(requestListening: () => Promise<number[]>) {
    const { PortForwarder } = await import('../../src/main/remote/link/port-forward');
    const { HostHandledErrors } = await import('../../src/main/pty/host/host-handled-error');
    const events: PtyHostEvent[] = [];
    const logLines: string[] = [];
    const forwarder = new PortForwarder({
      requestListening,
      handledErrors: new HostHandledErrors((event) => { events.push(event); }),
      isLocalPortBound: async () => false,
      pollMs: 60_000,
      log: (line) => logLines.push(line),
    });
    cleanups.push(() => forwarder.dispose());
    forwarder.addHost('host-a', { sshPath: 'ssh', args: ['build-host'] });
    forwarder.setPorts('host-a', [5173]);
    forwarder.linkState('host-a', 'connected');
    return { events, logLines, forwarder };
  }

  it('relays port_forward_poll when the host cannot list its listening ports', async () => {
    const thrown = defect('the listening ports read');

    const { events, forwarder } = await startForwarder(async () => { throw thrown; });

    await vi.waitFor(() => expect(relayedCodes(events)).toEqual(['port_forward_poll']), WAIT);
    const event = await expectRelayedOnce(events, 'port_forward_poll', thrown);
    expect(forwarder.list('host-a')).toEqual([{ port: 5173, state: 'waiting' }]);
    await expectMainReportsRelay(event);
  });

  it('relays nothing for a poll the host never answered, which is a dropped link', async () => {
    const { HostRequestUnansweredError } = await import('../../src/main/remote/link/host-request-unanswered-error');

    const { events, logLines } = await startForwarder(async () => {
      throw new HostRequestUnansweredError('the host did not answer listeningPorts within 30 s', 'no_answer');
    });

    await vi.waitFor(() => expect(logLines.some((line) => line.startsWith('could not list the ports'))).toBe(true), WAIT);
    expect(relayedCodes(events)).toEqual([]);
  });
});
