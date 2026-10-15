/**
 * The retrieval worker's archive methods (`worker/archive-methods.ts`):
 * `archive.session` archives the conversation one session ran and reports the
 * outcome, and `archive.sweep` is the project-open pass. A sweep that carries a
 * `jobId` runs through `runJob`, so `job.cancel` with that id stops it between
 * conversations (a project switch). Both are registered in `retrievalHandlers`,
 * which is what the worker dispatches to.
 *
 * Real pieces throughout: Claude-format JSONL on disk, the real window parser,
 * Brotli and a migrated better-sqlite3 database. Only the agent registry is
 * mocked, so the archive finds its files in a temp folder instead of under the
 * home folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), list: vi.fn(() => []), get: vi.fn() },
}));

import { agentRegistry } from '../../src/main/agent/agent-registry';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { archiveHandlers } from '../../src/main/retrieval/worker/archive-methods';
import { indexHandlers } from '../../src/main/retrieval/worker/index-methods';
import { retrievalHandlers, type WorkerContext } from '../../src/main/retrieval/worker/methods';
import {
  readArchivedConversation,
  resetArchiveReadCacheForTests,
  type ArchiveAdapter,
} from '../../src/main/retrieval/archive/transcript-archive';
import { parseClaudeTranscript, parseClaudeTranscriptWindow } from '../../src/main/agent/adapters/claude/transcript-parser';
import { openTestDatabase } from './helpers/test-database';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

const ALL = Number.MAX_SAFE_INTEGER;
const PROJECT_ID = 'project-1';
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseType.Database[] = [];

beforeEach(() => {
  resetArchiveReadCacheForTests();
  vi.mocked(agentRegistry.list).mockReturnValue([]);
});

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** Claude-format lines: a user line and an assistant text line per turn. */
function transcriptLines(turns: number, label: string): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const timestamp = new Date(Date.UTC(2026, 8, 30, 12, 0, turn)).toISOString();
    lines.push(JSON.stringify({
      type: 'user', uuid: `${label}-user-${turn}`, timestamp,
      message: { role: 'user', content: `${label} question ${turn}` },
    }));
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `${label}-assistant-${turn}`, timestamp,
      message: {
        id: `${label}-message-${turn}`, model: 'claude-test',
        content: [{ type: 'text', text: `${label} answer ${turn}` }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
      },
    }));
  }
  return lines;
}

interface Fixture {
  database: DatabaseType.Database;
  context: WorkerContext;
  directory: string;
  pathFor(agentSessionId: string): string;
  /** Agent session ids in the order the parser was asked for their windows. */
  walked: string[];
  /** Runs inside the parser's first window, i.e. while the first conversation is being archived. */
  onFirstWindow: { current: (() => void) | null };
}

/**
 * A migrated project database holding one session row per conversation, a
 * worker context over it, and a registry whose adapter reads
 * `<directory>/<agentSessionId>.jsonl`.
 */
function fixture(conversations: string[]): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-archive-methods-'));
  temporaryDirectories.push(directory);
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  database.exec('PRAGMA foreign_keys = OFF');
  conversations.forEach((agentSessionId, index) => {
    database.prepare(
      `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
       VALUES (?, 'task-1', 'claude_agent', ?, 'claude', '/work', 'suspended', ?)`,
    ).run(`session-${agentSessionId}`, agentSessionId, `2026-09-30T12:0${index}:00.000Z`);
  });

  const walked: string[] = [];
  const onFirstWindow: Fixture['onFirstWindow'] = { current: null };
  const pathFor = (agentSessionId: string) => path.join(directory, `${agentSessionId}.jsonl`);
  const adapter: ArchiveAdapter = {
    locateSessionHistoryFile: async (agentSessionId) => (fs.existsSync(pathFor(agentSessionId)) ? pathFor(agentSessionId) : null),
    parseTranscriptWindow: async (agentSessionId, _cwd, startByte, maxBytes, carry) => {
      if (walked.length === 0) onFirstWindow.current?.();
      if (walked[walked.length - 1] !== agentSessionId) walked.push(agentSessionId);
      const window = await parseClaudeTranscriptWindow(pathFor(agentSessionId), startByte, maxBytes, carry);
      return { ...window, sourcePath: pathFor(agentSessionId) };
    },
  };
  vi.mocked(agentRegistry.getBySessionType).mockReturnValue(adapter as unknown as AgentAdapter);

  // A fresh context per call site: the worker keeps one archive per context.
  const context: WorkerContext = {
    getDb: () => database,
    closeDb: () => undefined,
    vecLoadError: () => null,
    emit: () => undefined,
  };
  return { database, context, directory, pathFor, walked, onFirstWindow };
}

