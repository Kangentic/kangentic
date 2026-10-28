/**
 * An agent-reported transcript path reaches the adapter from main-process callers.
 *
 * `AgentAdapter.locateSessionHistoryFile`, `parseTranscript` and
 * `statSubagentTranscripts` take an optional trailing `reportedPath`: the file
 * the agent itself said it was writing. An agent can keep writing a resumed
 * conversation outside the folder its cwd maps to, so a caller that passes only
 * the id and the cwd reads a stale or missing file. The adapters have their own
 * tests; every existing caller test passes null. These tests pin the callers'
 * wiring, so a caller that stops forwarding the path (or reads the wrong
 * column) goes red:
 *
 * - the workflow hang check reads it from `sessionManager.getReportedTranscriptPath`
 *   for both the history file and the subagent transcripts;
 * - the workflow agent's turn recording sends it to the retrieval worker;
 * - the MCP commands and the transcript service read it from the session row's
 *   `transcript_path`, on a real migrated database, so a SELECT that drops the
 *   column is caught too (a fake `db.prepare` would hand back whatever it is given);
 * - the resume-time id reconcile takes it from the usage the status file parsed to;
 * - the command-injection verifier takes it from the live record, and from the
 *   record captured at plan time on its fallback call, and from the captured
 *   record when the live one cannot be re-read.
 *
 * Red-green: dropping the forwarded argument at each caller fails the test
 * named for that caller and no other.
 *
 * Not covered here: other callers that forward the path, among them the board
 * message trail's session facts (`ipc/handlers/sessions.ts`), the agent
 * handoff's source lookup (`ipc/helpers/agent-spawn.ts`) and the final-reply
 * reader (`automations/turn-end/final-reply-reader.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { SessionRecord, SessionUsage, TranscriptEntry } from '../../src/shared/types';

const harness = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  getAdapterBySessionType: vi.fn(),
  retrievalCall: vi.fn(),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: (...args: unknown[]) => harness.getAdapter(...args),
    getBySessionType: (...args: unknown[]) => harness.getAdapterBySessionType(...args),
    // What the real remote-targets collector walks: no remote servers.
    list: () => [],
  },
}));
// The step lookup reads a project database; every session here is a running workflow step.
vi.mock('../../src/main/workflows/workflow-home', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-home')>()),
  isRunningWorkflowStepTask: () => true,
}));
// The real lookup would open a database under the real config directory. The
// spend capture catches this throw, as it does a database closing under a quit.
vi.mock('../../src/main/db/database', () => ({
  getExistingProjectDb: () => null,
  getProjectDb: () => {
    throw new Error('No project database in this test');
  },
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
// The retrieval worker is another process: the agent's turn recording and the
// structured transcript read are calls to it.
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: (...args: unknown[]) => harness.retrievalCall(...args) },
}));

import { checkForHungTurns, stopWorkflowHangCheck } from '../../src/main/workflows/workflow-hang-check';
import { pauseWorkflowAgent } from '../../src/main/workflows/workflow-agent';
import { handleGetSessionHistory } from '../../src/main/agent/commands/analytics-commands';
import { handleGetSessionFiles } from '../../src/main/agent/commands/session-files-commands';
import { handleGetTranscript } from '../../src/main/agent/commands/inspect-commands';
import { renderStructuredTranscript, type StructuredTranscriptRequest } from '../../src/main/agent/commands/structured-transcript';
import { resolveSessionTranscript, resetForTests as resetTranscriptServiceForTests } from '../../src/main/agent/transcript-service';
import { reconcileResumeAgentSessionId } from '../../src/main/transition-engine/resume-id-reconcile';
import { buildCommandInjectionVerifier } from '../../src/main/transition-engine/injection-plan';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { openTestDatabase } from './helpers/test-database';

const MINUTE = 60_000;
const REPORTED_PATH = '/reported/elsewhere/conversation.jsonl';

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function makeTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  harness.getAdapter.mockReset();
  harness.getAdapterBySessionType.mockReset();
  harness.retrievalCall.mockReset();
  harness.retrievalCall.mockResolvedValue({ success: true, message: 'rendered' });
  resetTranscriptServiceForTests();
});

afterEach(() => {
  stopWorkflowHangCheck();
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The workflow hang check
// ---------------------------------------------------------------------------

describe('the workflow hang check reads the history by the path the agent reported', () => {
  let cwd: string;
  let historyFile: string;
  let reportedPath: string | null;
  let locateSessionHistoryFile: ReturnType<typeof vi.fn>;
  let statSubagentTranscripts: ReturnType<typeof vi.fn>;
  let context: IpcContext;

  beforeEach(() => {
    cwd = makeTemporaryDirectory('kangentic-reported-hang-');
    historyFile = path.join(cwd, 'agent-session-1.jsonl');
    fs.writeFileSync(historyFile, '{}\n');
    // Written 25 minutes ago, past the 20-minute limit and so short of "enough":
    // the subagents' files are read too.
    const writtenAt = new Date(Date.now() - 25 * MINUTE);
    fs.utimesSync(historyFile, writtenAt, writtenAt);
    reportedPath = REPORTED_PATH;
    locateSessionHistoryFile = vi.fn(async () => historyFile);
    // A subagent wrote just now, so the pass ends there: the turn is not hung and nothing is interrupted.
    statSubagentTranscripts = vi.fn(() => ({ fileCount: 1, totalSize: 1, maxMtimeMs: Date.now() }));
    harness.getAdapter.mockImplementation((name: string) => (name === 'claude'
      ? {
        hungTurn: { quietLimitMs: 20 * MINUTE, interruptKeys: '\x1b' },
        locateSessionHistoryFile,
        statSubagentTranscripts,
      }
      : undefined));
    const session = {
      id: 'session-1',
      taskId: 'task-1',
      projectId: 'project-1',
      status: 'running',
      transient: false,
      workflowId: null,
      agentSessionId: 'agent-session-1',
      cwd,
    };
    context = {
      sessionManager: {
        listSessions: () => [session],
        getSession: () => session,
        getActivityCache: () => ({ 'session-1': 'thinking' }),
        getActivityReason: () => ({ kind: 'turn-active' }),
        getSessionAgentName: () => 'claude',
        getSessionCliTarget: () => null,
        getReportedTranscriptPath: () => reportedPath,
        getPendingDraft: () => null,
        write: vi.fn(),
        signalUserInterrupt: vi.fn(),
      },
      terminalSubmitScheduler: { hasPending: () => false },
    } as unknown as IpcContext;
  });

  it('locates the history file with the reported path as the trailing argument', async () => {
    await checkForHungTurns(context);

    expect(locateSessionHistoryFile).toHaveBeenCalledWith('agent-session-1', cwd, null, REPORTED_PATH);
  });

  it('reads the subagent transcripts with the reported path as the trailing argument', async () => {
    await checkForHungTurns(context);

    expect(statSubagentTranscripts).toHaveBeenCalledWith('agent-session-1', cwd, null, REPORTED_PATH);
  });

  it('passes null, not undefined, when the agent reported none', async () => {
    reportedPath = null;

    await checkForHungTurns(context);

    expect(locateSessionHistoryFile).toHaveBeenCalledWith('agent-session-1', cwd, null, null);
    expect(statSubagentTranscripts).toHaveBeenCalledWith('agent-session-1', cwd, null, null);
  });
});

// ---------------------------------------------------------------------------
// The workflow agent's turn recording
// ---------------------------------------------------------------------------

describe('the workflow agent\'s turn recording sends the reported path to the retrieval worker', () => {
  let cwd: string;
  let reportedPath: string | null;
  let context: IpcContext;

  beforeEach(() => {
    cwd = makeTemporaryDirectory('kangentic-reported-turns-');
    reportedPath = REPORTED_PATH;
    harness.getAdapter.mockImplementation(() => ({ sessionType: 'claude_agent' }));
    const session = {
      id: 'pty-agent',
      taskId: 'workflow-1',
      projectId: 'home',
      status: 'running',
      transient: true,
      workflowId: 'workflow-1',
      agentSessionId: 'conversation-1',
      cwd,
    };
    context = {
      sessionManager: {
        listSessions: () => [session],
        getSessionAgentName: () => 'claude',
        getSessionCliTarget: () => null,
        getReportedTranscriptPath: () => reportedPath,
        getUsageCache: () => ({}),
        suspend: vi.fn(async () => undefined),
      },
    } as unknown as IpcContext;
  });

  it('carries the reported path in the index.workflowAgentTurns payload', async () => {
    await pauseWorkflowAgent(context, 'workflow-1');

    expect(harness.retrievalCall).toHaveBeenCalledTimes(1);
    expect(harness.retrievalCall).toHaveBeenCalledWith('index.workflowAgentTurns', expect.objectContaining({
      sessionId: 'pty-agent',
      agentSessionId: 'conversation-1',
      cwd,
      transcriptPath: REPORTED_PATH,
    }));
  });

  it('carries null when the agent reported none', async () => {
    reportedPath = null;

    await pauseWorkflowAgent(context, 'workflow-1');

    expect(harness.retrievalCall).toHaveBeenCalledWith('index.workflowAgentTurns', expect.objectContaining({ transcriptPath: null }));
  });
});

// ---------------------------------------------------------------------------
// The MCP commands and the transcript service, on a real migrated database
// ---------------------------------------------------------------------------

interface SessionSeed {
  id: string;
  taskId: string;
  agentSessionId: string;
  cwd: string;
  transcriptPath: string | null;
  sessionType?: string;
  startedAt?: string;
}

function openMigratedDatabase(): Database.Database {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  return database;
}

function insertTask(database: Database.Database, taskId: string): void {
  database
    .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, 'Reported path task', '', 'lane-1', 0, '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
}

function insertSession(database: Database.Database, seed: SessionSeed): void {
  database
    .prepare(`INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at, transcript_path)
              VALUES (?, ?, ?, ?, 'agent', ?, 'suspended', ?, ?)`)
    .run(seed.id, seed.taskId, seed.sessionType ?? 'claude_agent', seed.agentSessionId, seed.cwd, seed.startedAt ?? '2026-10-27T12:00:00.000Z', seed.transcriptPath);
}

function commandContext(database: Database.Database, projectRoot: string): CommandContext {
  return {
    projectId: 'project-1',
    getProjectDb: () => database,
    getProjectPath: () => projectRoot,
    getDevServerPortRange: () => ({}),
  } as unknown as CommandContext;
}

/** The first four arguments of the adapter call the test made. */
function firstCallArguments(mock: ReturnType<typeof vi.fn>): unknown[] {
  expect(mock).toHaveBeenCalledTimes(1);
  return mock.mock.calls[0].slice(0, 4);
}

