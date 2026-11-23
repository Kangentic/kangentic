/**
 * The session-id capture report, through the real `SessionManager`.
 *
 * `SessionIdManager` decides WHEN a session's id counts as late or never
 * captured. What `SessionManager` adds is the wiring that makes the decision
 * reportable: it snapshots the row at the 30 s window (with the adapter's store
 * check, run in the session's `commandCwd`), it tells the manager about a capture
 * only for an id the row takes, and it reads the row's status when the outcome is
 * reported. Tests that rebuild `SessionIdManager` with hand-written callbacks pass
 * whatever `SessionManager` does, so these run the real one.
 *
 * Tier: Unit. Node-pty is mocked, the host core runs in this process, and the
 * 30 s window and the 5 minute ceiling run on fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// A spy around the real swap-back, so a test can run it as Windows on any OS
// (the real one reads process.platform, which a Linux CI run cannot be).
vi.mock('../../src/main/agent/shared/shim-launch', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/shim-launch')>();
  return { ...original, headlessCliPath: vi.fn(original.headlessCliPath) };
});

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

// The session-id report asks whether `node` is on PATH; answer at once, as a machine with node would.
vi.mock('which', () => ({ default: Object.assign(async () => '/usr/local/bin/node', { sync: () => '/usr/local/bin/node' }) }));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { resetLaunchReports } from '../../src/main/pty/agent-launch-report';
import { SessionIdManager } from '../../src/main/pty/lifecycle/session-id-manager';
import { headlessCliPath } from '../../src/main/agent/shared/shim-launch';
import { InProcessPtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType, PromptReason } from '../../src/shared/types';
import type { AgentParser, OpeningPromptDelivery, SessionIdLoginEvidence, SessionIdStoreEvidence, StoredCliTarget } from '../../src/shared/types';

const WINDOW_MS = 30_000;
/**
 * How long a late id read from the output waits for the agent's first output to
 * be noted, since the id and the output come from one chunk in either order.
 * `reportAgentSessionId` captures with source `output`, so every late report
 * below is sent this long after its capture.
 */
const OUTPUT_SETTLE_MS = 2_000;

let tmpDir: string;
let nextPid = 700;
let storeEvidence: ReturnType<typeof vi.fn<(options: { cwd: string; cliTarget?: unknown }) => Promise<SessionIdStoreEvidence>>>;
let loginEvidence: ReturnType<typeof vi.fn<(options: { cliPath: string | null; cliTarget?: unknown; accountHome?: string | null }) => Promise<SessionIdLoginEvidence>>>;

