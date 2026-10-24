/**
 * The record of the conversations Command Terminals held, which the panel's
 * Earlier list resumes from (src/main/ipc/helpers/command-terminal-history.ts),
 * run against a real migrated project database.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import type { Session } from '../../src/shared/types';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import {
  COMMAND_TERMINAL_HISTORY_LIMIT,
  CommandTerminalHistoryRepository,
} from '../../src/main/db/repositories/command-terminal-history-repository';
import { CommandTerminalHistory } from '../../src/main/ipc/helpers/command-terminal-history';
import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const openDatabases: DatabaseType.Database[] = [];
const histories: CommandTerminalHistory[] = [];

afterEach(() => {
  for (const history of histories.splice(0)) history.dispose();
  for (const database of openDatabases.splice(0)) database.close();
});

class FakeSessions extends EventEmitter {
  readonly sessions = new Map<string, Session>();

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionAgentName(): string {
    return 'claude';
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  /** A live Command Terminal, or a task agent with `transient: false`. */
  add(sessionId: string, overrides: Partial<Session> = {}): Session {
    const session = {
      id: sessionId,
      taskId: `task-${sessionId}`,
      projectId: PROJECT_ID,
      pid: 1,
      status: 'running',
      shell: 'pwsh',
      cwd: '/projects/demo',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: true,
      agentSessionId: null,
      ...overrides,
    } as Session;
    this.sessions.set(sessionId, session);
    return session;
  }

  /** What `onAgentSessionId` does: set the id, announce it. */
  reportAgentId(sessionId: string, agentSessionId: string): void {
    const session = this.sessions.get(sessionId)!;
    session.agentSessionId = agentSessionId;
    this.emit('agent-session-id', sessionId, session.taskId, session.projectId, agentSessionId);
  }

  change(sessionId: string, patch: Partial<Session>): void {
    const session = this.sessions.get(sessionId)!;
    Object.assign(session, patch);
    this.emit('session-changed', sessionId, { ...session });
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId)!;
    this.emit('session-removed', sessionId, { ...session });
    this.sessions.delete(sessionId);
  }
}

function setup(options: { available?: (agentSessionId: string) => boolean } = {}) {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const repository = new CommandTerminalHistoryRepository(database);
  const sessions = new FakeSessions();
  const notifyChanged = vi.fn();
  const history = new CommandTerminalHistory({
    sessionManager: sessions,
    getRepository: () => repository,
    conversationAvailable: async (_agent, agentSessionId) => options.available?.(agentSessionId) ?? true,
    notifyChanged,
  });
  history.start();
  histories.push(history);
  return { database, repository, sessions, history, notifyChanged };
}

