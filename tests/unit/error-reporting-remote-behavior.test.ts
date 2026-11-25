/**
 * What a user loses if these reports go quiet: an agent on an SSH host keeps running while the
 * board stops following it (a transcript that is never copied, a permission prompt that never
 * shows, a resumed conversation that starts empty), an agent the host kept running is never taken
 * back, a host's own settings are left with Kangentic's entries in them, and a host that cannot
 * be set up reads "unreachable" for a reason only Kangentic can fix. Each used to end in a log
 * line.
 *
 * Each case runs the real module, makes one dependency fail, and reads the call that reached
 * `reportHandledError`: its source, its stage, and that nothing the user named left with it.
 *
 * A drop is a state, never a failure (`.claude/rules/ssh-remote.md`). So every site a host's
 * answer can reach is also driven with the two shapes a drop arrives in (a request the host never
 * answered, a host out of reach) and must report nothing, and with a failure the helper answered
 * with, which must report.
 *
 * Modules are re-imported per test (`vi.resetModules`) because each reporter latches a key once
 * per run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PathLike, RmOptions } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteExportPath, serializeCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { prepareWslHookTransport, wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { fromPtyHostError } from '../../src/main/pty/host/protocol';
import type { SshRunResult } from '../../src/main/remote/link/ssh-run';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';
import type { RemoteSessionFiles, RemoteSessionRegistration, RemoteSessionRelay, RemoteTranscriptSource } from '../../src/main/remote/remote-session-relay';
import type { SshHostAdminDeps } from '../../src/main/remote/ssh-host-admin';
import type { RunProgram, SshSetupDeps } from '../../src/main/remote/ssh-setup';
import type { RemoteTranscriptSnapshot, SessionRecord, SshHost } from '../../src/shared/types';
import { reportedText as sharedReportedText } from './helpers/reported-failures';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError,
}));

/** Failures a test injects into this computer's disk. Null leaves the real call alone. */
const fileFaults = vi.hoisted(() => ({
  renameSync: null as null | (() => Error),
  rm: null as null | (() => Error),
  access: null as null | (() => Error),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync = (oldPath: PathLike, newPath: PathLike): void => {
    const fault = fileFaults.renameSync?.();
    if (fault) throw fault;
    actual.renameSync(oldPath, newPath);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rm = async (target: PathLike, options?: RmOptions): Promise<void> => {
    const fault = fileFaults.rm?.();
    if (fault) throw fault;
    await actual.rm(target, options);
  };
  const access = async (target: PathLike, mode?: number): Promise<void> => {
    const fault = fileFaults.access?.();
    if (fault) throw fault;
    await actual.access(target, mode);
  };
  return { ...actual, default: { ...actual, rm, access }, rm, access };
});

// `createRemoteHosting` reads these two tables and builds its own `ssh` runner.
vi.mock('../../src/main/db/repositories/dev-port-repository', () => ({
  devPortRepository: { listAll: () => [], onChange: () => () => undefined },
}));
vi.mock('../../src/main/db/repositories/ssh-host-repository', () => ({
  SshHostRepository: class {
    private readonly row = { id: 'host-1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '', removed_at: null, reveal_pending: false };
    list(): unknown[] { return [this.row]; }
    getById(id: string): unknown { return id === this.row.id ? this.row : undefined; }
  },
}));
/** What the `ssh` program answers for each remote command a connect runs. */
const sshControl = vi.hoisted(() => ({
  run: null as null | ((remoteCommand: string) => Promise<{ code: number | null; stdout: string; stderr: string }>),
}));
vi.mock('../../src/main/remote/link/ssh-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/remote/link/ssh-run')>();
  return {
    ...actual,
    createSshRunner: () => async (remoteCommand: string): Promise<SshRunResult> => {
      if (!sshControl.run) throw new Error('the test set no ssh answer');
      return sshControl.run(remoteCommand);
    },
  };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const teardown: Array<() => void> = [];
let scratch: string;
let mirror: string;
let shellFolder: string;

beforeEach(() => {
  vi.resetModules();
  reportHandledError.mockReset();
  fileFaults.renameSync = null;
  fileFaults.rm = null;
  fileFaults.access = null;
  sshControl.run = null;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-remote-report-'));
  mirror = path.join(scratch, 'mirror');
  shellFolder = path.join(scratch, 'shell');
  fs.mkdirSync(mirror, { recursive: true });
  fs.mkdirSync(shellFolder, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  for (const undo of teardown.splice(0)) undo();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** The tags of the one report that was sent. */
function onlyReportTags(): Record<string, string> {
  expect(reportHandledError).toHaveBeenCalledTimes(1);
  return reportHandledError.mock.calls[0][1] as Record<string, string>;
}

/** Everything the reports carried, as text, so a leaked title or path cannot hide in any field. */
const reportedText = (): string => sharedReportedText(reportHandledError);

function expectNoUserText(): void {
  expect(reportedText()).not.toMatch(/acme/i);
}

/** A drop as it arrives in main: a plain Error that kept only its name across the pty host. */
function dropError(name: 'HostRequestUnansweredError' | 'HostUnreachableError', message: string): Error {
  return Object.assign(new Error(message), { name });
}

const DROPS: ReadonlyArray<readonly [string, () => Error]> = [
  ['a request the host never answered', () => dropError('HostRequestUnansweredError', 'the host did not answer within 30 s (Fix Acme billing)')],
  ['a host out of reach', () => dropError('HostUnreachableError', 'Lab is not connected: Fix Acme billing')],
];

/** A failure the host's helper answered with (`ok: false`), rebuilt as the link rebuilds it. */
function helperFailure(): Error {
  return fromPtyHostError({ message: '/home/dev/Fix Acme billing is not inside the home folder of this host, so it was not touched' });
}

/** An errno failure of this computer's disk, with a path in its words as Node writes one. */
function diskFailure(code: string, syscall: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} failed, '${path.join(scratch, 'Fix Acme billing')}'`), { code, syscall });
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// The session relay
// ---------------------------------------------------------------------------

const placeOf = (): SshCliPlace => ({
  kind: 'ssh',
  hostId: 'host-a',
  home: '/home/dev',
  shellName: 'sh',
  localHome: mirror,
  roots: [{ local: shellFolder, host: '/home/dev/project' }],
});

function localSessionOf(sessionId: string): string {
  return path.join(shellFolder, '.kangentic', 'sessions', sessionId);
}

function registrationOf(sessionId: string, extra: Partial<RemoteSessionRegistration> = {}): RemoteSessionRegistration {
  const localSession = localSessionOf(sessionId);
  fs.mkdirSync(localSession, { recursive: true });
  prepareWslHookTransport(localSession);
  return {
    hostId: 'host-a',
    sessionId,
    place: placeOf(),
    localSessionDirectory: localSession,
    statusOutputPath: path.join(localSession, 'status.json'),
    agentSessionId: null,
    ...extra,
  };
}

interface FakeHost {
  files: RemoteSessionFiles;
  /** What the next `watchFiles` does. */
  watchFiles: () => Promise<{ sizes?: Record<string, number> } | undefined>;
  /** What the next `runCommand` does. */
  runCommand: (request: HostCommandRequest) => Promise<HostCommandResult>;
  watchAsks: number;
}

/** A host behind the relay's jobs that answers from the test. */
function fakeHost(): FakeHost {
  const host: FakeHost = {
    watchFiles: async () => ({ sizes: {} }),
    runCommand: async () => ({ code: 0, stdout: 'replaced 10\n', stderr: '', timedOut: false }),
    watchAsks: 0,
    files: {
      writeFiles: async () => undefined,
      writeFileRaw: async () => undefined,
      watchHooks: async () => undefined,
      unwatchHooks: async () => undefined,
      watchFiles: async () => {
        host.watchAsks += 1;
        return host.watchFiles();
      },
      unwatchFiles: async () => undefined,
      removeFiles: async () => undefined,
      removeEmptyDirectories: async () => undefined,
      runCommand: async (_hostId, request) => host.runCommand(request),
    },
  };
  return host;
}

async function makeRelay(): Promise<{ relay: RemoteSessionRelay; host: FakeHost }> {
  const { RemoteSessionRelay: Relay } = await import('../../src/main/remote/remote-session-relay');
  const host = fakeHost();
  const relay = new Relay({ files: host.files });
  teardown.push(() => relay.dispose());
  return { relay, host };
}

const chunk = (sessionId: string, key: string, offset: number, text: string, size: number) => ({
  type: 'fileChunk' as const, sessionId, key, offset, reset: false, size, data: Buffer.from(text).toString('base64'),
});

describe('the session relay tailing a transcript at the start', () => {
  async function registerWithWatchFailing(failure: Error): Promise<void> {
    const { relay, host } = await makeRelay();
    host.watchFiles = async () => { throw failure; };
    await relay.register(registrationOf('s1', { transcriptFiles: [path.join(mirror, '.agent', 'abc.jsonl')] }));
    expect(relay.has('s1')).toBe(true);
  }

  it('reports a watch the helper answered with a failure, under source remote_session_relay and stage watch_files', async () => {
    await registerWithWatchFailing(helperFailure());

    expect(onlyReportTags()).toMatchObject({ source: 'remote_session_relay', stage: 'watch_files', error_name: 'Error' });
    expectNoUserText();
  });

  it.each(DROPS)('reports nothing for %s', async (_label, makeDrop) => {
    await registerWithWatchFailing(makeDrop());

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the session relay tailing a transcript named after the start', () => {
  const source: RemoteTranscriptSource = { files: (id) => [path.join(mirror, '.agent', `${id}.jsonl`)] };

  async function nameTranscriptWithWatchFailing(failure: Error): Promise<void> {
    const { relay, host } = await makeRelay();
    await relay.register(registrationOf('s1', { transcripts: source }));
    expect(host.watchAsks).toBe(0);
    host.watchFiles = async () => { throw failure; };
    relay.setAgentSessionId('s1', 'abc');
    await vi.waitFor(() => expect(host.watchAsks).toBe(1));
    await settled();
  }

  it('reports a watch the helper answered with a failure, under stage watch_files', async () => {
    await nameTranscriptWithWatchFailing(helperFailure());

    expect(onlyReportTags()).toMatchObject({ source: 'remote_session_relay', stage: 'watch_files' });
    expectNoUserText();
  });

  it.each(DROPS)('reports nothing for %s', async (_label, makeDrop) => {
    await nameTranscriptWithWatchFailing(makeDrop());

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the session relay bringing an earlier conversation over for a resume', () => {
  async function registerWithSeed(runCommand: FakeHost['runCommand']): Promise<void> {
    const { relay, host } = await makeRelay();
    host.runCommand = runCommand;
    await relay.register(registrationOf('s1', {
      resumeSeed: {
        source: path.join(localSessionOf('earlier'), 'state'),
        target: path.join(localSessionOf('s1'), 'state'),
      },
    }));
    expect(relay.has('s1')).toBe(true);
  }

  const FAILURES: ReadonlyArray<readonly [string, FakeHost['runCommand']]> = [
    ['the copy fails on the host', async () => ({ code: 72, stdout: '', stderr: 'cp: cannot create /home/dev/Fix Acme billing/state\n', timedOut: false })],
    ['the helper answers with a failure', async () => { throw helperFailure(); }],
  ];

  it.each(FAILURES)('reports under stage resume_seed when %s', async (_label, runCommand) => {
    await registerWithSeed(runCommand);

    expect(onlyReportTags()).toMatchObject({ source: 'remote_session_relay', stage: 'resume_seed' });
    expectNoUserText();
  });

  it.each(DROPS)('reports nothing for %s', async (_label, makeDrop) => {
    await registerWithSeed(async () => { throw makeDrop(); });

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('the session relay writing what the host sent to this disk', () => {
  const status = { type: 'hookFile' as const, sessionId: 's1', folder: 'status' as const, name: 'status.json', content: '{"model":"x"}' };

  it('reports a status file that cannot be written, under stage deliver, grouped as an environment failure', async () => {
    const { relay } = await makeRelay();
    // A file where the status file's folder would be fails the write on every OS.
    const blocker = path.join(shellFolder, 'acme-billing');
    fs.writeFileSync(blocker, 'a file, not a folder');
    await relay.register(registrationOf('s1', { statusOutputPath: path.join(blocker, 'status.json') }));

    relay.deliver(status);

    const tags = onlyReportTags();
    expect(tags).toMatchObject({ source: 'remote_session_relay', stage: 'deliver' });
    expect(tags.errno).toMatch(/^E[A-Z]+$/);
    expect(reportHandledError.mock.calls[0][3]).toEqual(['handled-env', 'Error', tags.errno]);
    expectNoUserText();
  });

  it.each([
    ['win32', 0],
    ['linux', 1],
  ] as const)('treats a status file a reader holds open as the retry it is on Windows only (%s reports %i)', async (platform, reports) => {
    const { relay } = await makeRelay();
    await relay.register(registrationOf('s1'));
    fileFaults.renameSync = () => diskFailure('EPERM', 'rename');

    setPlatform(platform);
    relay.deliver(status);
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);

    expect(reportHandledError).toHaveBeenCalledTimes(reports);
    expectNoUserText();
  });

  it('reports a hook record that cannot be stored, under stage hook_write', async () => {
    const { relay } = await makeRelay();
    await relay.register(registrationOf('s1'));
    const inbox = wslHookPaths(localSessionOf('s1')).inbox;
    fs.rmSync(inbox, { recursive: true, force: true });
    fs.writeFileSync(inbox, 'a file where the inbox folder was');

    relay.deliver({ type: 'hookFile', sessionId: 's1', folder: 'inbox', name: '1700000000000000000-41.rec', content: 'K1\nevent\nstop\n{"title":"Fix Acme billing"}' });

    const tags = onlyReportTags();
    expect(tags).toMatchObject({ source: 'remote_session_relay', stage: 'hook_write' });
    expect(tags.errno).toMatch(/^E[A-Z]+$/);
    expectNoUserText();
  });

  it('reports a transcript chunk that cannot be written, under stage transcript_write', async () => {
    const { relay } = await makeRelay();
    // A file where the transcript's folder would be.
    fs.writeFileSync(path.join(mirror, 'acme-billing'), 'a file, not a folder');
    await relay.register(registrationOf('s1', { transcriptFiles: [path.join(mirror, 'acme-billing', 'abc.jsonl')] }));

    relay.deliverChunk(chunk('s1', '0', 0, 'hello', 5));

    const tags = onlyReportTags();
    expect(tags).toMatchObject({ source: 'remote_session_relay', stage: 'transcript_write' });
    expect(tags.errno).toMatch(/^E[A-Z]+$/);
    expectNoUserText();
  });
});

describe('the session relay putting an exported transcript in place', () => {
  const spec = (id: string): RemoteTranscriptSnapshot => ({
    file: 'agent',
    args: ['export', id],
    cwd: '/home/dev/project',
    localPath: remoteExportPath(placeOf(), 'agent', id) ?? '',
  });
  const source = (): RemoteTranscriptSource => ({ files: () => [], snapshot: async (id) => spec(id) });

  /** A relay whose session has run its first export, so the export's chunks come on key 0. */
  async function exporting(): Promise<RemoteSessionRelay> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { relay } = await makeRelay();
    await relay.register(registrationOf('s1', { transcripts: source(), agentSessionId: 'abc' }));
    await vi.advanceTimersByTimeAsync(5_000);
    return relay;
  }

  it('reports a whole export that cannot be renamed in, under stage transcript_promote', async () => {
    const relay = await exporting();
    fileFaults.renameSync = () => diskFailure('ENOSPC', 'rename');

    relay.deliverChunk(chunk('s1', '0', 0, '{}\n', 3));

    expect(onlyReportTags()).toMatchObject({ source: 'remote_session_relay', stage: 'transcript_promote', errno: 'ENOSPC', syscall: 'rename' });
    expect(reportHandledError.mock.calls[0][3]).toEqual(['handled-env', 'Error', 'ENOSPC']);
    expectNoUserText();
  });

  it('reports nothing for a copy a reader holds open on Windows, which the next export retries', async () => {
    const relay = await exporting();
    fileFaults.renameSync = () => diskFailure('EPERM', 'rename');

    setPlatform('win32');
    relay.deliverChunk(chunk('s1', '0', 0, '{}\n', 3));
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);

    expect(reportHandledError).not.toHaveBeenCalled();
    // Still staged, so the retry has something to put in place.
    expect(fs.existsSync(`${spec('abc').localPath}.part`)).toBe(true);
  });
});

describe('the session relay reading a CLI\'s session index', () => {
  it('reports a read that throws, under stage index_read', async () => {
    const { relay } = await makeRelay();
    const indexPath = path.join(mirror, '.agent', 'index.jsonl');
    const source: RemoteTranscriptSource = {
      files: () => [],
      index: {
        path: indexPath,
        folder: '/home/dev/project',
        sessionIdsIn: () => { throw new TypeError('Cannot read properties of undefined (reading \'Fix Acme billing\')'); },
      },
    };
    await relay.register(registrationOf('s1', { transcripts: source }));

    relay.deliverChunk(chunk('s1', '0', 0, 'mine\n', 5));

    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));
    expect(onlyReportTags()).toMatchObject({ source: 'remote_session_relay', stage: 'index_read', error_name: 'TypeError' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// Hosts and their projects
// ---------------------------------------------------------------------------

describe('removing a worktree on a host', () => {
  it('reports a path that is no worktree folder of the project, under source remote_host and stage worktree_path, and asks the host nothing', async () => {
    const { createRemoteWorktreeResolver } = await import('../../src/main/remote/remote-worktrees');
    const runCommand = vi.fn();
    const backend = createRemoteWorktreeResolver({
      remoteOfProjectPath: () => ({ hostId: 'host-1', path: '/home/dev/api' }),
      runCommand,
      pathPresence: async (_hostId, paths) => paths.map(() => 'absent' as const),
    })(shellFolder);

    const removed = await backend?.removeWorktree(path.join(shellFolder, 'Fix Acme billing'));

    expect(removed).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'worktree_path', error_name: 'Error' });
    expectNoUserText();
  });
});

describe('taking back the agents a host kept running', () => {
  const sshTarget = serializeCliTarget({
    kind: 'ssh', hostId: 'host-1', home: '/home/dev', shellName: 'zsh', roots: [{ local: '/shell', host: '/home/dev/api' }],
  } as never) as string;
  const record = { id: 'a', task_id: 'task-a', session_type: 'claude_agent', cwd: '/shell/.kangentic/worktrees/api-1', cli_target: sshTarget } as SessionRecord;
  const alive = async () => ({ sessions: [{ sessionId: 'a', alive: true }] as never });

  async function rejoinWith(deps: { snapshot?: () => Promise<never>; adopt?: () => Promise<never> }): Promise<string | undefined> {
    const { rejoinRunningRemoteSessions } = await import('../../src/main/remote/rejoin-sessions');
    const outcomes = await rejoinRunningRemoteSessions([record], {
      snapshot: deps.snapshot ?? alive,
      adopt: deps.adopt ?? (async () => null),
    });
    return outcomes.get('a');
  }

  it('reports a host that answered the snapshot with a failure, under stage rejoin_snapshot, and keeps the record pending', async () => {
    expect(await rejoinWith({ snapshot: async () => { throw helperFailure(); } })).toBe('pending');

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'rejoin_snapshot' });
    expectNoUserText();
  });

  it.each(DROPS)('reports nothing when the snapshot fails on %s, and keeps the record pending', async (_label, makeDrop) => {
    expect(await rejoinWith({ snapshot: async () => { throw makeDrop(); } })).toBe('pending');

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports an agent that could not be taken back, under stage rejoin_adopt, and keeps the record pending', async () => {
    expect(await rejoinWith({ adopt: async () => { throw helperFailure(); } })).toBe('pending');

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'rejoin_adopt' });
    expectNoUserText();
  });

  it.each(DROPS)('reports nothing when the take fails on %s, and keeps the record pending', async (_label, makeDrop) => {
    expect(await rejoinWith({ adopt: async () => { throw makeDrop(); } })).toBe('pending');

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('putting a host\'s own files back when a session ends', () => {
  const TRUST_FILE = '.gemini/trustedFolders.json';

  /** Pull one host file, strip the adapter's entry as a release does, then settle with a failing host. */
  async function settleWithReadFailing(failure: Error): Promise<void> {
    const { HostFileSync, rememberHostFileSync, settleHostFiles } = await import('../../src/main/remote/host-file-sync');
    let readFailure: Error | null = null;
    const place: SshCliPlace = {
      ...placeOf(),
      files: {
        readFile: async () => {
          if (readFailure) throw readFailure;
          return { exists: true, content: '{"/home/dev/project":"TRUST_FOLDER"}' };
        },
        writeFiles: async () => ({ written: 0 }),
        removeFiles: async () => ({ removed: 0 }),
        pathPresence: async (paths) => paths.map(() => 'absent' as const),
        jsonPatch: async () => ({ applied: true, changed: false }),
        runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      },
    };
    const sync = await HostFileSync.pull({ home: [TRUST_FILE], project: [] }, shellFolder, place);
    rememberHostFileSync('session-1', sync);
    fs.writeFileSync(path.join(mirror, '.gemini', 'trustedFolders.json'), '{}');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFailure = failure;

    await settleHostFiles('session-1');
  }

  it('reports a host that answered with a failure, under stage restore_files', async () => {
    await settleWithReadFailing(helperFailure());

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'restore_files' });
    expectNoUserText();
  });

  it.each(DROPS)('reports nothing for %s', async (_label, makeDrop) => {
    await settleWithReadFailing(makeDrop());

    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('working out which dev-server ports a host forwards', () => {
  it('reports a ledger read that throws, under stage port_forward_plan, and sends no host anything', async () => {
    const { PortForwardPlan } = await import('../../src/main/remote/port-forward-plan');
    const send = vi.fn();
    const plan = new PortForwardPlan({
      leases: () => { throw new TypeError('Cannot read properties of undefined (reading \'Fix Acme billing\')'); },
      projects: () => [],
      send,
    });

    await plan.syncNow();

    expect(send).not.toHaveBeenCalled();
    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'port_forward_plan', error_name: 'TypeError' });
    expectNoUserText();
  });
});

describe('keeping this installation\'s id', () => {
  it('reports an id that cannot be written, under stage install_identity_write, and still returns one', async () => {
    const { readInstallId } = await import('../../src/main/remote/install-identity');
    const configDirectory = path.join(scratch, 'acme-config');
    // A folder where the id file should be makes the write fail on every OS.
    fs.mkdirSync(path.join(configDirectory, 'remote-install-id'), { recursive: true });

    const id = readInstallId(configDirectory, () => undefined);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const tags = onlyReportTags();
    expect(tags).toMatchObject({ source: 'remote_host', stage: 'install_identity_write' });
    expect(tags.errno).toMatch(/^E[A-Z]+$/);
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// The SSH settings tab's host admin
// ---------------------------------------------------------------------------

const HOST_ID = '00000001-0000-4000-8000-000000000000';
const KEY_BLOB = Buffer.from('a real looking public key blob, long enough to hash').toString('base64');
const FINGERPRINT = `SHA256:${createHash('sha256').update(Buffer.from(KEY_BLOB, 'base64')).digest('base64').replace(/=+$/, '')}`;

interface AdminRigOptions {
  /** The host row as the table holds it. */
  hostRow?: Partial<SshHost>;
  revealProjects?: SshHostAdminDeps['revealProjects'];
  removeHomeMirror?: SshHostAdminDeps['removeHomeMirror'];
  /** Thrown by the second `setKey`, which is the rollback putting the host's old sign-in back. */
  failRollbackWith?: Error;
}

async function makeAdmin(options: AdminRigOptions = {}) {
  const { SshHostAdmin } = await import('../../src/main/remote/ssh-host-admin');
  const home = path.join(scratch, 'home');
  const shellRoot = path.join(scratch, 'remote-projects');
  for (const folder of [home, shellRoot, path.join(scratch, 'tmp')]) fs.mkdirSync(folder, { recursive: true });
  const host: SshHost = {
    id: HOST_ID,
    name: 'Lab',
    destination: 'lab.example.test',
    key_path: null,
    key_created: false,
    created_at: '2026-11-03T00:00:00.000Z',
    removed_at: null,
    reveal_pending: false,
    ...options.hostRow,
  };
  const setKey = vi.fn((_id: string, keyPath: string | null, keyCreated: boolean) => {
    if (options.failRollbackWith && setKey.mock.calls.length === 2) throw options.failRollbackWith;
    host.key_path = keyPath;
    host.key_created = keyCreated;
    return host;
  });
  // ssh as the settings tab runs it: the address resolves, the host presents one key, and the
  // proof of a sign-in is refused.
  const run: RunProgram = async (_file, args) => {
    if (args.includes('-G')) {
      return { code: 0, stdout: `hostname lab.example.test\nport 22\nuser dev\nuserknownhostsfile ${path.join(home, '.ssh', 'known_hosts')}\n`, stderr: '' };
    }
    const knownHostsOption = args.find((argument) => argument.startsWith('UserKnownHostsFile='));
    if (knownHostsOption) {
      fs.writeFileSync(knownHostsOption.slice('UserKnownHostsFile='.length).replace(/^"|"$/g, ''), `lab.example.test ssh-ed25519 ${KEY_BLOB}\n`);
      return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
    }
    if (args.at(-1) === 'true') return { code: 255, stdout: '', stderr: 'dev@lab: Permission denied (publickey).' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const setup: SshSetupDeps = {
    sshPath: 'ssh',
    sshKeygenPath: 'ssh-keygen',
    run,
    configDirectory: path.join(scratch, 'config'),
    temporaryDirectory: path.join(scratch, 'tmp'),
    platform: process.platform,
    homeDirectory: home,
  };
  const deps: SshHostAdminDeps = {
    hosting: {
      hosts: {
        list: () => (host.removed_at === null ? [host] : []),
        listRemoved: () => (host.removed_at === null ? [] : [host]),
        getById: (id: string) => (id === host.id ? host : undefined),
        restore: (_id: string, name: string) => {
          host.removed_at = null;
          host.name = name;
          return host;
        },
        setKey,
      },
      hostService: { disconnect: async () => undefined },
      status: { get: () => undefined },
      connectHost: async () => undefined,
      expectFirstConnect: () => undefined,
      holdStarts: () => () => undefined,
    } as unknown as SshHostAdminDeps['hosting'],
    projects: { listOnHost: () => [] },
    setup,
    removeProject: async () => undefined,
    suspendProjectSessions: async () => undefined,
    remoteProjectsRoot: shellRoot,
    newShellFolder: () => path.join(shellRoot, 'shell-new'),
    ...(options.revealProjects ? { revealProjects: options.revealProjects } : {}),
    ...(options.removeHomeMirror ? { removeHomeMirror: options.removeHomeMirror } : {}),
  };
  return { admin: new SshHostAdmin(deps), host, setKey, shellRoot, setup };
}

describe('changing how a host signs in', () => {
  const change = { name: 'Lab', destination: 'lab.example.test', signIn: { method: 'config' as const } };

  it('reports a rollback that fails, under stage sign_in_rollback, which the refusal it is wrapped in would hide', async () => {
    const { admin } = await makeAdmin({
      failRollbackWith: new TypeError('Cannot read properties of undefined (reading \'Fix Acme billing\')'),
    });

    // The proof of the new sign-in is refused, so the change rolls back, and the rollback throws.
    await expect(admin.updateHost(HOST_ID, change)).rejects.toThrow(/Permission denied[\s\S]*could not be put back/);

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'sign_in_rollback', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('stops before any key folder is touched when the folder set aside cannot be looked at', async () => {
    const { admin, setKey, setup } = await makeAdmin();
    const keyDirectory = path.join(setup.configDirectory, 'ssh', HOST_ID);
    fs.mkdirSync(keyDirectory, { recursive: true });
    fs.writeFileSync(path.join(keyDirectory, 'id_ed25519'), 'the key the host signs in with');
    fileFaults.access = () => diskFailure('EACCES', 'access');

    await expect(admin.updateHost(HOST_ID, change)).rejects.toMatchObject({ code: 'EACCES' });

    expect(fs.readFileSync(path.join(keyDirectory, 'id_ed25519'), 'utf8')).toBe('the key the host signs in with');
    expect(setKey).not.toHaveBeenCalled();
  });
});

describe('adding a removed host back', () => {
  const REMOVED = { removed_at: '2026-11-06T00:00:00.000Z' };
  const add = { name: 'Lab', destination: 'lab.example.test', signIn: { method: 'config' as const }, expectedFingerprint: FINGERPRINT };

  const FAILURES: ReadonlyArray<readonly [string, () => Error, string]> = [
    ['a defect in the recovery pass', () => new TypeError('Cannot read properties of undefined (reading \'Fix Acme billing\')'), 'TypeError'],
    ['a failure the helper answered with', helperFailure, 'Error'],
  ];

  it.each(FAILURES)('reports projects that could not be started again on %s, under stage reveal_projects, and still adds the host', async (_label, makeFailure, errorName) => {
    const { admin, host } = await makeAdmin({ hostRow: REMOVED, revealProjects: async () => { throw makeFailure(); } });

    const status = await admin.addHost(add);

    expect(status.host.id).toBe(HOST_ID);
    expect(host.removed_at).toBeNull();
    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'reveal_projects', error_name: errorName });
    expectNoUserText();
  });

  it.each(DROPS)('reports nothing for %s, and still adds the host', async (_label, makeDrop) => {
    const { admin, host } = await makeAdmin({ hostRow: REMOVED, revealProjects: async () => { throw makeDrop(); } });

    await admin.addHost(add);

    expect(host.removed_at).toBeNull();
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('clearing a host\'s data and deleting a remote project', () => {
  it('reports a copy of the host\'s transcripts that stays, under stage home_mirror_remove, and still answers', async () => {
    const { admin } = await makeAdmin({ removeHomeMirror: async () => { throw diskFailure('EBUSY', 'rmdir'); } });

    await expect(admin.clearHostData(HOST_ID)).resolves.toBeUndefined();

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'home_mirror_remove', errno: 'EBUSY', syscall: 'rmdir' });
    expect(reportHandledError.mock.calls[0][3]).toEqual(['handled-env', 'Error', 'EBUSY']);
    expectNoUserText();
  });

  it('reports a shell folder that stays, under stage shell_folder_remove, and does not throw', async () => {
    const { admin, shellRoot } = await makeAdmin();
    const shell = path.join(shellRoot, 'shell-a');
    fs.mkdirSync(shell, { recursive: true });
    fileFaults.rm = () => diskFailure('EPERM', 'rm');

    await expect(admin.removeShellFolder(shell)).resolves.toBeUndefined();

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'shell_folder_remove', errno: 'EPERM' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// Connecting a host
// ---------------------------------------------------------------------------

describe('connecting a host', () => {
  const ASSET_SHA = 'a'.repeat(64);
  const PROBE_OK = { code: 0, stdout: 'Linux\nx86_64\n/home/dev\nglibc 2.36\n', stderr: '' };

  beforeEach(() => {
    vi.doMock('../../src/main/remote/install-identity', () => ({ readInstallId: () => 'install-id-for-tests' }));
  });
  afterEach(() => {
    vi.doUnmock('../../src/main/remote/install-identity');
  });

  /** What each step of the install's `ssh` answers. The upload is the script that unpacks it. */
  function sshAnswering(steps: { probe?: SshRunResult | Error; installed?: boolean; upload?: SshRunResult }): void {
    sshControl.run = async (remoteCommand) => {
      if (remoteCommand.includes('uname -s')) {
        const probe = steps.probe ?? PROBE_OK;
        if (probe instanceof Error) throw probe;
        return probe;
      }
      if (remoteCommand.includes('sha256sum')) return steps.upload ?? { code: 0, stdout: '', stderr: '' };
      if (remoteCommand.includes('.complete')) return { code: 0, stdout: steps.installed ? `${ASSET_SHA}\n` : '', stderr: '' };
      // The repeated sign-in that reads ssh's own prompt, and anything else.
      return { code: 255, stdout: '', stderr: '' };
    };
  }

  interface ConnectOptions {
    hostAsset?: () => { version: string; sha256: string; arch: 'x64'; filePath: string; prepare?: () => Promise<void> } | null;
    /** What the pty host answers when the link is added. */
    addHost?: () => Promise<unknown>;
  }

  async function connect(options: ConnectOptions = {}): Promise<{ state: string | undefined; detail: string | null | undefined }> {
    const { createRemoteHosting } = await import('../../src/main/remote/remote-hosting');
    const sessionManager = Object.assign(new EventEmitter(), {
      setRemoteSessionRelay: () => undefined,
      remoteHostRequest: async () => (options.addHost ? options.addHost() : undefined),
      liveRemotePtys: () => [],
    });
    const hosting = createRemoteHosting({
      sessionManager: sessionManager as never,
      projects: () => ({ list: () => [], listIncludingHidden: () => [] }),
      hostAsset: options.hostAsset ?? (() => ({ version: '1.0.0', sha256: ASSET_SHA, arch: 'x64', filePath: path.join(scratch, 'asset.tar.gz') })),
      sshPath: 'ssh',
      log: () => undefined,
    });
    teardown.push(() => hosting.relay.dispose());

    await expect(hosting.connectHost('host-1')).resolves.toBeUndefined();

    const status = hosting.status.get('host-1');
    return { state: status?.state, detail: status?.detail };
  }

  it('reports a build that carries no host program, under stage connect_install', async () => {
    const { state } = await connect({ hostAsset: () => null });

    expect(state).toBe('unreachable');
    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'connect_install', error_name: 'HostProgramMissingError' });
  });

  it('reports an install script that ran on the host and failed there, with its exit status', async () => {
    sshAnswering({ upload: { code: 2, stdout: '', stderr: 'tar: /home/dev/Fix Acme billing: Cannot open' } });

    const { state, detail } = await connect();

    expect(state).toBe('unreachable');
    expect(detail).toMatch(/Installing the helper failed/);
    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'connect_install', error_name: 'HostInstallError', exit_code: '2' });
    expectNoUserText();
  });

  it('reports an archive the host found did not match its checksum', async () => {
    sshAnswering({ upload: { code: 65, stdout: '', stderr: `checksum mismatch: expected ${ASSET_SHA}, got ${'b'.repeat(64)}` } });

    await connect();

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'connect_install', error_name: 'HostInstallError', exit_code: '65' });
  });

  it('reports a downloaded archive that is not the one this build\'s manifest names', async () => {
    const { downloadVerified } = await import('../../src/main/remote/host-assets');
    sshAnswering({});

    await connect({
      hostAsset: () => ({
        version: '1.0.0',
        sha256: ASSET_SHA,
        arch: 'x64',
        filePath: path.join(scratch, 'cache', 'asset.tar.gz'),
        prepare: () => downloadVerified({
          url: 'https://downloads.example.test/Fix-Acme-billing/asset.tar.gz',
          destination: path.join(scratch, 'cache', 'asset.tar.gz'),
          sha256: ASSET_SHA,
          expectedSize: null,
          fetchImpl: async () => new Response('not the archive'),
        }),
      }),
    });

    expect(onlyReportTags()).toMatchObject({ source: 'remote_host', stage: 'connect_install', error_name: 'HostProgramMismatchError' });
    expectNoUserText();
  });

  const NOT_REPORTED: ReadonlyArray<readonly [string, () => ConnectOptions]> = [
    ['a host the network cannot reach', () => {
      sshAnswering({ probe: { code: 255, stdout: '', stderr: 'ssh: connect to host lab port 22: Connection timed out' } });
      return {};
    }],
    ['a refused sign-in', () => {
      sshAnswering({ probe: { code: 255, stdout: '', stderr: 'dev@lab: Permission denied (publickey).' } });
      return {};
    }],
    ['an ssh program that would not start', () => {
      sshAnswering({ probe: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT', syscall: 'spawn ssh' }) });
      return {};
    }],
    ['a host Kangentic does not support', () => {
      sshAnswering({ probe: { code: 0, stdout: 'Darwin\narm64\n/Users/dev\nnone\n', stderr: '' } });
      return {};
    }],
    ['a connection that dropped during the upload', () => {
      sshAnswering({ upload: { code: 255, stdout: '', stderr: 'client_loop: send disconnect: Broken pipe' } });
      return {};
    }],
    ['an upload that ran out of time', () => {
      sshAnswering({ upload: { code: null, stdout: '', stderr: 'ssh did not finish within 600 s' } });
      return {};
    }],
    ...DROPS.map(([label, makeDrop]): readonly [string, () => ConnectOptions] => [`${label} as the link is added`, () => {
      sshAnswering({ installed: true });
      return { addHost: async () => { throw makeDrop(); } };
    }]),
  ];

  it.each(NOT_REPORTED)('reports nothing for %s, and still shows the host unreachable', async (_label, arrange) => {
    const { state } = await connect(arrange());

    expect(state).toBe('unreachable');
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