function writeConversation(filePath: string, label: string, mtime: string): void {
  fs.writeFileSync(filePath, `${transcriptLines(3, label).join('\n')}\n`);
  fs.utimesSync(filePath, new Date(mtime), new Date(mtime));
}

async function archivedUuids(database: DatabaseType.Database, agentSessionId: string): Promise<string[] | null> {
  const archived = await readArchivedConversation(database, agentSessionId, ALL);
  return archived ? archived.entries.map((entry) => entry.uuid) : null;
}

describe('archive.session', () => {
  it('archives the conversation the session ran and reports the outcome', async () => {
    const { database, context, pathFor } = fixture(['agent-session']);
    writeConversation(pathFor('agent-session'), 'alpha', '2026-09-01T00:00:00Z');

    const result = await archiveHandlers['archive.session']({ projectId: PROJECT_ID, sessionId: 'session-agent-session', remoteTargets: [] }, context);

    expect(result).toEqual({ outcome: 'archived' });
    const whole = await parseClaudeTranscript(pathFor('agent-session'));
    expect(await archivedUuids(database, 'agent-session')).toEqual(whole.map((entry) => entry.uuid));
  });

  it('reports unchanged for a file it has already walked, and skipped for an id no session names', async () => {
    const { context, pathFor } = fixture(['agent-session']);
    writeConversation(pathFor('agent-session'), 'alpha', '2026-09-01T00:00:00Z');
    const params = { projectId: PROJECT_ID, sessionId: 'session-agent-session', remoteTargets: [] };

    expect(await archiveHandlers['archive.session'](params, context)).toEqual({ outcome: 'archived' });
    expect(await archiveHandlers['archive.session'](params, context)).toEqual({ outcome: 'unchanged' });
    expect(await archiveHandlers['archive.session']({ ...params, sessionId: 'no-such-session' }, context)).toEqual({ outcome: 'skipped' });
  });

  it('reports a missing source when the agent\'s file is not there to read', async () => {
    const { database, context } = fixture(['agent-session']);

    const result = await archiveHandlers['archive.session']({ projectId: PROJECT_ID, sessionId: 'session-agent-session', remoteTargets: [] }, context);

    expect(result).toEqual({ outcome: 'missing-source' });
    expect(await archivedUuids(database, 'agent-session')).toBeNull();
  });

  it('hands the remote targets main sent to the worker\'s adapters before it reads', async () => {
    const { context, pathFor } = fixture(['agent-session']);
    writeConversation(pathFor('agent-session'), 'alpha', '2026-09-01T00:00:00Z');
    const adoptTargets = vi.fn();
    vi.mocked(agentRegistry.list).mockReturnValue(['remote-capable']);
    vi.mocked(agentRegistry.get).mockReturnValue({ remoteExecution: { adoptTargets } } as unknown as AgentAdapter);
    const remoteTargets = [{ adapter: 'remote-capable', targets: [['server-1', { host: 'build.example.test' }]] }];

    await archiveHandlers['archive.session']({
      projectId: PROJECT_ID, sessionId: 'session-agent-session', remoteTargets: remoteTargets as never,
    }, context);

    expect(adoptTargets).toHaveBeenCalledWith(remoteTargets[0].targets);
  });
});