function createMockPty() {
  nextPid += 1;
  return {
    pid: nextPid,
    cols: 120,
    rows: 30,
    onData: vi.fn(() => ({ dispose: () => undefined })),
    onExit: vi.fn(() => ({ dispose: () => undefined })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

/** An adapter with a capture strategy that never fires by itself, so the test decides when an id arrives. */
function makeAgentParser(): AgentParser {
  return {
    detectFirstOutput: () => false,
    removeHooks: vi.fn(),
    runtime: {
      activity: { kind: 'pty' as const, detectIdle: () => false },
      sessionId: { fromOutput: () => null, storeEvidence, loginEvidence },
    },
  } as unknown as AgentParser;
}

function makeManager(): SessionManager {
  const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
  return new SessionManager({ ptyHostTransport: transport });
}

/** The agent reports its id: the path every capture lands on, whichever pathway found it. */
function reportAgentSessionId(manager: SessionManager, sessionId: string, agentReportedId: string): void {
  const { telemetry } = manager as unknown as { telemetry: SessionTelemetry };
  telemetry.notifyAgentSessionId(sessionId, agentReportedId, 'output');
}

function registryRowOf(manager: SessionManager, sessionId: string): ManagedSession {
  const { registry } = manager as unknown as { registry: { get(id: string): ManagedSession | undefined } };
  const row = registry.get(sessionId);
  if (!row) throw new Error('no row');
  return row;
}

async function spawnAgentSession(manager: SessionManager, openingPrompt?: OpeningPromptDelivery): Promise<string> {
  const session = await manager.spawn({
    taskId: 'task-1',
    projectId: 'project-1',
    command: 'agent',
    cwd: tmpDir,
    agentParser: makeAgentParser(),
    agentName: 'codex',
    ...(openingPrompt ? { openingPrompt } : {}),
  });
  return session.id;
}

/** One of the agent's events, ingested as `onEventsParsed` ingests a batch once its ids are taken. */
function ingestAgentEvent(manager: SessionManager, sessionId: string, type: EventType, detail?: string): void {
  const { telemetry } = manager as unknown as { telemetry: SessionTelemetry };
  telemetry.ingestEvents(sessionId, [{ ts: Date.now(), type, ...(detail === undefined ? {} : { detail }) }]);
}

/** The session's PTY exits by itself, as node-pty reports it. */
function exitPty(spawnIndex = 0): void {
  const mockPty = vi.mocked(pty.spawn).mock.results[spawnIndex].value as unknown as ReturnType<typeof createMockPty>;
  const onExit = mockPty.onExit.mock.calls[0]?.[0] as ((exit: { exitCode: number; signal?: number }) => void) | undefined;
  if (!onExit) throw new Error('the PTY has no exit listener');
  onExit({ exitCode: 0, signal: 0 });
}

/** Past the window, with the pending report's store check settled. */
async function passTheWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WINDOW_MS);
}

function reportsNamed(errorName: string): Array<{ tags: Record<string, string> }> {
  return reportHandledError.mock.calls
    .filter((call) => (call[0] as Error).name === errorName)
    .map((call) => ({ tags: call[1] as Record<string, string> }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.mocked(pty.spawn).mockReset();
  vi.mocked(pty.spawn).mockImplementation(() => createMockPty() as unknown as pty.IPty);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-id-capture-'));
  storeEvidence = vi.fn(async () => 'absent' as SessionIdStoreEvidence);
  loginEvidence = vi.fn(async () => 'signed_in' as SessionIdLoginEvidence);
  reportHandledError.mockClear();
  resetLaunchReports();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a session whose id the capture window did not see', () => {
  it('reports nothing at the window: an id can still arrive', async () => {
    const manager = makeManager();
    await spawnAgentSession(manager);

    await passTheWindow();

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a late capture when the agent reports its id after the window', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    await passTheWindow();
    await vi.advanceTimersByTimeAsync(10_000);

    reportAgentSessionId(manager, sessionId, 'agent-session-0001');
    await vi.advanceTimersByTimeAsync(10);
    // Sent only once the agent's first output has had its chance to be noted (DESKTOP-4W).
    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(OUTPUT_SETTLE_MS);

    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(1);
    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags).toMatchObject({
      source: 'agent_session_id',
      agent: 'codex',
      captured_after_s: '30-60',
    });
    expect(reportsNamed('AgentSessionIdNotCapturedError')).toHaveLength(0);

    // The late capture settled the session: removing it later reports no miss.
    manager.remove(sessionId);
    await vi.advanceTimersByTimeAsync(10);
    expect(reportsNamed('AgentSessionIdNotCapturedError')).toHaveLength(0);
  });

  it('reports nothing for an id that arrives inside the window', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);

    reportAgentSessionId(manager, sessionId, 'agent-session-0002');
    await passTheWindow();
    manager.remove(sessionId);
    await vi.advanceTimersByTimeAsync(10);

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('asks the adapter about its store in the session folder and reports the answer as id_store', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    storeEvidence.mockResolvedValue('present');

    await passTheWindow();
    reportAgentSessionId(manager, sessionId, 'agent-session-0003');
    await vi.advanceTimersByTimeAsync(OUTPUT_SETTLE_MS + 10);

    expect(storeEvidence).toHaveBeenCalledTimes(1);
    // A local session names no CLI target, and its folder is the one it was started in. The check is
    // asked about this session, so it gets the spawn time too.
    expect(storeEvidence).toHaveBeenCalledWith({
      cwd: tmpDir,
      cliTarget: null,
      spawnedAt: new Date(registryRowOf(manager, sessionId).startedAt),
    });
    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags.id_store).toBe('present');
  });

  it("forwards the row's stored CLI target to the adapter's store check", async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    const wslTarget: StoredCliTarget = { kind: 'wsl', distro: 'TestDistro', homeLinux: '/home/dev' };
    registryRowOf(manager, sessionId).cliTarget = wslTarget;

    await passTheWindow();

    expect(storeEvidence).toHaveBeenCalledTimes(1);
    expect(storeEvidence).toHaveBeenCalledWith({
      cwd: tmpDir,
      cliTarget: wslTarget,
      spawnedAt: new Date(registryRowOf(manager, sessionId).startedAt),
    });
  });

  it('reports the store as unknown when the adapter has no check', async () => {
    const manager = makeManager();
    const parser = makeAgentParser();
    delete (parser.runtime!.sessionId as { storeEvidence?: unknown }).storeEvidence;
    const session = await manager.spawn({
      taskId: 'task-1', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser: parser, agentName: 'codex',
    });

    await passTheWindow();
    reportAgentSessionId(manager, session.id, 'agent-session-0004');
    await vi.advanceTimersByTimeAsync(OUTPUT_SETTLE_MS + 10);

    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags.id_store).toBe('unknown');
  });

  it("reports a removed session as never captured, with the row's own status", async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    storeEvidence.mockResolvedValue('absent');
    await passTheWindow();

    manager.remove(sessionId);
    await vi.advanceTimersByTimeAsync(10);

    const reports = reportsNamed('AgentSessionIdNotCapturedError');
    expect(reports).toHaveLength(1);
    // remove() settles before it deletes the row, so the row's status is still there to read.
    expect(reports[0].tags).toMatchObject({
      source: 'agent_session_id',
      agent: 'codex',
      settled_by: 'removed',
      session_status: 'running',
      id_store: 'absent',
    });
    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(0);
  });

  it('reports a session still without an id at the ceiling as never captured', async () => {
    const manager = makeManager();
    await spawnAgentSession(manager);

    await vi.advanceTimersByTimeAsync(SessionIdManager.CAPTURE_CEILING_MS + 10);

    expect(reportsNamed('AgentSessionIdNotCapturedError')[0]?.tags).toMatchObject({
      settled_by: 'ceiling',
      session_status: 'running',
    });
  });
});

