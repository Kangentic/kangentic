/**
 * The record of the conversations Command Terminals held, which the panel's
 * Earlier list resumes from (src/main/ipc/helpers/command-terminal-history.ts),
 * run against a real migrated project database.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { EventType, PromptReason, type Session } from '../../src/shared/types';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CommandTerminalHistoryRepository } from '../../src/main/db/repositories/command-terminal-history-repository';
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

  /** A Prompt event with its text, as a Command Terminal's hook reports one. */
  prompt(sessionId: string, text: string): void {
    this.emit('event', sessionId, { ts: Date.now(), type: EventType.Prompt, detail: text });
  }
}

function setup(options: { available?: (agentSessionId: string) => boolean } = {}) {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const repository = new CommandTerminalHistoryRepository(database);
  const sessions = new FakeSessions();
  const notifyChanged = vi.fn();
  const conversationEnded = vi.fn();
  const history = new CommandTerminalHistory({
    sessionManager: sessions,
    getRepository: () => repository,
    conversationAvailable: async (_agent, agentSessionId) => options.available?.(agentSessionId) ?? true,
    notifyChanged,
    conversationEnded,
    searchText: async () => ({ indexingOff: false, hits: [] }),
  });
  history.start();
  histories.push(history);
  return { database, repository, sessions, history, notifyChanged, conversationEnded };
}