describe('archive.sweep', () => {
  const CONVERSATIONS = ['agent-oldest', 'agent-middle', 'agent-newest'];

  function seedFiles(fixtureValue: Fixture): void {
    // File times decide the order: the sweep archives the oldest file first.
    writeConversation(fixtureValue.pathFor('agent-oldest'), 'oldest', '2026-08-01T00:00:00Z');
    writeConversation(fixtureValue.pathFor('agent-middle'), 'middle', '2026-09-01T00:00:00Z');
    writeConversation(fixtureValue.pathFor('agent-newest'), 'newest', '2026-10-01T00:00:00Z');
  }

  it('archives every conversation behind when nothing cancels it, with and without a job id', async () => {
    const withJob = fixture(CONVERSATIONS);
    seedFiles(withJob);
    const result = await archiveHandlers['archive.sweep']({ projectId: PROJECT_ID, jobId: 'sweep-uncancelled', remoteTargets: [] }, withJob.context);
    expect(result).toEqual({ archived: 3, purged: 0 });
    expect(withJob.walked).toEqual(['agent-oldest', 'agent-middle', 'agent-newest']);
    for (const agentSessionId of CONVERSATIONS) {
      expect((await archivedUuids(withJob.database, agentSessionId))?.length).toBe(6);
    }

    const withoutJob = fixture(CONVERSATIONS);
    seedFiles(withoutJob);
    expect(await archiveHandlers['archive.sweep']({ projectId: PROJECT_ID, remoteTargets: [] }, withoutJob.context)).toEqual({ archived: 3, purged: 0 });
  });

  it('stops between conversations when job.cancel names its job id', async () => {
    const swept = fixture(CONVERSATIONS);
    seedFiles(swept);
    const jobId = 'sweep-cancelled-after-first';
    // Cancelled from inside the first conversation's walk: the job is running
    // by then, so the cancel is recorded and the next check between
    // conversations sees it.
    swept.onFirstWindow.current = () => {
      swept.onFirstWindow.current = null;
      indexHandlers['job.cancel']({ jobId }, swept.context);
    };

    const result = await archiveHandlers['archive.sweep']({ projectId: PROJECT_ID, jobId, remoteTargets: [] }, swept.context);

    expect(result).toEqual({ archived: 1, purged: 0 });
    expect(swept.walked).toEqual(['agent-oldest']);
    expect((await archivedUuids(swept.database, 'agent-oldest'))?.length).toBe(6);
    expect(await archivedUuids(swept.database, 'agent-middle')).toBeNull();
    expect(await archivedUuids(swept.database, 'agent-newest')).toBeNull();
  });

  it('is not stopped by a cancel for a different job id', async () => {
    const swept = fixture(CONVERSATIONS);
    seedFiles(swept);
    swept.onFirstWindow.current = () => {
      swept.onFirstWindow.current = null;
      indexHandlers['job.cancel']({ jobId: 'some-other-job' }, swept.context);
    };

    const result = await archiveHandlers['archive.sweep']({ projectId: PROJECT_ID, jobId: 'sweep-not-cancelled', remoteTargets: [] }, swept.context);

    expect(result).toEqual({ archived: 3, purged: 0 });
  });

  it('purges the archive of a conversation no session names any more', async () => {
    const swept = fixture(CONVERSATIONS);
    seedFiles(swept);
    await archiveHandlers['archive.sweep']({ projectId: PROJECT_ID, remoteTargets: [] }, swept.context);
    swept.database.prepare("DELETE FROM sessions WHERE agent_session_id = 'agent-middle'").run();

    const result = await archiveHandlers['archive.sweep']({ projectId: PROJECT_ID, remoteTargets: [] }, swept.context);

    expect(result.purged).toBe(1);
    expect(await archivedUuids(swept.database, 'agent-middle')).toBeNull();
    expect(await archivedUuids(swept.database, 'agent-oldest')).not.toBeNull();
  });

  it('hands the remote targets main sent to the worker\'s adapters', async () => {
    const swept = fixture(CONVERSATIONS);
    seedFiles(swept);
    const adoptTargets = vi.fn();
    vi.mocked(agentRegistry.list).mockReturnValue(['remote-capable']);
    vi.mocked(agentRegistry.get).mockReturnValue({ remoteExecution: { adoptTargets } } as unknown as AgentAdapter);
    const remoteTargets = [{ adapter: 'remote-capable', targets: [['server-1', { host: 'build.example.test' }]] }];

    await archiveHandlers['archive.sweep']({ projectId: PROJECT_ID, remoteTargets: remoteTargets as never }, swept.context);

    expect(adoptTargets).toHaveBeenCalledWith(remoteTargets[0].targets);
  });
});

describe('registration', () => {
  it('registers both archive methods in the worker\'s dispatch table', () => {
    expect(retrievalHandlers['archive.session']).toBe(archiveHandlers['archive.session']);
    expect(retrievalHandlers['archive.sweep']).toBe(archiveHandlers['archive.sweep']);
    expect(typeof retrievalHandlers['archive.session']).toBe('function');
    expect(typeof retrievalHandlers['archive.sweep']).toBe('function');
  });
});