describe('kangentic_get_session_history passes the row\'s transcript_path', () => {
  it('to locateSessionHistoryFile as the trailing argument', async () => {
    const database = openMigratedDatabase();
    insertTask(database, 'task-1');
    insertSession(database, { id: 'session-1', taskId: 'task-1', agentSessionId: 'agent-session-1', cwd: '/work/project', transcriptPath: REPORTED_PATH });
    const locateSessionHistoryFile = vi.fn(async (): Promise<string | null> => null);
    harness.getAdapterBySessionType.mockReturnValue({ name: 'claude', displayName: 'Claude Code', locateSessionHistoryFile });

    await handleGetSessionHistory({ taskId: 'task-1' }, commandContext(database, makeTemporaryDirectory('kangentic-reported-history-')));

    expect(firstCallArguments(locateSessionHistoryFile)).toEqual(['agent-session-1', '/work/project', null, REPORTED_PATH]);
  });

  it('as null when the agent reported none', async () => {
    const database = openMigratedDatabase();
    insertTask(database, 'task-1');
    insertSession(database, { id: 'session-1', taskId: 'task-1', agentSessionId: 'agent-session-1', cwd: '/work/project', transcriptPath: null });
    const locateSessionHistoryFile = vi.fn(async (): Promise<string | null> => null);
    harness.getAdapterBySessionType.mockReturnValue({ name: 'claude', displayName: 'Claude Code', locateSessionHistoryFile });

    await handleGetSessionHistory({ taskId: 'task-1' }, commandContext(database, makeTemporaryDirectory('kangentic-reported-history-')));

    expect(firstCallArguments(locateSessionHistoryFile)).toEqual(['agent-session-1', '/work/project', null, null]);
  });
});

