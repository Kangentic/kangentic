/**
 * A never-turned Claude session's transcript path (Sentry DESKTOP-2M, DESKTOP-2J).
 *
 * A session row got its transcript path from the status line alone, and
 * nothing makes that line run before a session ends. A session whose status
 * line wrote nothing told the row nothing, though its SessionStart hook had
 * already named the same `transcript_path` in `events.jsonl`, which a quit
 * deletes with the session folder. The row was left with no path, the resume
 * check answered `unknown`, and the resume printed "No conversation found".
 *
 * Runs a real SessionManager over a mocked node-pty, the real Claude adapter, a
 * real events file, the real record writer over a real SQLite database, and the
 * real resume check with Claude's own proof. One line here stands in for
 * production wiring: the `'transcript-path'` subscription, which
 * `registerSessionHandlers` makes and `session-transcript-path-wiring.test.ts`
 * pins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

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
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// A session spawned here is young by the real predicate, which would turn the
// teardown's kill into the 1500 ms exit-sequence grace.
vi.mock('../../src/main/pty/lifecycle/deferred-kill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/pty/lifecycle/deferred-kill')>()),
  isYoungSession: () => false,
}));

const openDatabases = vi.hoisted(() => new Map<string, unknown>());

// The record writer only writes a project database that is already open.
vi.mock('../../src/main/db/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/database')>()),
  getOpenProjectDb: (projectId: string) => openDatabases.get(projectId) ?? null,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionRegistry } from '../../src/main/pty/session-registry';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { ClaudeSessionHistoryParser } from '../../src/main/agent/adapters/claude/session-history-parser';
import { runProjectMigrations } from '../../src/main/db/migrations';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { persistHookTranscriptPath } from '../../src/main/ipc/handlers/session-transcript-path';
import { assessResumeConversationWithEvidence } from '../../src/main/transition-engine/resume-conversation-guard';
import { claudeSessionStartContext, claudeSessionStartLine } from './helpers/claude-session-start';
import type { SessionUsage, StoredCliTarget } from '../../src/shared/types';

/** A CLI in a WSL distro, as a session row records it. */
const WSL_TARGET: StoredCliTarget = {
  kind: 'wsl',
  distro: 'Ubuntu',
  homeLinux: '/home/dev',
  homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  uncRoot: '\\\\wsl.localhost\\Ubuntu',
};

/** A status report that names a transcript file. */
function usageReporting(transcriptPath: string): SessionUsage {
  return {
    contextWindow: { usedPercentage: 0, usedTokens: 0, cacheTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, contextWindowSize: 200_000 },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    transcriptPath,
  };
}

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';
const AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';
const SPARE_SESSION_ID = '9dfc0083-eb3a-4c38-bb6c-c4d991525d2b';

/** The path the hook payload of `claudeSessionStartLine` names for an id. */
function hookTranscriptPath(agentSessionId: string): string {
  return (JSON.parse(claudeSessionStartContext(agentSessionId, 'startup')) as { transcript_path: string }).transcript_path;
}

/** A SessionStart line as event-bridge.js writes it, naming a transcript file this test chose. */
function sessionStartLine(agentSessionId: string, transcriptPath: string): string {
  return JSON.stringify({
    ts: 1,
    type: 'session_start',
    hookContext: JSON.stringify({ session_id: agentSessionId, transcript_path: transcriptPath, hook_event_name: 'SessionStart', source: 'startup' }),
  });
}

/** The session manager's privates a test drives or reads directly. */
interface ManagerInternals {
  statusFileReader: { handleEventsChange(sessionId: string): void };
  telemetry: {
    noteSessionStartHooks(sessionId: string, rawLines: string[]): void;
    processStatusUpdate(sessionId: string, usage: SessionUsage): void;
  };
  registry: SessionRegistry;
  hiddenUntilAdopted: Set<string>;
}

function createMockPty() {
  let exitHandler: ((exit: { exitCode: number }) => void) | null = null;
  return {
    pid: 12345,
    cols: 120,
    rows: 30,
    onData: vi.fn(),
    onExit: vi.fn((callback: (exit: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler?.({ exitCode: 0 }), 0);
    }),
  };
}

