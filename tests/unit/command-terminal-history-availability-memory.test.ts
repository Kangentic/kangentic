/**
 * The Earlier list holds a transcript it found for `AVAILABILITY_RECHECK_MS`
 * (5 minutes) so a rename's or a terminal's end's re-list walks no folders
 * (src/main/ipc/helpers/command-terminal-history.ts, `availableForList`).
 *
 * What the memory must do, and must not:
 *  - answer a row found within the last 5 minutes without asking the agent;
 *  - ask again once 5 minutes have passed, and drop a row whose transcript is gone by then;
 *  - never hold a miss, so a row reported missing is deleted and a new row with the same
 *    id is asked about afresh;
 *  - forget a row `remove` deleted;
 *  - never answer a resume's own `conversationAvailable` call (the class method) from it.
 *
 * Runs against a real migrated project database, with only `Date` faked so the
 * database and the p-queue behind the list run on real timers.
 *
 * Red-green, from toggling command-terminal-history.ts and restoring it:
 *  - drop the `foundAt` early return in `availableForList`: the within-window test sees extra asks.
 *  - make the early return unconditional (no age check): the past-5-minutes tests never ask again.
 *  - store a miss (`transcriptFoundAt.set` whatever the answer): the miss tests fail.
 *  - drop `transcriptFoundAt.delete` from `remove`: the forget-on-remove test fails.
 *  - route `conversationAvailable` through the memory: the resume test fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CommandTerminalHistoryRepository } from '../../src/main/db/repositories/command-terminal-history-repository';
import { CommandTerminalHistory } from '../../src/main/ipc/helpers/command-terminal-history';
import type { Session } from '../../src/shared/types';
import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const START_TIME = new Date('2026-01-01T00:00:00.000Z');

const openDatabases: DatabaseType.Database[] = [];
const histories: CommandTerminalHistory[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START_TIME);
});

afterEach(() => {
  vi.useRealTimers();
  for (const history of histories.splice(0)) history.dispose();
  for (const database of openDatabases.splice(0)) database.close();
});

function advanceClock(milliseconds: number): void {
  vi.setSystemTime(new Date(Date.now() + milliseconds));
}

function setup(initialMissing: string[] = []) {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const repository = new CommandTerminalHistoryRepository(database);
  const missing = new Set<string>(initialMissing);
  const conversationAvailable = vi.fn(async (_agent: string, agentSessionId: string) => !missing.has(agentSessionId));
  const conversationEnded = vi.fn();
  const history = new CommandTerminalHistory({
    sessionManager: {
      on: () => undefined,
      off: () => undefined,
      getSession: (): Session | undefined => undefined,
      getSessionAgentName: () => 'claude',
      listSessions: (): Session[] => [],
    },
    getRepository: () => repository,
    conversationAvailable,
    notifyChanged: vi.fn(),
    conversationEnded,
    searchText: async () => ({ indexingOff: false, hits: [] }),
  });
  history.start();
  histories.push(history);

  function recordUsedConversation(agentSessionId: string): void {
    repository.recordConversation({ agentSessionId, agentName: 'claude', cwd: '/projects/demo', label: null, touched: true });
  }

  function askedAbout(agentSessionId: string): number {
    return conversationAvailable.mock.calls.filter((call) => call[1] === agentSessionId).length;
  }

  return { repository, history, missing, conversationAvailable, conversationEnded, recordUsedConversation, askedAbout };
}

describe('CommandTerminalHistory.list transcript memory', () => {
  it('asks the agent once per row, and answers a second list inside 5 minutes from memory', async () => {
    const fixture = setup();
    fixture.recordUsedConversation('conversation-a');
    fixture.recordUsedConversation('conversation-b');

    const first = await fixture.history.list(PROJECT_ID);
    expect(first.map((entry) => entry.agentSessionId).sort()).toEqual(['conversation-a', 'conversation-b']);
    expect(fixture.conversationAvailable).toHaveBeenCalledTimes(2);

    advanceClock(FIVE_MINUTES_MS - 1);
    const second = await fixture.history.list(PROJECT_ID);

    expect(second.map((entry) => entry.agentSessionId).sort()).toEqual(['conversation-a', 'conversation-b']);
    expect(fixture.conversationAvailable).toHaveBeenCalledTimes(2);
  });

  it('asks again once 5 minutes have passed since the transcript was found', async () => {
    const fixture = setup();
    fixture.recordUsedConversation('conversation-a');
    await fixture.history.list(PROJECT_ID);
    expect(fixture.askedAbout('conversation-a')).toBe(1);

    advanceClock(FIVE_MINUTES_MS);
    const entries = await fixture.history.list(PROJECT_ID);

    expect(fixture.askedAbout('conversation-a')).toBe(2);
    expect(entries.map((entry) => entry.agentSessionId)).toEqual(['conversation-a']);
  });

  it('drops, deletes and reports a row whose transcript went away after the window', async () => {
    const fixture = setup();
    fixture.recordUsedConversation('conversation-a');
    fixture.recordUsedConversation('conversation-b');
    await fixture.history.list(PROJECT_ID);

    fixture.missing.add('conversation-a');
    advanceClock(FIVE_MINUTES_MS + 1);
    const entries = await fixture.history.list(PROJECT_ID);

    expect(entries.map((entry) => entry.agentSessionId)).toEqual(['conversation-b']);
    expect(fixture.repository.get('conversation-a')).toBeNull();
    expect(fixture.repository.get('conversation-b')).not.toBeNull();
    expect(fixture.conversationEnded).toHaveBeenCalledWith(PROJECT_ID, 'conversation-a');
    expect(fixture.conversationEnded).not.toHaveBeenCalledWith(PROJECT_ID, 'conversation-b');
  });

  it('keeps listing a row inside the window even when its transcript has just gone', async () => {
    // The memory is the point: a resume asks the agent itself and answers conversation-gone.
    const fixture = setup();
    fixture.recordUsedConversation('conversation-a');
    await fixture.history.list(PROJECT_ID);

    fixture.missing.add('conversation-a');
    advanceClock(60 * 1000);
    const entries = await fixture.history.list(PROJECT_ID);

    expect(entries.map((entry) => entry.agentSessionId)).toEqual(['conversation-a']);
    expect(fixture.askedAbout('conversation-a')).toBe(1);
  });

  it('never holds a miss: a row reported missing is deleted and a new row with the same id is asked about again', async () => {
    const fixture = setup(['conversation-a']);
    fixture.recordUsedConversation('conversation-a');

    expect(await fixture.history.list(PROJECT_ID)).toEqual([]);
    expect(fixture.askedAbout('conversation-a')).toBe(1);
    expect(fixture.repository.get('conversation-a')).toBeNull();

    // The same id comes back (a resume of the same conversation), now with a transcript, no time passed.
    fixture.missing.delete('conversation-a');
    fixture.recordUsedConversation('conversation-a');
    const entries = await fixture.history.list(PROJECT_ID);

    expect(fixture.askedAbout('conversation-a')).toBe(2);
    expect(entries.map((entry) => entry.agentSessionId)).toEqual(['conversation-a']);
  });

  it('forgets a found transcript when the row goes, so a new row with the same id is asked about again', async () => {
    const fixture = setup();
    fixture.recordUsedConversation('conversation-a');
    await fixture.history.list(PROJECT_ID);
    expect(fixture.askedAbout('conversation-a')).toBe(1);

    expect(fixture.history.remove(PROJECT_ID, 'conversation-a')).toBe(true);

    // The id comes back inside the window, and this time its transcript is gone.
    fixture.missing.add('conversation-a');
    fixture.recordUsedConversation('conversation-a');
    const entries = await fixture.history.list(PROJECT_ID);

    expect(fixture.askedAbout('conversation-a')).toBe(2);
    expect(entries).toEqual([]);
  });

  it('never answers a resume\'s own conversationAvailable call from memory', async () => {
    const fixture = setup();
    fixture.recordUsedConversation('conversation-a');
    await fixture.history.list(PROJECT_ID);
    expect(fixture.askedAbout('conversation-a')).toBe(1);

    const row = fixture.repository.get('conversation-a')!;
    fixture.missing.add('conversation-a');
    advanceClock(1000);

    await expect(fixture.history.conversationAvailable(row)).resolves.toBe(false);
    expect(fixture.askedAbout('conversation-a')).toBe(2);

    // And it asks again for a found transcript, a second time inside the window.
    fixture.missing.delete('conversation-a');
    await expect(fixture.history.conversationAvailable(row)).resolves.toBe(true);
    expect(fixture.askedAbout('conversation-a')).toBe(3);
  });
});