// Sentry DESKTOP-4C: a terminal started with no prompt took its first one
// minutes in, gave its id right behind it, and was reported late against its
// spawn. An agent may have no conversation, and so no id, until someone types.
describe('a session started with no opening prompt', () => {
  it('reports nothing when its id arrives with its first prompt, minutes after the spawn', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager, 'none');
    await passTheWindow();
    await vi.advanceTimersByTimeAsync(150_000);

    // The order of one batch of hook records: its ids, then its events.
    reportAgentSessionId(manager, sessionId, 'agent-session-0006');
    ingestAgentEvent(manager, sessionId, EventType.Prompt);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports the capture late when the only prompt before it was PTY output standing in for one', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager, 'none');
    // What the PTY tracker pushes for a first frame: no one typed anything.
    ingestAgentEvent(manager, sessionId, EventType.Prompt, PromptReason.PtyActivity);
    await passTheWindow();
    await vi.advanceTimersByTimeAsync(150_000);

    reportAgentSessionId(manager, sessionId, 'agent-session-0007');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(1);
    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags).toMatchObject({
      opening_prompt: 'none',
      prompt_seen: 'no',
      after_prompt_s: 'none',
      captured_after_s: '60-300',
    });
  });
});

// Sentry DESKTOP-36: a Codex that ran and exited about four seconds later, with
// no hook and no session written, read the same as a live conversation whose id
// was missed. The row now keeps when its agent ran and when its PTY exited, and
// such a run goes to the launch report: it had no conversation to capture.
describe('a session that never gave an id', () => {
  it('sends an agent that exited seconds after it ran as one launch report, with how long it ran', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager, 'command_line');
    await vi.advanceTimersByTimeAsync(27_000);
    ingestAgentEvent(manager, sessionId, EventType.ToolStart);
    await vi.advanceTimersByTimeAsync(4_000);
    exitPty();
    await vi.advanceTimersByTimeAsync(100);
    expect(registryRowOf(manager, sessionId).status).toBe('exited');

    await vi.advanceTimersByTimeAsync(SessionIdManager.CAPTURE_CEILING_MS);

    const reports = reportsNamed('AgentLaunchAgentExitedError');
    expect(reports).toHaveLength(1);
    expect(reports[0].tags).toMatchObject({
      source: 'agent_launch',
      stage: 'agent_exited',
      cause: 'no_conversation',
      opening_prompt: 'command_line',
      prompt_seen: 'no',
      settled_by: 'ceiling',
      session_status: 'exited',
      agent_ran_for_s: '1-5',
      id_store: 'absent',
    });
    expect(reportsNamed('AgentSessionIdNotCapturedError')).toHaveLength(0);
    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(0);
  });

  // A signed-out Codex opens on its sign-in screen: a frame and no conversation.
  // The adapter is asked at the window, with the command the session ran.
  it('asks the adapter whether its CLI holds a login, and reports nothing for one that is signed out', async () => {
    const manager = makeManager();
    loginEvidence.mockResolvedValue('signed_out');
    const sessionId = await spawnAgentSession(manager, 'command_line');
    registryRowOf(manager, sessionId).agentCliPath = path.join(tmpDir, 'codex');

    await vi.advanceTimersByTimeAsync(SessionIdManager.CAPTURE_CEILING_MS + 10);

    expect(loginEvidence).toHaveBeenCalledTimes(1);
    expect(loginEvidence).toHaveBeenCalledWith({ cliPath: path.join(tmpDir, 'codex'), cliTarget: null, accountHome: null });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('still reports a signed-out CLI that took a prompt, and says what the CLI answered', async () => {
    const manager = makeManager();
    loginEvidence.mockResolvedValue('signed_out');
    const sessionId = await spawnAgentSession(manager, 'command_line');
    ingestAgentEvent(manager, sessionId, EventType.Prompt);

    await vi.advanceTimersByTimeAsync(SessionIdManager.CAPTURE_CEILING_MS + 10);

    expect(reportsNamed('AgentSessionIdNotCapturedError')[0]?.tags).toMatchObject({ login: 'signed_out', prompt_seen: 'yes' });
  });

  it('names no CLI for a session on a host, whose login this computer cannot ask about', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    const row = registryRowOf(manager, sessionId);
    row.agentCliPath = '/usr/local/bin/codex';
    row.hostId = 'host-1';

    await passTheWindow();

    expect(loginEvidence).toHaveBeenCalledWith({ cliPath: null, cliTarget: null, accountHome: null });
  });

  // A PowerShell or Git Bash launch keeps the .ps1 or sh sibling as agentCliPath, and the
  // login check spawns with no shell, where neither starts. The check gets the .cmd back.
  describe('the login check of a session launched through a shim sibling', () => {
    async function actAsWindows(): Promise<void> {
      const actual = await vi.importActual<typeof import('../../src/main/agent/shared/shim-launch')>('../../src/main/agent/shared/shim-launch');
      vi.mocked(headlessCliPath).mockImplementation((launchPath, dependencies) =>
        actual.headlessCliPath(launchPath, { platform: 'win32', ...dependencies }));
    }

    afterEach(async () => {
      const actual = await vi.importActual<typeof import('../../src/main/agent/shared/shim-launch')>('../../src/main/agent/shared/shim-launch');
      vi.mocked(headlessCliPath).mockImplementation(actual.headlessCliPath);
    });

    it('hands the check the .cmd beside a .ps1 launch path', async () => {
      await actAsWindows();
      const ps1Path = path.join(tmpDir, 'codex.ps1');
      const cmdPath = path.join(tmpDir, 'codex.cmd');
      fs.writeFileSync(cmdPath, '@echo off\r\n');
      const manager = makeManager();
      const sessionId = await spawnAgentSession(manager);
      registryRowOf(manager, sessionId).agentCliPath = ps1Path;

      await passTheWindow();

      expect(loginEvidence).toHaveBeenCalledTimes(1);
      expect(loginEvidence).toHaveBeenCalledWith({ cliPath: cmdPath, cliTarget: null, accountHome: null });
    });

    it('passes a WSL session\'s CLI path through unchanged, with no swap back', async () => {
      await actAsWindows();
      const ps1Path = path.join(tmpDir, 'codex.ps1');
      fs.writeFileSync(path.join(tmpDir, 'codex.cmd'), '@echo off\r\n');
      const wslTarget: StoredCliTarget = { kind: 'wsl', distro: 'TestDistro', homeLinux: '/home/dev' };
      const manager = makeManager();
      const sessionId = await spawnAgentSession(manager);
      const row = registryRowOf(manager, sessionId);
      row.agentCliPath = ps1Path;
      row.cliTarget = wslTarget;

      await passTheWindow();

      expect(loginEvidence).toHaveBeenCalledWith({ cliPath: ps1Path, cliTarget: wslTarget, accountHome: null });
    });
  });

  // The login a session read is in its account's home, so the check is asked about that home.
  describe('the login check of a session on an account', () => {
    async function loginCheckFor(resolver: ((accountId: string) => string | null | undefined) | null): Promise<void> {
      const manager = makeManager();
      if (resolver) manager.setAccountHomeResolver(resolver);
      const sessionId = await spawnAgentSession(manager);
      const row = registryRowOf(manager, sessionId);
      row.agentCliPath = path.join(tmpDir, 'codex');
      row.homeAccountId = 'account-2';
      await passTheWindow();
    }

    it('asks about the folder the account keeps its login in', async () => {
      const accountFolder = path.join(tmpDir, 'account-2-home');
      const resolver = vi.fn((accountId: string) => (accountId === 'account-2' ? accountFolder : undefined));
      await loginCheckFor(resolver);

      expect(resolver).toHaveBeenCalledWith('account-2');
      expect(loginEvidence).toHaveBeenCalledTimes(1);
      expect(loginEvidence).toHaveBeenCalledWith({ cliPath: path.join(tmpDir, 'codex'), cliTarget: null, accountHome: accountFolder });
    });

    it('asks about the agent\'s own home for an account that lives there', async () => {
      await loginCheckFor(() => null);

      expect(loginEvidence).toHaveBeenCalledWith({ cliPath: path.join(tmpDir, 'codex'), cliTarget: null, accountHome: null });
    });

    it('names no CLI for an account nobody knows, so the adapter answers unknown', async () => {
      await loginCheckFor(() => undefined);

      expect(loginEvidence).toHaveBeenCalledWith({ cliPath: null, cliTarget: null, accountHome: null });
    });

    it('names no CLI for an account when no resolver was set', async () => {
      await loginCheckFor(null);

      expect(loginEvidence).toHaveBeenCalledWith({ cliPath: null, cliTarget: null, accountHome: null });
    });
  });

  it('reads running for a session whose agent is still up at the ceiling', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestAgentEvent(manager, sessionId, EventType.ToolStart);

    await vi.advanceTimersByTimeAsync(SessionIdManager.CAPTURE_CEILING_MS + 10);

    expect(reportsNamed('AgentSessionIdNotCapturedError')[0]?.tags).toMatchObject({ settled_by: 'ceiling', agent_ran_for_s: 'running' });
  });
});