describe('kangentic_get_session_files passes the row\'s transcript_path', () => {
  function seededDatabase(): Database.Database {
    const database = openMigratedDatabase();
    insertTask(database, 'task-1');
    insertSession(database, { id: 'session-1', taskId: 'task-1', agentSessionId: 'agent-session-1', cwd: '/work/project', transcriptPath: REPORTED_PATH });
    return database;
  }

  it('to locateSessionHistoryFile when the session is picked by task', async () => {
    const database = seededDatabase();
    const locateSessionHistoryFile = vi.fn(async (): Promise<string | null> => null);
    harness.getAdapterBySessionType.mockReturnValue({ name: 'claude', displayName: 'Claude Code', locateSessionHistoryFile });

    const response = await handleGetSessionFiles({ taskId: 'task-1' }, commandContext(database, makeTemporaryDirectory('kangentic-reported-files-')));

    expect(response.success).toBe(true);
    expect(firstCallArguments(locateSessionHistoryFile)).toEqual(['agent-session-1', '/work/project', null, REPORTED_PATH]);
  });

  // The by-sessionId branch of `resolveSession` (session-files-commands.ts)
  // selects `transcript_path` too: the same row, the same path.
  it('to locateSessionHistoryFile when the session is picked by its id too', async () => {
    const database = seededDatabase();
    const locateSessionHistoryFile = vi.fn(async (): Promise<string | null> => null);
    harness.getAdapterBySessionType.mockReturnValue({ name: 'claude', displayName: 'Claude Code', locateSessionHistoryFile });

    const response = await handleGetSessionFiles({ sessionId: 'session-1' }, commandContext(database, makeTemporaryDirectory('kangentic-reported-files-')));

    expect(response.success).toBe(true);
    expect(firstCallArguments(locateSessionHistoryFile)).toEqual(['agent-session-1', '/work/project', null, REPORTED_PATH]);
  });
});

