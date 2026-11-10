/**
 * `markResumeMiss`: a resume the CLI says found no conversation, whose lineage
 * never had a turn, is marked, so the next start replays the fresh launch's prompt.
 * This is what heals a launch 0.54.0 paused with no mark (Sentry DESKTOP-2E): such a
 * task resumed the same missing id on every restart, with its prompt undelivered.
 *
 * Runs the real repository over a real migrated database, the real task lock, and
 * the real lineage reads. What fails if the turns check goes is the worst thing here:
 * a mark on a conversation that ran replays a finished prompt into it. A moved project
 * prints the very same line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDatabase = vi.hoisted(() => ({ current: null as unknown }));
const adapter = vi.hoisted(() => ({ value: { runtime: {} } as unknown }));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: () => projectDatabase.current }));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: (name: string) => (name === 'claude' ? adapter.value : undefined) },
}));

import { runProjectMigrations } from '../../src/main/db/migrations';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { markResumeMiss } from '../../src/main/ipc/helpers/resume-miss';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { assessResumeConversation, owedPromptOf, resolveResumeLineage } from '../../src/main/transition-engine/resume-conversation-guard';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

const TASK_ID = 'task-1';
const AGENT_SESSION_ID = 'agent-1';
const PROJECT_ID = 'project-1';

const BASE_ROW = {
  task_id: TASK_ID, session_type: 'claude', isolated_swimlane_id: null,
  agent_session_id: AGENT_SESSION_ID, command: 'claude', cwd: '/mock/project', permission_mode: null, prompt: null,
  status: 'suspended' as const, exit_code: null, suspended_at: null, exited_at: null, suspended_by: null,
};

let database: Database.Database;
let repository: SessionRepository;
let projectPath: string;

function fakeContext(outputClass: string | undefined, overrides: { agentName?: string | null; projectPath?: string | null } = {}): IpcContext {
  const contextProjectPath = overrides.projectPath === undefined ? projectPath : overrides.projectPath;
  return {
    sessionManager: {
      launchOutputClass: vi.fn(async () => outputClass),
      getSessionAgentName: vi.fn(() => (overrides.agentName === undefined ? 'claude' : overrides.agentName)),
    },
    projectRepo: { getById: vi.fn(() => (contextProjectPath ? { path: contextProjectPath } : undefined)) },
  } as unknown as IpcContext;
}

function failedAt(id: string): string | null {
  return repository.listForTaskNewestFirst(TASK_ID).find((record) => record.id === id)?.launch_failed_at ?? null;
}

async function mark(context: IpcContext, sessionId = 'resume-1'): Promise<void> {
  await markResumeMiss(context, { sessionId, taskId: TASK_ID, projectId: PROJECT_ID });
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resume-miss-'));
  database = new Database(':memory:');
  runProjectMigrations(database);
  database.prepare(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'Executing', 0, '2026-01-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-1', 1, 'Task', '', 'lane-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  projectDatabase.current = database;
  repository = new SessionRepository(database);
  // A launch 0.54.0 paused unmarked, with the task's prompt, and the resume a restart tried.
  repository.insert({ ...BASE_ROW, id: 'fresh', prompt: 'Fix the login redirect', started_at: '2026-01-01T00:00:00.000Z' });
  repository.insert({ ...BASE_ROW, id: 'resume-1', started_at: '2026-01-01T00:00:05.000Z' });
});

afterEach(() => {
  database.close();
  fs.rmSync(projectPath, { recursive: true, force: true });
});

describe('markResumeMiss', () => {
  it('marks a resume the CLI says found nothing when the lineage has no turns', async () => {
    await mark(fakeContext('conversation_missing'));

    expect(failedAt('resume-1')).not.toBeNull();
    // The launch it resumed keeps its row as it was.
    expect(failedAt('fresh')).toBeNull();
  });

  it('sends the next start fresh with the fresh launch\'s prompt, needing no mark on that launch', async () => {
    await mark(fakeContext('conversation_missing'));

    const { lineage } = resolveResumeLineage({
      taskRecords: repository.listForTaskNewestFirst(TASK_ID),
      retiringRecordId: 'resume-1',
      resumedAgentSessionId: AGENT_SESSION_ID,
    });
    const verdict = await assessResumeConversation({
      adapter: adapter.value as AgentAdapter,
      agentSessionId: AGENT_SESSION_ID,
      records: lineage,
      cwd: projectPath,
      projectPath,
    });
    expect(verdict).toBe('never-started');
    expect(owedPromptOf(lineage)).toBe('Fix the login redirect');
  });

  it('never marks a lineage with turns: a moved project prints the same line', async () => {
    repository.insert({ ...BASE_ROW, id: 'ran', started_at: '2026-01-01T00:00:01.000Z' });
    database.prepare('UPDATE sessions SET total_output_tokens = 40 WHERE id = ?').run('ran');

    await mark(fakeContext('conversation_missing'));

    expect(failedAt('resume-1')).toBeNull();
  });

  it('awaits the output read itself, since a retry is refused ahead of it', async () => {
    let answer: (outputClass: string) => void = () => undefined;
    const pendingRead = new Promise<string>((resolve) => { answer = resolve; });
    const context = fakeContext(undefined);
    vi.mocked(context.sessionManager.launchOutputClass).mockReturnValue(pendingRead as never);

    const marking = mark(context);
    expect(failedAt('resume-1')).toBeNull();
    answer('conversation_missing');
    await marking;

    expect(failedAt('resume-1')).not.toBeNull();
  });

  it.each(['other', 'not_read', 'login_required', 'line_too_long'])('marks nothing for %s', async (outputClass) => {
    await mark(fakeContext(outputClass));

    expect(failedAt('resume-1')).toBeNull();
  });

  it('marks nothing when the report read nothing', async () => {
    await mark(fakeContext(undefined));

    expect(failedAt('resume-1')).toBeNull();
  });

  it('leaves a newer record to judge itself: a person started the task in the gap', async () => {
    repository.insert({ ...BASE_ROW, id: 'resume-2', started_at: '2026-01-01T00:00:09.000Z' });

    await mark(fakeContext('conversation_missing'));

    expect(failedAt('resume-1')).toBeNull();
    expect(failedAt('resume-2')).toBeNull();
  });

  it('reads any doubt as turns, so the record resumes as before', async () => {
    await mark(fakeContext('conversation_missing', { agentName: null }));
    await mark(fakeContext('conversation_missing', { projectPath: null }));

    expect(failedAt('resume-1')).toBeNull();
  });

  it('refuses an unknown agent in the guard itself, not in the catch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mark(fakeContext('conversation_missing', { agentName: null }));

    expect(failedAt('resume-1')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves a latest record with no agent session id unmarked', async () => {
    database.prepare('UPDATE sessions SET agent_session_id = NULL WHERE id = ?').run('resume-1');

    await mark(fakeContext('conversation_missing'));

    expect(failedAt('resume-1')).toBeNull();
  });

  it('never throws: a failed read must not cost the listener its retry', async () => {
    const context = fakeContext(undefined);
    vi.mocked(context.sessionManager.launchOutputClass).mockRejectedValue(new Error('host gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(markResumeMiss(context, { sessionId: 'resume-1', taskId: TASK_ID, projectId: PROJECT_ID })).resolves.toBe('not_a_miss');

    warn.mockRestore();
  });
});

/**
 * What `markResumeMiss` answers decides the listener's retry: an unmarked miss
 * would rerun the same `--resume` and get the same answer (DESKTOP-2M).
 */
