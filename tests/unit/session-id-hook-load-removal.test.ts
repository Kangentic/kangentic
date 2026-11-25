/**
 * The hook-load answer of a never-captured session that is removed.
 *
 * `SessionManager.remove()` settles a never-captured outcome, whose hook-load check runs in a
 * microtask, and then deletes the session folder in the same tick. The OpenCode plugin's
 * `opencode-plugin.json` marker lived in that folder, so the outcome read found no file and sent
 * `hook_load: 'none'` ("never loaded") for a plugin that had loaded. What a person loses without
 * these tests is the one tag that tells a plugin that never loaded from one that loaded and heard
 * nothing, on every removed session.
 *
 * Two parts keep it right: the reader answers `unknown` for a folder that is gone, and the report
 * falls back to the answer read at the capture window when the outcome's answer is `unknown`.
 *
 * Tier: Unit. The reader and the adapter are real, on a real temp folder.
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

// The session-id report asks whether `node` is on PATH; answer at once, as a machine with node would.
vi.mock('which', () => ({ default: Object.assign(async () => '/usr/local/bin/node', { sync: () => '/usr/local/bin/node' }) }));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import {
  noteSessionIdCaptureWindowPassed,
  reportSessionIdCaptureOutcome,
  resetLaunchReports,
} from '../../src/main/pty/agent-launch-report';
import { readPluginLoadEvidence } from '../../src/main/agent/adapters/opencode/hook-manager';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode/opencode-adapter';
import { InProcessPtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { ManagedSession } from '../../src/main/pty/session-registry';
import type {
  AgentParser,
  SessionIdHookLoadEvidence,
  SessionIdHookLoadEvidenceOptions,
  SessionIdStoreEvidence,
} from '../../src/shared/types';

const STARTED_AT = '2026-11-04T12:00:00.000Z';
const WINDOW_MS = 30_000;
const never = { kind: 'never', settledBy: 'removed', settledAt: Date.parse(STARTED_AT) + 90_000, filesystemScan: 'empty' } as const;

let tmpDir: string;

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'session-1-long-id',
    taskId: 'task-1',
    projectId: 'project-1',
    pty: null,
    status: 'running',
    shell: '/bin/zsh',
    cwd: '/mock/project',
    commandCwd: '/mock/project',
    startedAt: STARTED_AT,
    exitCode: null,
    resuming: false,
    transient: false,
    exitSequence: ['\x03'],
    reportsAgentStart: true,
    typedLineBytes: 1024,
    launcherUsed: false,
    agentName: 'opencode',
    agentCliVersion: '2.4.1',
    startPath: 'board',
    ...overrides,
  };
}

/** Let the window's check and its bounded wait settle, as the real 30 s gap does. */
async function letTheWindowReadSettle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function hookLoadTagOfTheReport(): string {
  return (reportHandledError.mock.calls[0][1] as Record<string, string>).hook_load;
}

beforeEach(() => {
  reportHandledError.mockClear();
  resetLaunchReports();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-hook-load-removal-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the hook load answer a report sends when the window and the outcome differ', () => {
  async function settleWithAnswers(atWindow: SessionIdHookLoadEvidence, atOutcome: SessionIdHookLoadEvidence): Promise<string> {
    const check = vi.fn<() => Promise<SessionIdHookLoadEvidence>>()
      .mockResolvedValueOnce(atWindow)
      .mockResolvedValueOnce(atOutcome);
    const pastWindow = session();
    noteSessionIdCaptureWindowPassed(pastWindow, null, null, check);
    await letTheWindowReadSettle();
    reportSessionIdCaptureOutcome(pastWindow.id, never, null);
    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
    expect(check).toHaveBeenCalledTimes(2);
    return hookLoadTagOfTheReport();
  }

  it('uses the window\'s answer when the outcome\'s is unknown', async () => {
    expect(await settleWithAnswers('events', 'unknown')).toBe('events');
  });

  it('uses the outcome\'s answer over the window\'s when it is not unknown', async () => {
    expect(await settleWithAnswers('none', 'setup')).toBe('setup');
  });

  it('stays unknown when both answers are unknown', async () => {
    expect(await settleWithAnswers('unknown', 'unknown')).toBe('unknown');
  });
});

describe('the OpenCode plugin marker reader', () => {
  it('reads unknown, not none, once the session folder holding the marker is deleted', async () => {
    const folder = fs.mkdtempSync(path.join(tmpDir, 'session-'));
    fs.writeFileSync(
      path.join(folder, 'opencode-plugin.json'),
      JSON.stringify({ kangenticOpenCodePlugin: 1, major: 2, setupAt: Date.now(), firstEventAt: null }),
    );
    const eventsOutputPath = path.join(folder, 'events.jsonl');
    expect(await readPluginLoadEvidence(eventsOutputPath, new Date(Date.now() - 5_000))).toBe('setup');

    fs.rmSync(folder, { recursive: true, force: true });

    expect(await readPluginLoadEvidence(eventsOutputPath, new Date(Date.now() - 5_000))).toBe('unknown');
  });

  it('reads none for a folder that exists with no marker', async () => {
    const folder = fs.mkdtempSync(path.join(tmpDir, 'session-'));

    expect(await readPluginLoadEvidence(path.join(folder, 'events.jsonl'), new Date())).toBe('none');
  });
});