describe('command_terminal_history migration', () => {
  it('adds first_prompt to a table an earlier build created without it, and runs again cleanly', () => {
    const database = openTestDatabase();
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE command_terminal_history (
        agent_session_id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, label TEXT, cwd TEXT NOT NULL,
        started_at TEXT NOT NULL, touched_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL
      )
    `);
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO command_terminal_history VALUES ('conversation-old', 'claude', NULL, '/projects/demo', ?, ?, ?, ?)",
    ).run(now, now, now, now);
    runProjectMigrations(database);
    runProjectMigrations(database);
    const repository = new CommandTerminalHistoryRepository(database);
    expect(repository.get('conversation-old')).toMatchObject({ agent_session_id: 'conversation-old', first_prompt: null });
    repository.setFirstPrompt('conversation-old', 'hello');
    expect(repository.get('conversation-old')?.first_prompt).toBe('hello');
  });

  it('adds named_by_user at 0 to existing rows and drops the prune index, and runs again cleanly', () => {
    const database = openTestDatabase();
    openDatabases.push(database);
    runProjectMigrations(database);
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO command_terminal_history (agent_session_id, agent_name, label, cwd, started_at, touched_at, ended_at, updated_at)
      VALUES ('conversation-old', 'claude', 'Named by the namer', '/projects/demo', ?, ?, ?, ?)
    `).run(now, now, now, now);
    database.exec('ALTER TABLE command_terminal_history DROP COLUMN named_by_user');
    database.exec('CREATE INDEX idx_command_terminal_history_ended ON command_terminal_history(ended_at)');

    runProjectMigrations(database);
    runProjectMigrations(database);

    expect(new CommandTerminalHistoryRepository(database).get('conversation-old')).toMatchObject({ label: 'Named by the namer', named_by_user: 0 });
    const index = database.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_command_terminal_history_ended'").get();
    expect(index).toBeUndefined();
  });
});

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

  it('keeps the first prompt, on one line, for a conversation nothing named', async () => {
    const { sessions, history } = setup();
    sessions.add('pty-1', { hasUserInput: true });
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.prompt('pty-1', '  why does the\n  sidebar count lag?  ');
    // A later prompt never replaces it.
    sessions.prompt('pty-1', 'and the board?');
    sessions.remove('pty-1');
    expect(await history.list(PROJECT_ID)).toMatchObject([
      { agentSessionId: 'conversation-a', label: null, firstPrompt: 'why does the sidebar count lag?' },
    ]);
  });

  it('keeps a first prompt that arrived before the agent reported its id', async () => {
    const { sessions, history } = setup();
    sessions.add('pty-1', { hasUserInput: true });
    sessions.prompt('pty-1', 'hello');
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.remove('pty-1');
    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-a', firstPrompt: 'hello' }]);
  });

  it("skips the activity engine's synthetic prompt and an empty one", async () => {
    const { sessions, history } = setup();
    sessions.add('pty-1', { hasUserInput: true });
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.prompt('pty-1', PromptReason.PtyActivity);
    sessions.prompt('pty-1', '   ');
    sessions.prompt('pty-1', 'the real question');
    sessions.remove('pty-1');
    expect(await history.list(PROJECT_ID)).toMatchObject([{ firstPrompt: 'the real question' }]);
  });

  it('gives each conversation of a terminal its own first prompt, and a resume keeps the original', async () => {
    const { sessions, history, repository } = setup();
    sessions.add('pty-1', { hasUserInput: true });
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.prompt('pty-1', 'first question');
    // A `/clear`: the new conversation's first prompt is its own.
    sessions.reportAgentId('pty-1', 'conversation-b');
    sessions.prompt('pty-1', 'second question');
    sessions.remove('pty-1');
    expect(repository.get('conversation-a')?.first_prompt).toBe('first question');
    expect(repository.get('conversation-b')?.first_prompt).toBe('second question');

    // A resumed terminal reports conversation-a again and is asked something new.
    sessions.add('pty-2', { hasUserInput: true });
    sessions.reportAgentId('pty-2', 'conversation-a');
    sessions.prompt('pty-2', 'picking this back up');
    sessions.remove('pty-2');
    const entries = await history.list(PROJECT_ID);
    expect(entries.find((entry) => entry.agentSessionId === 'conversation-a')?.firstPrompt).toBe('first question');
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

  it('follows a rename and a clear, so Earlier lists the name the terminal ended with', async () => {
    const { sessions, history, repository } = setup();
    sessions.add('pty-1', { hasUserInput: true, commandTerminalSlot: 'slot-1' });
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.change('pty-1', { commandTerminalLabel: 'Derived name' });
    sessions.change('pty-1', { commandTerminalLabel: 'Auth refactor', commandTerminalNamedByUser: true });
    expect(repository.get('conversation-a')?.label).toBe('Auth refactor');

    // A clear: the row reads as its first prompt again.
    sessions.prompt('pty-1', 'tidy the auth module');
    sessions.change('pty-1', { commandTerminalLabel: null });
    expect(repository.get('conversation-a')?.label).toBeNull();

    sessions.change('pty-1', { commandTerminalLabel: 'DB migration review' });
    sessions.remove('pty-1');
    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-a', label: 'DB migration review' }]);
  });

  it('writes nothing for a status push that leaves the name as it was', () => {
    const { sessions, repository } = setup();
    sessions.add('pty-1', { hasUserInput: true, commandTerminalLabel: 'Auth refactor', commandTerminalNamedByUser: true });
    sessions.reportAgentId('pty-1', 'conversation-a');
    // The row is renamed behind the terminal's back; a later push about
    // something else must not put the live name back over it.
    repository.setLabel('conversation-a', 'Edited elsewhere');
    sessions.change('pty-1', { status: 'running' });
    expect(repository.get('conversation-a')?.label).toBe('Edited elsewhere');
  });

  it('keeps a rename made between a resume\'s spawn and its agent reporting the id', async () => {
    const { sessions, history, repository } = setup();
    // The conversation as it ended under its old name.
    sessions.add('pty-1', { hasUserInput: true, commandTerminalLabel: 'Old name' });
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.remove('pty-1');
    expect(repository.get('conversation-a')?.label).toBe('Old name');

    // The resumed terminal is seeded with the old name, then renamed before
    // its agent reports the conversation's id.
    sessions.add('pty-2', { hasUserInput: true, commandTerminalLabel: 'Old name' });
    sessions.change('pty-2', { commandTerminalLabel: 'New name', commandTerminalNamedByUser: true });
    sessions.reportAgentId('pty-2', 'conversation-a');
    sessions.remove('pty-2');

    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-a', label: 'New name' }]);
  });

  it('does not hold a derived name that arrives before the id, so a resumed conversation keeps its own', async () => {
    const { sessions, history, repository } = setup();
    // The conversation as it ended under the name its user gave it.
    sessions.add('pty-1', { hasUserInput: true, commandTerminalLabel: 'Old name' });
    sessions.reportAgentId('pty-1', 'conversation-a');
    sessions.remove('pty-1');
    expect(repository.get('conversation-a')?.label).toBe('Old name');

    // The resumed terminal is seeded with the old name. Its label then changes to
    // one the namer derived (no `commandTerminalNamedByUser`) before the agent
    // reports the conversation's id: that is not a user's rename, so nothing is
    // held to be replayed over the row once the id arrives.
    sessions.add('pty-2', { hasUserInput: true, commandTerminalLabel: 'Old name' });
    sessions.change('pty-2', { commandTerminalLabel: 'Derived name' });
    sessions.reportAgentId('pty-2', 'conversation-a');
    expect(repository.get('conversation-a')?.label).toBe('Old name');

    sessions.remove('pty-2');
    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-a', label: 'Old name' }]);
  });

  it('keeps the name of a conversation a renamed terminal resumes into', () => {
    const { sessions, repository } = setup();
    sessions.add('pty-1', { hasUserInput: true, commandTerminalLabel: 'Other conversation' });
    sessions.reportAgentId('pty-1', 'conversation-b');
    sessions.remove('pty-1');

    // A terminal the user named moves, by `/resume`, into conversation-b.
    sessions.add('pty-2', { hasUserInput: true, commandTerminalLabel: 'Auth refactor', commandTerminalNamedByUser: true });
    sessions.reportAgentId('pty-2', 'conversation-a');
    sessions.reportAgentId('pty-2', 'conversation-b');
    sessions.change('pty-2', { status: 'running' });

    expect(repository.get('conversation-a')?.label).toBe('Auth refactor');
    expect(repository.get('conversation-b')?.label).toBe('Other conversation');
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

  it('deletes the row a quit left open for a terminal nobody used, and keeps a live unused one', async () => {
    const { repository, sessions, history } = setup();
    // A quit removes no row: this unused one has no end and no live terminal.
    repository.recordConversation({ agentSessionId: 'unused-at-quit', agentName: 'claude', cwd: '/projects/demo', label: null, touched: false });
    // A live terminal nobody has used yet keeps its row, so its first touch has one to mark.
    sessions.add('pty-1');
    sessions.reportAgentId('pty-1', 'conversation-live');

    expect(await history.list(PROJECT_ID)).toEqual([]);
    expect(repository.get('unused-at-quit')).toBeNull();
    expect(repository.get('conversation-live')).not.toBeNull();

    sessions.change('pty-1', { hasUserInput: true });
    sessions.remove('pty-1');
    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-live' }]);
  });

  it('keeps every ended conversation, oldest included, so the agent\'s own cleanup sets the limit', async () => {
    const { repository, history } = setup();
    const count = 120;
    for (let index = 0; index < count; index += 1) {
      const agentSessionId = `ended-${index}`;
      repository.recordConversation({ agentSessionId, agentName: 'claude', cwd: '/projects/demo', label: null, touched: true });
      repository.markEnded(agentSessionId, new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString());
    }
    const entries = await history.list(PROJECT_ID);
    expect(entries).toHaveLength(count);
    expect(entries[0].agentSessionId).toBe(`ended-${count - 1}`);
    expect(entries.at(-1)?.agentSessionId).toBe('ended-0');
  });

  it('checks transcripts a few at a time, however long the list', async () => {
    const { repository, sessions } = setup();
    for (let index = 0; index < 40; index += 1) {
      const agentSessionId = `ended-${index}`;
      repository.recordConversation({ agentSessionId, agentName: 'claude', cwd: '/projects/demo', label: null, touched: true });
      repository.markEnded(agentSessionId);
    }
    let running = 0;
    let mostAtOnce = 0;
    const history = new CommandTerminalHistory({
      sessionManager: sessions,
      getRepository: () => repository,
      conversationAvailable: async () => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await new Promise((resolve) => setImmediate(resolve));
        running -= 1;
        return true;
      },
      notifyChanged: vi.fn(),
      conversationEnded: vi.fn(),
      searchText: async () => ({ indexingOff: false, hits: [] }),
    });
    expect(await history.list(PROJECT_ID)).toHaveLength(40);
    expect(mostAtOnce).toBeGreaterThan(1);
    expect(mostAtOnce).toBeLessThanOrEqual(8);
  });

  /** One used conversation, ended: what Earlier lists and a resume claims. */
  function endedConversation(fixture: ReturnType<typeof setup>, agentSessionId: string): void {
    fixture.sessions.add('pty-old', { hasUserInput: true });
    fixture.sessions.reportAgentId('pty-old', agentSessionId);
    fixture.sessions.remove('pty-old');
  }

  it('renames a row as a user name: one line, cut to 64, and pushes the change', async () => {
    const fixture = setup();
    endedConversation(fixture, 'conversation-a');
    fixture.notifyChanged.mockClear();

    expect(fixture.history.rename(PROJECT_ID, 'conversation-a', `  Rail\n${'x'.repeat(80)}  `)).toBe(true);

    const row = fixture.repository.get('conversation-a');
    expect(row?.label).toBe(`Rail ${'x'.repeat(59)}`);
    expect(row?.named_by_user).toBe(1);
    expect(fixture.notifyChanged).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('clears a row with an empty name, keeps the mark, and reads as the first prompt again', async () => {
    const fixture = setup();
    fixture.sessions.add('pty-old', { hasUserInput: true, commandTerminalLabel: 'A derived name' });
    fixture.sessions.reportAgentId('pty-old', 'conversation-a');
    fixture.sessions.prompt('pty-old', 'why does the rail cut names');
    fixture.sessions.remove('pty-old');

    expect(fixture.history.rename(PROJECT_ID, 'conversation-a', '')).toBe(true);

    expect(fixture.repository.get('conversation-a')).toMatchObject({ label: null, named_by_user: 1 });
    expect(await fixture.history.list(PROJECT_ID)).toMatchObject([{ label: null, firstPrompt: 'why does the rail cut names' }]);
  });

  it.each([
    ['rename', (fixture: ReturnType<typeof setup>) => fixture.history.rename(PROJECT_ID, 'conversation-a', 'Mine')],
    ['remove', (fixture: ReturnType<typeof setup>) => fixture.history.remove(PROJECT_ID, 'conversation-a')],
  ])('refuses a %s while a live terminal holds the conversation or a resume is starting it, and for a row that is gone', (_name, act) => {
    const fixture = setup();
    fixture.sessions.add('pty-live', { hasUserInput: true });
    fixture.sessions.reportAgentId('pty-live', 'conversation-a');
    expect(act(fixture)).toBe(false);
    expect(fixture.repository.get('conversation-a')).toMatchObject({ label: null });

    fixture.sessions.remove('pty-live');
    expect(fixture.history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
    expect(act(fixture)).toBe(false);
    expect(fixture.repository.get('conversation-a')).not.toBeNull();

    fixture.history.settleResume(PROJECT_ID, 'conversation-a', null);
    fixture.repository.delete('conversation-a');
    expect(act(fixture)).toBe(false);
  });

  it('removes a row and asks for its text to go, leaving the conversation free to record again', async () => {
    const fixture = setup();
    endedConversation(fixture, 'conversation-a');
    fixture.conversationEnded.mockClear();
    fixture.notifyChanged.mockClear();

    expect(fixture.history.remove(PROJECT_ID, 'conversation-a')).toBe(true);

    expect(fixture.repository.get('conversation-a')).toBeNull();
    expect(await fixture.history.list(PROJECT_ID)).toEqual([]);
    expect(fixture.conversationEnded).toHaveBeenCalledWith(PROJECT_ID, 'conversation-a');
    expect(fixture.notifyChanged).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('carries a live rename and a live clear to the row as a user name, and leaves a derived name unmarked', () => {
    const fixture = setup();
    fixture.sessions.add('pty-1', { hasUserInput: true });
    fixture.sessions.reportAgentId('pty-1', 'conversation-a');
    fixture.sessions.change('pty-1', { commandTerminalLabel: 'Derived' });
    expect(fixture.repository.get('conversation-a')).toMatchObject({ label: 'Derived', named_by_user: 0 });

    fixture.sessions.change('pty-1', { commandTerminalLabel: null, commandTerminalNamedByUser: true });
    expect(fixture.repository.get('conversation-a')).toMatchObject({ label: null, named_by_user: 1 });
  });

  it('marks a row when Enter keeps a terminal\'s number, which changes the flag and not the name', () => {
    const fixture = setup();
    fixture.sessions.add('pty-1', { hasUserInput: true });
    fixture.sessions.reportAgentId('pty-1', 'conversation-a');
    fixture.sessions.change('pty-1', { commandTerminalNamedByUser: true });
    expect(fixture.repository.get('conversation-a')).toMatchObject({ label: null, named_by_user: 1 });
  });

  it('marks a row for a rename made before the agent reported the id', () => {
    const fixture = setup();
    fixture.sessions.add('pty-1', { hasUserInput: true });
    fixture.sessions.change('pty-1', { commandTerminalLabel: 'Early', commandTerminalNamedByUser: true });
    fixture.sessions.reportAgentId('pty-1', 'conversation-a');
    expect(fixture.repository.get('conversation-a')).toMatchObject({ label: 'Early', named_by_user: 1 });
  });

  it('asks for a conversation\'s text when its terminal ends and when the agent moves on, and for a row a purge dropped', async () => {
    const available = new Set(['conversation-b']);
    const fixture = setup({ available: (agentSessionId) => available.has(agentSessionId) });
    fixture.sessions.add('pty-1', { hasUserInput: true });
    fixture.sessions.reportAgentId('pty-1', 'conversation-a');
    expect(fixture.conversationEnded).not.toHaveBeenCalled();

    fixture.sessions.reportAgentId('pty-1', 'conversation-b');
    expect(fixture.conversationEnded).toHaveBeenLastCalledWith(PROJECT_ID, 'conversation-a');

    fixture.sessions.remove('pty-1');
    expect(fixture.conversationEnded).toHaveBeenLastCalledWith(PROJECT_ID, 'conversation-b');

    fixture.conversationEnded.mockClear();
    await fixture.history.list(PROJECT_ID);
    expect(fixture.conversationEnded).toHaveBeenCalledTimes(1);
    expect(fixture.conversationEnded).toHaveBeenCalledWith(PROJECT_ID, 'conversation-a');
  });

  it('holds a resumed conversation from the claim until its terminal reports it, and refuses a second claim', async () => {
    const fixture = setup();
    endedConversation(fixture, 'conversation-a');
    const { sessions, history, notifyChanged } = fixture;
    notifyChanged.mockClear();

    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
    // Earlier drops the row at once, and nothing can start it twice.
    expect(notifyChanged).toHaveBeenCalledWith(PROJECT_ID);
    expect(await history.list(PROJECT_ID)).toEqual([]);
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(false);

    // Spawned, but the agent has not reported its id yet: still claimed.
    sessions.add('pty-new', { hasUserInput: true });
    history.settleResume(PROJECT_ID, 'conversation-a', 'pty-new');
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(false);

    // Reported: the live terminal now holds it, and ending that terminal frees it.
    sessions.reportAgentId('pty-new', 'conversation-a');
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(false);
    sessions.remove('pty-new');
    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-a' }]);
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
  });

  it('frees a claim whose start made no terminal, and lists the row again', async () => {
    const fixture = setup();
    endedConversation(fixture, 'conversation-a');
    const { history, notifyChanged } = fixture;
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
    notifyChanged.mockClear();

    history.settleResume(PROJECT_ID, 'conversation-a', null);
    expect(notifyChanged).toHaveBeenCalledWith(PROJECT_ID);
    expect(await history.list(PROJECT_ID)).toMatchObject([{ agentSessionId: 'conversation-a' }]);
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
  });

  it('frees a claim when its terminal ends before the agent reports an id', () => {
    const fixture = setup();
    endedConversation(fixture, 'conversation-a');
    const { sessions, history } = fixture;
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
    sessions.add('pty-new', { hasUserInput: true });
    history.settleResume(PROJECT_ID, 'conversation-a', 'pty-new');
    sessions.remove('pty-new');
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
  });

  it('refuses a claim on a conversation a live session already reports', () => {
    const { sessions, history } = setup();
    sessions.add('pty-1', { agentSessionId: 'conversation-a' });
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(false);
  });
});