describe('CommandTerminalHistory', () => {
  it('lists a used terminal once it ends, with its name and when it ended', async () => {
    const { sessions, history, notifyChanged } = setup();
    sessions.add('pty-1');
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.change('pty-1', { hasUserInput: true });
    sessions.change('pty-1', { commandTerminalLabel: 'Fix the flaky drag test' });

    // Still open: Earlier lists only ended conversations.
    expect(await history.list(PROJECT_ID)).toEqual([]);

    sessions.remove('pty-1');
    const entries = await history.list(PROJECT_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agentSessionId: 'conversation-a',
      label: 'Fix the flaky drag test',
      agentName: 'claude',
    });
    expect(Number.isNaN(Date.parse(entries[0].endedAt))).toBe(false);
    expect(notifyChanged).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('keeps nothing for a terminal nobody used', async () => {
    const { sessions, history, repository } = setup();
    sessions.add('pty-1');
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.remove('pty-1');
    expect(repository.get('conversation-a')).toBeNull();
    expect(await history.list(PROJECT_ID)).toEqual([]);
  });

  it('records a terminal used before its agent reported an id', async () => {
    const { sessions, history } = setup();
    sessions.add('pty-1', { hasUserInput: true, commandTerminalLabel: 'Early name' });
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.remove('pty-1');
    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-a', label: 'Early name' }]);
  });

  it('ends the earlier conversation when the agent moves the terminal to a new one', async () => {
    const { sessions, history, repository } = setup();
    sessions.add('pty-1', { hasUserInput: true });
    sessions.reportAgentId('pty-1', 'conversation-a');
    // A `/clear` inside the terminal: a new conversation under a new id.
    sessions.reportAgentId('pty-1', 'conversation-b');

    expect(repository.get('conversation-a')?.ended_at).not.toBeNull();
    // The earlier one is listed while the terminal goes on with the new one.
    expect((await history.list(PROJECT_ID)).map((entry) => entry.agentSessionId)).toEqual(['conversation-a']);
  });

  it("never records a board task's or a workflow's conversation", async () => {
    const { database, sessions, repository } = setup();
    database.prepare(
      "INSERT INTO workflows (id, title, created_at, agent_session_id) VALUES ('workflow-1', 'Plan', ?, 'owned-conversation')",
    ).run(new Date().toISOString());
    sessions.add('pty-1', { hasUserInput: true });
    sessions.reportAgentId('pty-1', 'owned-conversation');
    expect(repository.get('owned-conversation')).toBeNull();
  });

  it('ignores a task agent and a workflow agent', () => {
    const { sessions, repository } = setup();
    sessions.add('task-pty', { transient: false, hasUserInput: true });
    sessions.reportAgentId('task-pty', 'task-conversation');
    sessions.add('workflow-pty', { workflowId: 'workflow-1', hasUserInput: true });
    sessions.reportAgentId('workflow-pty', 'workflow-conversation');
    expect(repository.get('task-conversation')).toBeNull();
    expect(repository.get('workflow-conversation')).toBeNull();
  });

  it('drops a conversation whose transcript is gone', async () => {
    const { sessions, history, repository } = setup({ available: (agentSessionId) => agentSessionId !== 'purged' });
    for (const [sessionId, agentSessionId] of [['pty-1', 'purged'], ['pty-2', 'kept']] as const) {
      sessions.add(sessionId, { hasUserInput: true });
      sessions.reportAgentId(sessionId, agentSessionId);
      sessions.remove(sessionId);
    }
    expect((await history.list(PROJECT_ID)).map((entry) => entry.agentSessionId)).toEqual(['kept']);
    expect(repository.get('purged')).toBeNull();
  });

  it('lists a conversation a quit left open, stamped with when it was last seen', async () => {
    const { repository, history } = setup();
    // A quit removes no row, so the record has no end and no live terminal.
    repository.recordConversation({ agentSessionId: 'open-at-quit', agentName: 'claude', cwd: '/projects/demo', label: null, touched: true });
    const lastSeen = repository.get('open-at-quit')!.updated_at;

    const entries = await history.list(PROJECT_ID);
    expect(entries).toMatchObject([{ agentSessionId: 'open-at-quit', endedAt: lastSeen }]);
    expect(repository.get('open-at-quit')?.ended_at).toBe(lastSeen);
  });

  it('keeps the newest ended conversations and never prunes one still open', () => {
    const { repository } = setup();
    repository.recordConversation({ agentSessionId: 'still-open', agentName: 'claude', cwd: '/projects/demo', label: null, touched: false });
    for (let index = 0; index < COMMAND_TERMINAL_HISTORY_LIMIT + 5; index += 1) {
      const agentSessionId = `ended-${index}`;
      repository.recordConversation({ agentSessionId, agentName: 'claude', cwd: '/projects/demo', label: null, touched: true });
      repository.markEnded(agentSessionId, new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString());
    }
    expect(repository.get('still-open')).not.toBeNull();
    expect(repository.get('ended-0')).toBeNull();
    expect(repository.get(`ended-${COMMAND_TERMINAL_HISTORY_LIMIT + 4}`)).not.toBeNull();
    expect(repository.listUsed()).toHaveLength(COMMAND_TERMINAL_HISTORY_LIMIT);
  });
});