describe('kangentic_get_transcript passes the row\'s transcript_path to the retrieval worker', () => {
  it('in the structured request\'s record', async () => {
    const database = openMigratedDatabase();
    insertTask(database, 'task-1');
    insertSession(database, { id: 'session-1', taskId: 'task-1', agentSessionId: 'agent-session-1', cwd: '/work/project', transcriptPath: REPORTED_PATH });
    harness.getAdapterBySessionType.mockReturnValue({ name: 'claude', displayName: 'Claude Code', parseTranscript: vi.fn() });

    const response = await handleGetTranscript({ sessionId: 'session-1' }, commandContext(database, makeTemporaryDirectory('kangentic-reported-transcript-')));

    expect(response).toEqual({ success: true, message: 'rendered' });
    expect(harness.retrievalCall).toHaveBeenCalledWith('transcript.structured', expect.objectContaining({
      request: expect.objectContaining({
        record: expect.objectContaining({ id: 'session-1', agentSessionId: 'agent-session-1', transcriptPath: REPORTED_PATH }),
      }),
    }));
  });
});

describe('renderStructuredTranscript passes the request record\'s transcriptPath to parseTranscript', () => {
  const userEntry: TranscriptEntry = { kind: 'user', uuid: 'user-1', ts: 1, text: 'a question' };

  function request(transcriptPath?: string | null): StructuredTranscriptRequest {
    return {
      record: {
        id: 'session-12345678',
        sessionType: 'claude_agent',
        agentSessionId: 'agent-session-1',
        cwd: '/work/project',
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
      },
      view: 'full',
      tail: undefined,
      charBudget: 40_000,
      search: undefined,
      aroundUuid: undefined,
      contextTurns: 3,
    };
  }

  it('as the trailing argument', async () => {
    const parseTranscript = vi.fn(async () => ({ entries: [userEntry], sourcePath: null }));
    harness.getAdapterBySessionType.mockReturnValue({ displayName: 'Claude Code', parseTranscript });

    await renderStructuredTranscript(request(REPORTED_PATH));

    expect(firstCallArguments(parseTranscript)).toEqual(['agent-session-1', '/work/project', null, REPORTED_PATH]);
  });

  it('as null when the record carries none', async () => {
    const parseTranscript = vi.fn(async () => ({ entries: [userEntry], sourcePath: null }));
    harness.getAdapterBySessionType.mockReturnValue({ displayName: 'Claude Code', parseTranscript });

    await renderStructuredTranscript(request());

    expect(firstCallArguments(parseTranscript)).toEqual(['agent-session-1', '/work/project', null, null]);
  });
});

