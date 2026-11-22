/**
 * The pure and wrapper parts of `carried-owner-turn.ts` (kangentic-mobile #160): when a turn end
 * reads through a turn a restart cut off, and the wrappers that never throw into a turn end or a
 * resume. The end-to-end timeline is `turn-end-runner-restart-owner-message.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { CarriedOwnerTurn, SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { UserMessageRead } from '../../src/shared/final-line-match';
import type { TurnAnchorPayload } from '../../src/main/pty/session-manager';
import { openMigratedProjectDatabase, insertSessionRecord, insertTask } from './helpers/earlier-run-fixture';

const hoisted = vi.hoisted(() => ({ readUserMessagesInTurn: vi.fn() }));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => null),
  getOpenProjectDb: vi.fn(() => null),
}));
vi.mock('../../src/main/automations/turn-end/final-reply-reader', () => ({
  readUserMessagesInTurn: hoisted.readUserMessagesInTurn,
}));

const {
  readsCarriedTurn,
  readUserMessagesWithCarriedTurn,
  recordOpenTurn,
  takeCarriedOwnerTurn,
  carryInterruptedTurn,
  carriedOwnerTurnReporter,
} = await import('../../src/main/automations/turn-end/carried-owner-turn');
const { SessionRepository: RealSessionRepository } = await import('../../src/main/db/repositories/session-repository');

const CONVERSATION = 'conversation-1';
const VISIT_STARTED_AT = '2026-11-22T10:00:00.000Z';

const carried: CarriedOwnerTurn = {
  agentSessionId: CONVERSATION,
  byteOffset: 100,
  startedAt: '2026-11-22T10:05:00.000Z',
  recordIds: ['record-owner'],
};
const emptyRead: UserMessageRead = { readable: true, messages: [] };

describe('readsCarriedTurn', () => {
  const passing = {
    ownRead: emptyRead,
    carried,
    visitStartedAt: VISIT_STARTED_AT,
    recordAgentSessionId: CONVERSATION,
  };

  it('reads through the carried turn when every guard passes', () => {
    expect(readsCarriedTurn(passing)).toBe(true);
  });

  it('reads through it when the task has no move record', () => {
    expect(readsCarriedTurn({ ...passing, visitStartedAt: null })).toBe(true);
  });

  it('does not when the record names another conversation', () => {
    expect(readsCarriedTurn({ ...passing, recordAgentSessionId: 'conversation-2' })).toBe(false);
  });

  it('does not when the record names no conversation', () => {
    expect(readsCarriedTurn({ ...passing, recordAgentSessionId: null })).toBe(false);
  });

  it('does not when the turn\'s own read is unreadable', () => {
    expect(readsCarriedTurn({ ...passing, ownRead: { readable: false } })).toBe(false);
  });

  it('does not when the turn\'s own read holds a message, even one that matches nothing', () => {
    expect(readsCarriedTurn({ ...passing, ownRead: { readable: true, messages: ['anything'] } })).toBe(false);
  });

  it('does not when the carried turn began before the column visit', () => {
    expect(readsCarriedTurn({ ...passing, visitStartedAt: '2026-11-22T10:10:00.000Z' })).toBe(false);
  });

  it('reads through it when the carried turn began at the moment of the visit', () => {
    expect(readsCarriedTurn({ ...passing, visitStartedAt: carried.startedAt })).toBe(true);
  });
});

describe('readUserMessagesWithCarriedTurn', () => {
  const session = { sessionId: 'session-aaaaaaaa', agentSessionId: CONVERSATION, transcriptAnchor: null };
  let reportSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hoisted.readUserMessagesInTurn.mockReset();
    reportSpy = vi.spyOn(carriedOwnerTurnReporter, 'report').mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function repositoryAnswering(agentSessionId: string | null): SessionRepository {
    return { findByAnyId: () => ({ agent_session_id: agentSessionId }) } as unknown as SessionRepository;
  }

  it('returns an unreadable own read as it is and makes no second read', async () => {
    hoisted.readUserMessagesInTurn.mockResolvedValueOnce({ readable: false });
    const result = await readUserMessagesWithCarriedTurn(session, repositoryAnswering(CONVERSATION), null, carried, VISIT_STARTED_AT);
    expect(result).toEqual({ readable: false });
    expect(hoisted.readUserMessagesInTurn).toHaveBeenCalledTimes(1);
  });

  it('returns the own read and reports when the record lookup throws', async () => {
    const lookupFailure = new Error('database is locked');
    const ownRead: UserMessageRead = { readable: true, messages: [] };
    hoisted.readUserMessagesInTurn.mockResolvedValueOnce(ownRead);
    const throwingRepository = {
      findByAnyId: () => {
        throw lookupFailure;
      },
    } as unknown as SessionRepository;

    const result = await readUserMessagesWithCarriedTurn(session, throwingRepository, null, carried, VISIT_STARTED_AT);

    expect(result).toBe(ownRead);
    expect(hoisted.readUserMessagesInTurn).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(lookupFailure);
  });

  it('reads again from the carried turn and marks the read, when every guard passes', async () => {
    hoisted.readUserMessagesInTurn
      .mockResolvedValueOnce({ readable: true, messages: [] })
      .mockResolvedValueOnce({ readable: true, messages: ['signed off'] });

    const result = await readUserMessagesWithCarriedTurn(session, repositoryAnswering(CONVERSATION), null, carried, VISIT_STARTED_AT);

    expect(result).toEqual({ readable: true, messages: ['signed off'], carriedAcrossRestart: true });
    expect(hoisted.readUserMessagesInTurn).toHaveBeenCalledTimes(2);
    const secondCall = hoisted.readUserMessagesInTurn.mock.calls[1];
    expect(secondCall[0].transcriptAnchor).toEqual({ agentSessionId: CONVERSATION, byteOffset: 100 });
    expect(secondCall[4]).toEqual(['record-owner']);
  });

  it('returns the own read untouched when there is no carried turn', async () => {
    const ownRead: UserMessageRead = { readable: true, messages: [] };
    hoisted.readUserMessagesInTurn.mockResolvedValueOnce(ownRead);
    const result = await readUserMessagesWithCarriedTurn(session, repositoryAnswering(CONVERSATION), null, null, VISIT_STARTED_AT);
    expect(result).toBe(ownRead);
    expect(hoisted.readUserMessagesInTurn).toHaveBeenCalledTimes(1);
  });
});

describe('the wrappers never throw into a turn end or a resume', () => {
  let reportSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reportSpy = vi.spyOn(carriedOwnerTurnReporter, 'report').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const payload: TurnAnchorPayload = {
    sessionId: 'record-owner',
    taskId: 'task-a',
    projectId: 'project-1',
    anchor: { agentSessionId: CONVERSATION, byteOffset: 100 },
    turnStartedAt: Date.parse('2026-11-22T10:05:00.000Z'),
  };

  it('recordOpenTurn writes nothing and does not throw when the project database is not open', () => {
    const openProjectDb = vi.fn(() => null);
    expect(() => recordOpenTurn(payload, openProjectDb)).not.toThrow();
    expect(openProjectDb).toHaveBeenCalledWith('project-1');
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('recordOpenTurn writes the open turn on the session row', () => {
    const database = openMigratedProjectDatabase();
    try {
      insertTask(database, 'task-a');
      insertSessionRecord(database, { id: 'record-owner', startedAt: '2026-11-22T09:00:00.000Z' });
      recordOpenTurn(payload, () => database);
      const row = database.prepare('SELECT open_turn FROM sessions WHERE id = ?').get('record-owner') as { open_turn: string | null };
      expect(JSON.parse(row.open_turn ?? 'null')).toEqual({
        agentSessionId: CONVERSATION,
        byteOffset: 100,
        startedAt: '2026-11-22T10:05:00.000Z',
      });
    } finally {
      database.close();
    }
  });

  it('recordOpenTurn reports once and does not rethrow when the write throws', () => {
    const database = openMigratedProjectDatabase();
    database.close();
    expect(() => recordOpenTurn(payload, () => database as Database.Database)).not.toThrow();
    expect(reportSpy).toHaveBeenCalledTimes(1);
  });

  it('takeCarriedOwnerTurn returns null and reports when the repository throws', () => {
    const failure = new Error('disk I/O error');
    const throwingRepository = {
      takeCarriedOwnerTurn: () => {
        throw failure;
      },
    } as unknown as SessionRepository;
    expect(takeCarriedOwnerTurn(throwingRepository, 'record-owner')).toBeNull();
    expect(reportSpy).toHaveBeenCalledWith(failure);
  });

  it('carryInterruptedTurn does not throw and reports when the repository throws', () => {
    const failure = new Error('disk I/O error');
    const throwingRepository = {
      carryOpenTurn: () => {
        throw failure;
      },
    } as unknown as SessionRepository;
    expect(() => carryInterruptedTurn(throwingRepository, 'record-a', 'record-b')).not.toThrow();
    expect(reportSpy).toHaveBeenCalledWith(failure);
  });

  it('carryInterruptedTurn reports nothing on success', () => {
    const database = openMigratedProjectDatabase();
    try {
      insertTask(database, 'task-a');
      insertSessionRecord(database, { id: 'record-a', startedAt: '2026-11-22T09:00:00.000Z' });
      insertSessionRecord(database, { id: 'record-b', startedAt: '2026-11-22T09:10:00.000Z' });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      carryInterruptedTurn(new RealSessionRepository(database), 'record-a', 'record-b');
      expect(reportSpy).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