function openProjectDatabase(): Database.Database {
  const database = new Database(':memory:');
  runProjectMigrations(database);
  database.prepare(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'Executing', 0, '2026-01-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('${TASK_ID}', 1, 'Task', '', 'lane-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  return database;
}

describe('a Claude session whose status line never ran', () => {
  let temporaryDirectory: string;
  let manager: SessionManager;
  let internals: ManagerInternals;
  let spawnedSessionIds: string[];
  let database: Database.Database;
  /** Every `'transcript-path'` a listener heard, as [sessionId, path]. */
  let announcedPaths: Array<[string, string]>;

  beforeEach(() => {
    vi.clearAllMocks();
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-session-start-path-'));
    manager = new SessionManager();
    internals = manager as unknown as ManagerInternals;
    spawnedSessionIds = [];
    announcedPaths = [];
    database = openProjectDatabase();
    openDatabases.clear();
    openDatabases.set(PROJECT_ID, database);
    // No transcript exists for a conversation that never took a turn.
    vi.spyOn(ClaudeSessionHistoryParser, 'locate').mockResolvedValue(null);
    // The subscription `registerSessionHandlers` makes.
    manager.on('transcript-path', (sessionId: string, transcriptPath: string) => {
      announcedPaths.push([sessionId, transcriptPath]);
      persistHookTranscriptPath({ sessionManager: manager }, sessionId, transcriptPath);
    });
  });

  afterEach(async () => {
    for (const sessionId of spawnedSessionIds) await manager.suspend(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.restoreAllMocks();
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  /** A running Claude session with its own events file and a status file nothing writes. */
  async function spawnClaudeSession(options: { transient?: boolean } = {}) {
    const fileStem = `session-${spawnedSessionIds.length}`;
    const eventsOutputPath = path.join(temporaryDirectory, `${fileStem}-events.jsonl`);
    vi.mocked(pty.spawn).mockReturnValue(createMockPty() as unknown as pty.IPty);
    const session = await manager.spawn({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      command: '',
      cwd: temporaryDirectory,
      agentSessionId: AGENT_SESSION_ID,
      statusOutputPath: path.join(temporaryDirectory, `${fileStem}-status.json`),
      eventsOutputPath,
      agentParser: new ClaudeAdapter(),
      ...(options.transient ? { transient: true } : {}),
    });
    spawnedSessionIds.push(session.id);
    return { session, eventsOutputPath };
  }

  /** The record a spawn's caller inserts once `spawn()` resolves. */
  function insertRecord(sessionId: string, reportedPath?: string | null) {
    return new SessionRepository(database).insert({
      id: sessionId, task_id: TASK_ID, session_type: 'claude_agent', isolated_swimlane_id: null,
      agent_session_id: AGENT_SESSION_ID, command: 'claude', cwd: temporaryDirectory, permission_mode: null,
      prompt: 'Fix the login redirect', status: 'running', exit_code: null, started_at: '2026-01-01T00:00:00.000Z',
      suspended_at: null, exited_at: null, suspended_by: null,
      ...(reportedPath !== undefined ? { transcript_path: reportedPath } : {}),
    });
  }

  function storedPath(sessionId: string): string | null | undefined {
    return (database.prepare('SELECT transcript_path FROM sessions WHERE id = ?').get(sessionId) as { transcript_path: string | null } | undefined)?.transcript_path;
  }

  /** Append a SessionStart hook line and wait until the telemetry has read it. */
  async function deliverSessionStart(sessionId: string, eventsOutputPath: string, line: string): Promise<void> {
    const hookSpy = vi.spyOn(internals.telemetry, 'noteSessionStartHooks');
    fs.appendFileSync(eventsOutputPath, `${line}\n`);
    internals.statusFileReader.handleEventsChange(sessionId);
    await vi.waitFor(() => expect(hookSpy).toHaveBeenCalledWith(sessionId, [line]));
    hookSpy.mockRestore();
  }

  it('reports the path its SessionStart hook named, with no status write at all', async () => {
    const { session, eventsOutputPath } = await spawnClaudeSession();
    const reportedPaths: string[] = [];
    manager.on('usage', (_sessionId: string, usage: { transcriptPath?: string } | null) => {
      if (usage?.transcriptPath) reportedPaths.push(usage.transcriptPath);
    });

    await deliverSessionStart(session.id, eventsOutputPath, claudeSessionStartLine(AGENT_SESSION_ID, 'startup'));

    // Red before the fix: the hook was read, and no listener heard a path. The
    // row's only writer listened to `usage`, which the status line alone feeds.
    expect(reportedPaths).toEqual([]);
    expect(announcedPaths).toEqual([[session.id, hookTranscriptPath(AGENT_SESSION_ID)]]);
    expect(manager.getAgentReportedTranscriptPath(session.id)).toBe(hookTranscriptPath(AGENT_SESSION_ID));
  });

  it('keeps that path on the session record, so a restart starts the conversation fresh instead of resuming into nothing', async () => {
    // Where Claude would have written the conversation had it taken a turn.
    const projectsRoot = path.join(temporaryDirectory, 'claude-projects');
    fs.mkdirSync(projectsRoot);
    const transcriptPath = path.join(projectsRoot, '-work-project', `${AGENT_SESSION_ID}.jsonl`);
    const { session, eventsOutputPath } = await spawnClaudeSession();
    insertRecord(session.id);
    expect(storedPath(session.id)).toBeNull();

    await deliverSessionStart(session.id, eventsOutputPath, sessionStartLine(AGENT_SESSION_ID, transcriptPath));

    expect(storedPath(session.id)).toBe(transcriptPath);

    // The quit: the session folder that held the hook's own copy is gone, and
    // the row is all the next launch has. No turn, no report left, the path it
    // kept missing, and Claude's own proof finding the conversation nowhere.
    const record = new SessionRepository(database).getLatestForTask(TASK_ID);
    expect(record?.id).toBe(session.id);
    expect(fs.existsSync(path.join(temporaryDirectory, '.kangentic', 'sessions', session.id))).toBe(false);
    const assessment = await assessResumeConversationWithEvidence({
      adapter: new ClaudeAdapter(),
      agentSessionId: AGENT_SESSION_ID,
      records: record ? [record] : [],
      cwd: path.join(temporaryDirectory, 'never-a-claude-project'),
      projectPath: temporaryDirectory,
    });

    // Red before the fix: `unknown`, with `transcript: 'not_reported'`.
    expect(assessment.verdict).toBe('never-started');
    expect(assessment.promptOwed).toBe(true);
    expect(assessment.evidence).toEqual({ turns: 'no', agentReport: 'none', transcript: 'missing', cwd: 'unknown' });
  });

  it('keeps the path for a record written after the hook: a hidden early agent tells no listener, and its record asks at insert', async () => {
    const { session, eventsOutputPath } = await spawnClaudeSession();
    internals.hiddenUntilAdopted.add(session.id);

    await deliverSessionStart(session.id, eventsOutputPath, claudeSessionStartLine(AGENT_SESSION_ID, 'startup'));

    // Hidden: no listener hears it, and there is no record yet to write to.
    expect(announcedPaths).toEqual([]);
    expect(storedPath(session.id)).toBeUndefined();

    // The task's spawn adopts it and commits its record, asking what the agent
    // has reported so far (`TransitionEngine.commitSessionRecord`).
    expect(manager.adoptSession(session.id)).toBe(true);
    insertRecord(session.id, manager.getAgentReportedTranscriptPath(session.id));

    expect(storedPath(session.id)).toBe(hookTranscriptPath(AGENT_SESSION_ID));
  });

  it('ignores the hook of another conversation started with the same settings', async () => {
    // Claude Code's background daemon runs an empty spare beside the
    // conversation it moved, and its SessionStart lands in the same events file.
    const { session, eventsOutputPath } = await spawnClaudeSession();
    insertRecord(session.id);

    await deliverSessionStart(session.id, eventsOutputPath, claudeSessionStartLine(SPARE_SESSION_ID, 'startup'));

    expect(announcedPaths).toEqual([]);
    expect(storedPath(session.id)).toBeNull();
    expect(manager.getAgentReportedTranscriptPath(session.id)).toBeNull();
  });

  it('stops answering with the hook\'s path once the session has moved to another conversation', async () => {
    const { session, eventsOutputPath } = await spawnClaudeSession();
    await deliverSessionStart(session.id, eventsOutputPath, claudeSessionStartLine(AGENT_SESSION_ID, 'startup'));
    expect(manager.getAgentReportedTranscriptPath(session.id)).toBe(hookTranscriptPath(AGENT_SESSION_ID));

    // A `/clear` the status channel followed: the row is on a new conversation.
    const row = internals.registry.get(session.id);
    if (!row) throw new Error('the spawned session has no registry row');
    row.agentSessionId = SPARE_SESSION_ID;

    expect(manager.getAgentReportedTranscriptPath(session.id)).toBeNull();
  });

  it('maps the hook\'s Linux path onto the distro share for a WSL session, so the record names a file Kangentic can open', async () => {
    const { session, eventsOutputPath } = await spawnClaudeSession();
    const row = internals.registry.get(session.id);
    if (!row) throw new Error('the spawned session has no registry row');
    row.cliTarget = WSL_TARGET;
    const linuxPath = `/home/dev/.claude/projects/-home-dev-app/${AGENT_SESSION_ID}.jsonl`;
    const sharePath = `\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude\\projects\\-home-dev-app\\${AGENT_SESSION_ID}.jsonl`;

    await deliverSessionStart(session.id, eventsOutputPath, sessionStartLine(AGENT_SESSION_ID, linuxPath));

    expect(announcedPaths).toEqual([[session.id, sharePath]]);
    expect(manager.getAgentReportedTranscriptPath(session.id)).toBe(sharePath);
  });

  it('answers with the status line\'s path when the hook named another for the same conversation', async () => {
    const { session, eventsOutputPath } = await spawnClaudeSession();
    const hookPath = path.join(temporaryDirectory, 'hook-named', `${AGENT_SESSION_ID}.jsonl`);
    const statusLinePath = path.join(temporaryDirectory, 'status-line-named', `${AGENT_SESSION_ID}.jsonl`);
    await deliverSessionStart(session.id, eventsOutputPath, sessionStartLine(AGENT_SESSION_ID, hookPath));
    expect(manager.getAgentReportedTranscriptPath(session.id)).toBe(hookPath);

    internals.telemetry.processStatusUpdate(session.id, usageReporting(statusLinePath));

    expect(manager.getAgentReportedTranscriptPath(session.id)).toBe(statusLinePath);
  });

  it('maps the status line\'s Linux path for a WSL session, as it maps the hook\'s', async () => {
    const { session } = await spawnClaudeSession();
    const row = internals.registry.get(session.id);
    if (!row) throw new Error('the spawned session has no registry row');
    row.cliTarget = WSL_TARGET;

    internals.telemetry.processStatusUpdate(session.id, usageReporting(`/home/dev/.claude/projects/-home-dev-app/${AGENT_SESSION_ID}.jsonl`));

    expect(manager.getAgentReportedTranscriptPath(session.id)).toBe(
      `\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude\\projects\\-home-dev-app\\${AGENT_SESSION_ID}.jsonl`,
    );
  });

  it('keeps nothing for a Command Terminal, which has no record', async () => {
    const { session, eventsOutputPath } = await spawnClaudeSession({ transient: true });

    await deliverSessionStart(session.id, eventsOutputPath, claudeSessionStartLine(AGENT_SESSION_ID, 'startup'));

    expect(announcedPaths).toEqual([]);
    expect(manager.getAgentReportedTranscriptPath(session.id)).toBeNull();
  });

  it('keeps nothing for a session on a host: its hook payload is the host\'s word, not a path to open here', async () => {
    const { session, eventsOutputPath } = await spawnClaudeSession();
    insertRecord(session.id);
    const row = internals.registry.get(session.id);
    if (!row) throw new Error('the spawned session has no registry row');
    row.hostId = 'host-1';

    await deliverSessionStart(session.id, eventsOutputPath, claudeSessionStartLine(AGENT_SESSION_ID, 'startup'));

    expect(announcedPaths).toEqual([]);
    expect(storedPath(session.id)).toBeNull();
    expect(manager.getAgentReportedTranscriptPath(session.id)).toBeNull();
  });
});
