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

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { resetLaunchReports } from '../../src/main/pty/agent-launch-report';
import { SessionIdManager } from '../../src/main/pty/lifecycle/session-id-manager';
import { InProcessPtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import type { AgentParser, SessionIdStoreEvidence } from '../../src/shared/types';

const WINDOW_MS = 30_000;

let tmpDir: string;
let nextPid = 700;
let storeEvidence: ReturnType<typeof vi.fn<(options: { cwd: string; cliTarget?: unknown }) => Promise<SessionIdStoreEvidence>>>;

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
      sessionId: { fromOutput: () => null, storeEvidence },
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
  telemetry.notifyAgentSessionId(sessionId, agentReportedId);
}

function registryRowOf(manager: SessionManager, sessionId: string): ManagedSession {
  const { registry } = manager as unknown as { registry: { get(id: string): ManagedSession | undefined } };
  const row = registry.get(sessionId);
  if (!row) throw new Error('no row');
  return row;
}

async function spawnAgentSession(manager: SessionManager): Promise<string> {
  const session = await manager.spawn({
    taskId: 'task-1',
    projectId: 'project-1',
    command: 'agent',
    cwd: tmpDir,
    agentParser: makeAgentParser(),
    agentName: 'codex',
  });
  return session.id;
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
    await vi.advanceTimersByTimeAsync(10);

    expect(storeEvidence).toHaveBeenCalledTimes(1);
    // A local session names no CLI target, and its folder is the one it was started in.
    expect(storeEvidence).toHaveBeenCalledWith({ cwd: tmpDir, cliTarget: null });
    expect(reportsNamed('AgentSessionIdCapturedLateError')[0].tags.id_store).toBe('present');
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
    await vi.advanceTimersByTimeAsync(10);

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
    await vi.advanceTimersByTimeAsync(10);

    expect(reportsNamed('AgentSessionIdCapturedLateError')).toHaveLength(1);
  });
});