describe('a session removed in the tick its never-captured outcome is settled', () => {
  it('still reports a plugin that loaded as setup, though the folder is deleted before the outcome read', async () => {
    const folder = fs.mkdtempSync(path.join(tmpDir, 'session-'));
    const spawnedAt = new Date(Date.now() - 5_000);
    fs.writeFileSync(
      path.join(folder, 'opencode-plugin.json'),
      JSON.stringify({ kangenticOpenCodePlugin: 1, major: 2, setupAt: Date.now(), firstEventAt: null }),
    );
    const adapter = new OpenCodeAdapter();
    const realCheck = adapter.runtime.sessionId!.hookLoadEvidence!;
    let windowAnswer: Promise<SessionIdHookLoadEvidence> | null = null;
    const check = (): Promise<SessionIdHookLoadEvidence> => {
      const answer = realCheck({ cwd: tmpDir, eventsOutputPath: path.join(folder, 'events.jsonl'), cliTarget: null, spawnedAt });
      windowAnswer ??= answer;
      return answer;
    };
    const removedSession = session();
    noteSessionIdCaptureWindowPassed(removedSession, null, null, check);
    await vi.waitFor(() => expect(windowAnswer).not.toBeNull());
    expect(await windowAnswer).toBe('setup');
    await letTheWindowReadSettle();

    // What remove() does, in one synchronous block: settle the outcome, then delete the folder.
    reportSessionIdCaptureOutcome(removedSession.id, never, null);
    fs.rmSync(folder, { recursive: true, force: true });

    await vi.waitFor(() => expect(reportHandledError).toHaveBeenCalled());
    expect(hookLoadTagOfTheReport()).toBe('setup');
  });
});

describe('the hook load check as the SessionManager wires it', () => {
  let nextPid = 900;
  let hookLoadEvidence: ReturnType<typeof vi.fn<(options: SessionIdHookLoadEvidenceOptions) => Promise<SessionIdHookLoadEvidence>>>;

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

  function makeAgentParser(): AgentParser {
    return {
      detectFirstOutput: () => false,
      removeHooks: vi.fn(),
      runtime: {
        activity: { kind: 'pty' as const, detectIdle: () => false },
        sessionId: {
          fromOutput: () => null,
          storeEvidence: async () => 'absent' as SessionIdStoreEvidence,
          hookLoadEvidence,
        },
      },
    } as unknown as AgentParser;
  }

  function makeManager(): SessionManager {
    const transport = new InProcessPtyHostTransport({ resolveAgent: () => undefined, transcriptSinkFor: () => null });
    return new SessionManager({ ptyHostTransport: transport });
  }

  function registryRowOf(manager: SessionManager, sessionId: string): ManagedSession {
    const { registry } = manager as unknown as { registry: { get(id: string): ManagedSession | undefined } };
    const row = registry.get(sessionId);
    if (!row) throw new Error('no row');
    return row;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.mocked(pty.spawn).mockReset();
    vi.mocked(pty.spawn).mockImplementation(() => createMockPty() as unknown as pty.IPty);
    hookLoadEvidence = vi.fn(async () => 'none' as SessionIdHookLoadEvidence);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks in the row\'s commandCwd, which wins over its cwd', async () => {
    const manager = makeManager();
    const spawned = await manager.spawn({
      taskId: 'task-1',
      projectId: 'project-1',
      command: 'agent',
      cwd: tmpDir,
      agentParser: makeAgentParser(),
      agentName: 'opencode',
    });
    const commandCwd = path.join(tmpDir, 'command-cwd');
    (registryRowOf(manager, spawned.id) as { commandCwd: string }).commandCwd = commandCwd;

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(hookLoadEvidence).toHaveBeenCalledTimes(1);
    expect(hookLoadEvidence.mock.calls[0][0].cwd).toBe(commandCwd);
    expect(commandCwd).not.toBe(tmpDir);
  });

  it('reaches the check with eventsOutputPath null when the spawn named an empty one', async () => {
    const manager = makeManager();
    await manager.spawn({
      taskId: 'task-1',
      projectId: 'project-1',
      command: 'agent',
      cwd: tmpDir,
      agentParser: makeAgentParser(),
      agentName: 'opencode',
      eventsOutputPath: '',
    });

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(hookLoadEvidence).toHaveBeenCalledTimes(1);
    expect(hookLoadEvidence.mock.calls[0][0].eventsOutputPath).toBeNull();
  });
});