describe('resolveSessionTranscript passes the row\'s transcript_path to parseTranscript', () => {
  const userEntry: TranscriptEntry = { kind: 'user', uuid: 'user-1', ts: 1, text: 'a question the live file holds' };

  async function resolveWith(transcriptPath: string | null): Promise<ReturnType<typeof vi.fn>> {
    const database = openMigratedDatabase();
    insertTask(database, 'task-1');
    insertSession(database, { id: 'session-1', taskId: 'task-1', agentSessionId: 'agent-session-1', cwd: '/work/project', transcriptPath });
    // A non-empty live parse, so the read ends there and never reaches the archive or the index.
    const parseTranscript = vi.fn(async () => ({ entries: [userEntry], sourcePath: null }));
    harness.getAdapterBySessionType.mockReturnValue({ displayName: 'Claude Code', parseTranscript });

    const resolved = await resolveSessionTranscript(database, 'session-1');

    expect(resolved?.source).toBe('live');
    return parseTranscript;
  }

  it('as the trailing argument', async () => {
    const parseTranscript = await resolveWith(REPORTED_PATH);

    expect(firstCallArguments(parseTranscript)).toEqual(['agent-session-1', '/work/project', null, REPORTED_PATH]);
  });

  it('as null when the agent reported none', async () => {
    const parseTranscript = await resolveWith(null);

    expect(firstCallArguments(parseTranscript)).toEqual(['agent-session-1', '/work/project', null, null]);
  });
});

// ---------------------------------------------------------------------------
// The resume-time id reconcile
// ---------------------------------------------------------------------------

describe('reconcileResumeAgentSessionId locates the reported id by the path its status file named', () => {
  const RECORD_ID = 'record-1111-2222-3333-444444444444';
  const STORED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const FORKED_ID = 'ffffffff-1111-2222-3333-444444444444';

  function reconcileWith(usage: Partial<SessionUsage>): { locateSessionHistoryFile: ReturnType<typeof vi.fn>; result: Promise<string | null>; worktree: string } {
    const projectPath = makeTemporaryDirectory('kangentic-reported-reconcile-');
    const sessionDirectory = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, 'status.json'), '{}');
    const locateSessionHistoryFile = vi.fn(async (): Promise<string | null> => '/located/transcript.jsonl');
    const adapter = {
      runtime: { statusFile: { parseStatus: () => ({ sessionId: FORKED_ID, ...usage }) as SessionUsage } },
      locateSessionHistoryFile,
    } as unknown as AgentAdapter;
    const worktree = path.join(projectPath, 'worktree');
    const result = reconcileResumeAgentSessionId({
      adapter,
      recordId: RECORD_ID,
      storedAgentSessionId: STORED_ID,
      cwd: worktree,
      projectPath,
      sessionRepo: { updateAgentSessionId: vi.fn() },
    });
    return { locateSessionHistoryFile, result, worktree };
  }

  it('passes the usage\'s transcriptPath as the fourth argument', async () => {
    const { locateSessionHistoryFile, result, worktree } = reconcileWith({ transcriptPath: REPORTED_PATH });

    await expect(result).resolves.toBe(FORKED_ID);
    expect(locateSessionHistoryFile).toHaveBeenCalledWith(FORKED_ID, worktree, null, REPORTED_PATH);
  });

  it('passes null as the fourth argument when the status file named no transcript', async () => {
    const { locateSessionHistoryFile, result, worktree } = reconcileWith({});

    await expect(result).resolves.toBe(FORKED_ID);
    expect(locateSessionHistoryFile).toHaveBeenCalledWith(FORKED_ID, worktree, null, null);
  });
});