describe('markResumeMiss outcome', () => {
  async function outcomeOf(context: IpcContext, sessionId = 'resume-1'): Promise<string> {
    return markResumeMiss(context, { sessionId, taskId: TASK_ID, projectId: PROJECT_ID });
  }

  it('answers marked when it marked the record', async () => {
    await expect(outcomeOf(fakeContext('conversation_missing'))).resolves.toBe('marked');
  });

  it('answers left_unmarked for a lineage with turns', async () => {
    repository.insert({ ...BASE_ROW, id: 'ran', started_at: '2026-01-01T00:00:01.000Z' });
    database.prepare('UPDATE sessions SET total_output_tokens = 40 WHERE id = ?').run('ran');

    await expect(outcomeOf(fakeContext('conversation_missing'))).resolves.toBe('left_unmarked');
  });

  it.each([
    ['no adapter', { agentName: null }],
    ['no project path', { projectPath: null }],
  ])('answers left_unmarked for doubt: %s', async (_label, overrides) => {
    await expect(outcomeOf(fakeContext('conversation_missing', overrides))).resolves.toBe('left_unmarked');
  });

  it('answers left_unmarked for a latest record with no agent session id', async () => {
    database.prepare('UPDATE sessions SET agent_session_id = NULL WHERE id = ?').run('resume-1');

    await expect(outcomeOf(fakeContext('conversation_missing'))).resolves.toBe('left_unmarked');
  });

  it.each(['other', 'login_required', 'line_too_long'])('answers not_a_miss for %s', async (outputClass) => {
    await expect(outcomeOf(fakeContext(outputClass))).resolves.toBe('not_a_miss');
  });

  it.each([
    ['no adapter', { agentName: null }],
    ['no project path', { projectPath: null }],
  ])('answers not_a_miss, not left_unmarked, for a newer record even with doubt: %s', async (_label, overrides) => {
    repository.insert({ ...BASE_ROW, id: 'resume-2', started_at: '2026-01-01T00:00:09.000Z' });

    await expect(outcomeOf(fakeContext('conversation_missing', overrides))).resolves.toBe('not_a_miss');
  });

  it('answers not_a_miss when a newer record judges itself', async () => {
    repository.insert({ ...BASE_ROW, id: 'resume-2', started_at: '2026-01-01T00:00:09.000Z' });

    await expect(outcomeOf(fakeContext('conversation_missing'))).resolves.toBe('not_a_miss');
  });
});