// Sentry DESKTOP-4J: agy's id came minutes late, and the report could say neither
// whether an agy hook had fired (`hook_seen` counted the PTY tracker's first-frame
// Prompt) nor which path the id finally came through.
describe('what a late report says about the hooks and the path', () => {
  type ReaderCallbacks = { onEventsParsed(sessionId: string, rawLines: string[], events: unknown[]): void };

  /** A batch read from the session's events file, as the status-file reader hands it on. */
  function deliverHookLines(manager: SessionManager, sessionId: string, rawLines: string[]): void {
    const { statusFileReader } = manager as unknown as { statusFileReader: { callbacks: ReaderCallbacks } };
    statusFileReader.callbacks.onEventsParsed(sessionId, rawLines, []);
  }

  it('reads hook_seen no when only the PTY stand-in prompt reached the session by the window', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager, 'command_line');
    ingestAgentEvent(manager, sessionId, EventType.Prompt, PromptReason.PtyActivity);
    // A status line's events carry no hook lines either.
    deliverHookLines(manager, sessionId, []);
    await passTheWindow();

    reportAgentSessionId(manager, sessionId, 'agent-session-0008');
    await vi.advanceTimersByTimeAsync(OUTPUT_SETTLE_MS + 10);

    expect(registryRowOf(manager, sessionId).agentHookObservedAt).toEqual(expect.any(Number));
    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags).toMatchObject({ hook_seen: 'no', captured_by: 'output' });
  });

  it('reads hook_seen yes for a line the agent\'s hooks wrote, and names the hook path that gave the id', async () => {
    const manager = makeManager();
    const parser = makeAgentParser();
    (parser.runtime!.sessionId as { fromHook?: (hookContext: string) => string | null }).fromHook = (hookContext) =>
      (JSON.parse(hookContext) as { conversationId?: string }).conversationId ?? null;
    const session = await manager.spawn({
      taskId: 'task-1', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser: parser, agentName: 'antigravity',
    });
    deliverHookLines(manager, session.id, [JSON.stringify({ ts: Date.now(), type: 'prompt' })]);
    await passTheWindow();

    const hookLine = JSON.stringify({ ts: Date.now(), type: 'prompt', hookContext: JSON.stringify({ conversationId: 'agent-session-0009' }) });
    deliverHookLines(manager, session.id, [hookLine]);
    await vi.advanceTimersByTimeAsync(10);

    expect(registryRowOf(manager, session.id).agentSessionId).toBe('agent-session-0009');
    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags).toMatchObject({ hook_seen: 'yes', captured_by: 'hook' });
  });

  it('keeps the time of the first hook batch when later batches arrive', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager, 'command_line');
    const firstBatchAt = Date.now();
    deliverHookLines(manager, sessionId, [JSON.stringify({ ts: firstBatchAt, type: 'prompt' })]);
    expect(registryRowOf(manager, sessionId).agentHookLineAt).toBe(firstBatchAt);

    await vi.advanceTimersByTimeAsync(5_000);
    deliverHookLines(manager, sessionId, [JSON.stringify({ ts: Date.now(), type: 'prompt' })]);

    expect(Date.now()).toBeGreaterThan(firstBatchAt);
    expect(registryRowOf(manager, sessionId).agentHookLineAt).toBe(firstBatchAt);
  });

  it('tells telemetry about a batch that carries hook lines, and not about an empty one', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager, 'command_line');
    const { telemetry } = manager as unknown as { telemetry: SessionTelemetry };
    const notifyHookLines = vi.spyOn(telemetry, 'notifyHookLines');

    deliverHookLines(manager, sessionId, []);
    expect(notifyHookLines).not.toHaveBeenCalled();

    deliverHookLines(manager, sessionId, [JSON.stringify({ ts: Date.now(), type: 'prompt' })]);
    expect(notifyHookLines).toHaveBeenCalledTimes(1);
    expect(notifyHookLines).toHaveBeenCalledWith(sessionId);
  });

  it('names the scrollback scan for an id first found at the suspend', async () => {
    const manager = makeManager();
    const parser = makeAgentParser();
    const session = await manager.spawn({
      taskId: 'task-1', projectId: 'project-1', command: 'agent', cwd: tmpDir, agentParser: parser, agentName: 'antigravity',
    });
    await passTheWindow();

    const { sessionIdManager } = manager as unknown as { sessionIdManager: SessionIdManager };
    sessionIdManager.scanScrollback(session.id, { ...parser, runtime: { ...parser.runtime!, sessionId: { fromOutput: () => 'agent-session-0010' } } } as AgentParser, 'shutdown summary');
    await vi.advanceTimersByTimeAsync(10);

    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags).toMatchObject({ hook_seen: 'no', captured_by: 'scrollback' });
  });
});

describe('an id a host reports that is no plain name', () => {
  // The remote spawn needs the whole link stack, so the row is marked as a host's after a local spawn: the
  // guard in onAgentSessionId reads only `session.hostId`.
  it('is no late capture: the session stays a miss and is reported never captured', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    registryRowOf(manager, sessionId).hostId = 'host-1';
    await passTheWindow();

    reportAgentSessionId(manager, sessionId, '../escape');
    await vi.advanceTimersByTimeAsync(10);

    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(0);
    expect(registryRowOf(manager, sessionId).agentSessionId).toBeUndefined();

    manager.remove(sessionId);
    await vi.advanceTimersByTimeAsync(10);
    expect(reportsNamed('AgentSessionIdNotCapturedError')).toHaveLength(1);
  });

  it('is still a late capture when the host reports a plain name', async () => {
    const manager = makeManager();
    const sessionId = await spawnAgentSession(manager);
    registryRowOf(manager, sessionId).hostId = 'host-1';
    await passTheWindow();

    reportAgentSessionId(manager, sessionId, 'agent-session-0005');
    await vi.advanceTimersByTimeAsync(OUTPUT_SETTLE_MS + 10);

    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(1);
  });
});