// ---------------------------------------------------------------------------
// The command-injection verifier
// ---------------------------------------------------------------------------

describe('buildCommandInjectionVerifier hands the verifier the transcript path the agent reported', () => {
  interface VerifierCall {
    agentSessionId: string | undefined;
    transcriptPath: string | null | undefined;
  }

  const PRE_FORK_PATH = '/reported/first/pre-fork-id.jsonl';
  const POST_FORK_PATH = '/reported/second/post-fork-id.jsonl';

  function harnessWith(options: {
    captured: { agentSessionId: string; transcriptPath: string | null };
    current: { agentSessionId: string; transcriptPath: string | null } | undefined;
    verifyResult: (call: VerifierCall) => boolean;
  }) {
    const calls: VerifierCall[] = [];
    const submissionVerifier = vi.fn(async (verifierContext: VerifierCall) => {
      const call = { agentSessionId: verifierContext.agentSessionId, transcriptPath: verifierContext.transcriptPath };
      calls.push(call);
      return options.verifyResult(call);
    });
    const adapter = { getSubmissionVerifier: () => submissionVerifier } as unknown as AgentAdapter;
    const recordFor = (state: { agentSessionId: string; transcriptPath: string | null }): SessionRecord => ({
      id: 'record-1',
      agent_session_id: state.agentSessionId,
      cwd: '/worktree',
      cli_target: null,
      transcript_path: state.transcriptPath,
    }) as SessionRecord;
    const sessionRepo = {
      getLatestForTask: () => undefined,
      findByAnyId: () => (options.current ? recordFor(options.current) : undefined),
    } as unknown as SessionRepository;
    const verifier = buildCommandInjectionVerifier(adapter, sessionRepo, 'task-1', recordFor(options.captured));
    if (!verifier) throw new Error('The adapter declares a verifier, so one is built.');
    return { verifier, calls };
  }

  it('sends the live record\'s path on the first call, and the captured record\'s on the fallback call', async () => {
    const { verifier, calls } = harnessWith({
      captured: { agentSessionId: 'pre-fork-id', transcriptPath: PRE_FORK_PATH },
      current: { agentSessionId: 'post-fork-id', transcriptPath: POST_FORK_PATH },
      // Neither call confirms, so the fallback call under the plan-time id runs.
      verifyResult: () => false,
    });

    await verifier('/effort high', 123, 'command-match');

    expect(calls).toEqual([
      { agentSessionId: 'post-fork-id', transcriptPath: POST_FORK_PATH },
      { agentSessionId: 'pre-fork-id', transcriptPath: PRE_FORK_PATH },
    ]);
  });

  it('sends a path the agent reported after the plan was built', async () => {
    const { verifier, calls } = harnessWith({
      captured: { agentSessionId: 'same-id', transcriptPath: null },
      current: { agentSessionId: 'same-id', transcriptPath: POST_FORK_PATH },
      verifyResult: () => true,
    });

    await verifier('/effort high', 123, 'command-match');

    expect(calls).toEqual([{ agentSessionId: 'same-id', transcriptPath: POST_FORK_PATH }]);
  });

  // With no live record the verifier degrades to the captured id and cwd
  // (injection-plan.test.ts pins that), and the captured path goes with them.
  it('degrades to the captured path along with the captured id when the live record cannot be re-read', async () => {
    const { verifier, calls } = harnessWith({
      captured: { agentSessionId: 'pre-fork-id', transcriptPath: PRE_FORK_PATH },
      current: undefined,
      verifyResult: () => true,
    });

    await verifier('/effort high', 123, 'command-match');

    expect(calls).toEqual([{ agentSessionId: 'pre-fork-id', transcriptPath: PRE_FORK_PATH }]);
  });
});
