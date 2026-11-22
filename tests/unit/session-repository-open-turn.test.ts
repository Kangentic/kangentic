/**
 * The stored open turn and carried owner turn on `sessions` (kangentic-mobile #160): the two
 * parsers, the repository methods that write and move them, and the migration that adds them.
 * Runs the real `SessionRepository` on a migrated in-memory database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  SessionRepository,
  parseCarriedOwnerTurn,
  parseStoredTurnPosition,
  type StoredTurnPosition,
} from '../../src/main/db/repositories/session-repository';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { insertSessionRecord, insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

const POSITION: StoredTurnPosition = { agentSessionId: 'conversation-1', byteOffset: 100, startedAt: '2026-11-22T10:05:00.000Z' };
const LATER_POSITION: StoredTurnPosition = { agentSessionId: 'conversation-1', byteOffset: 900, startedAt: '2026-11-22T10:30:00.000Z' };

describe('parseStoredTurnPosition and parseCarriedOwnerTurn', () => {
  const carriedValue = { ...POSITION, recordIds: ['record-a'] };

  it('round-trips a valid value', () => {
    expect(parseStoredTurnPosition(JSON.stringify(POSITION))).toEqual(POSITION);
    expect(parseCarriedOwnerTurn(JSON.stringify(carriedValue))).toEqual(carriedValue);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['invalid JSON', '{not json'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"text"'],
  ])('returns null for %s', (_label, raw) => {
    expect(parseStoredTurnPosition(raw)).toBeNull();
    expect(parseCarriedOwnerTurn(raw)).toBeNull();
  });

  it.each([
    ['an empty agentSessionId', { agentSessionId: '' }],
    ['a missing agentSessionId', { agentSessionId: undefined }],
    ['a negative byteOffset', { byteOffset: -1 }],
    ['a fractional byteOffset', { byteOffset: 1.5 }],
    ['a string byteOffset', { byteOffset: '100' }],
    ['an unparseable startedAt', { startedAt: 'not a date' }],
    ['a missing startedAt', { startedAt: undefined }],
  ])('returns null for %s', (_label, override) => {
    expect(parseStoredTurnPosition(JSON.stringify({ ...POSITION, ...override }))).toBeNull();
    expect(parseCarriedOwnerTurn(JSON.stringify({ ...carriedValue, ...override }))).toBeNull();
  });

  it('accepts a zero byteOffset', () => {
    expect(parseStoredTurnPosition(JSON.stringify({ ...POSITION, byteOffset: 0 }))).toEqual({ ...POSITION, byteOffset: 0 });
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['not a list', 'record-a'],
    ['holding a non-string entry', ['record-a', 7]],
    ['holding an empty-string entry', ['record-a', '']],
  ])('returns null for a carried turn whose recordIds are %s', (_label, recordIds) => {
    expect(parseCarriedOwnerTurn(JSON.stringify({ ...POSITION, recordIds }))).toBeNull();
  });
});

describe('SessionRepository open turn and carried owner turn', () => {
  let database: Database.Database;
  let sessions: SessionRepository;

  beforeEach(() => {
    database = openMigratedProjectDatabase();
    insertTask(database, 'task-a');
    for (const [index, id] of ['record-a', 'record-b', 'record-c'].entries()) {
      insertSessionRecord(database, { id, startedAt: `2026-11-22T09:0${index}:00.000Z` });
    }
    sessions = new SessionRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  const columnsOf = (id: string) =>
    database.prepare('SELECT open_turn, carried_owner_turn FROM sessions WHERE id = ?').get(id) as {
      open_turn: string | null;
      carried_owner_turn: string | null;
    };
  const parsed = (raw: string | null): unknown => JSON.parse(raw ?? 'null');

  describe('setOpenTurn', () => {
    it('stores a position and clears it with null', () => {
      sessions.setOpenTurn('record-a', POSITION);
      expect(parsed(columnsOf('record-a').open_turn)).toEqual(POSITION);

      sessions.setOpenTurn('record-a', null);
      expect(columnsOf('record-a').open_turn).toBeNull();
    });

    it('is a no-op for an id with no row', () => {
      expect(() => sessions.setOpenTurn('record-missing', POSITION)).not.toThrow();
      expect(() => sessions.setOpenTurn('record-missing', null)).not.toThrow();
      expect((database.prepare('SELECT COUNT(*) AS total FROM sessions').get() as { total: number }).total).toBe(3);
    });
  });

  describe('carryOpenTurn', () => {
    it('moves the open turn to the new record with the old id as its record list, and clears both columns on the old one', () => {
      sessions.setOpenTurn('record-a', POSITION);
      database.prepare('UPDATE sessions SET carried_owner_turn = NULL WHERE id = ?').run('record-a');

      const carried = sessions.carryOpenTurn('record-a', 'record-b');

      expect(carried).toEqual({ ...POSITION, recordIds: ['record-a'] });
      expect(parsed(columnsOf('record-b').carried_owner_turn)).toEqual({ ...POSITION, recordIds: ['record-a'] });
      expect(columnsOf('record-a')).toEqual({ open_turn: null, carried_owner_turn: null });
    });

    it('prefers the old record\'s own carried turn and appends the old id to its list', () => {
      sessions.setOpenTurn('record-b', LATER_POSITION);
      database
        .prepare('UPDATE sessions SET carried_owner_turn = ? WHERE id = ?')
        .run(JSON.stringify({ ...POSITION, recordIds: ['record-a'] }), 'record-b');

      const carried = sessions.carryOpenTurn('record-b', 'record-c');

      expect(carried).toEqual({ ...POSITION, recordIds: ['record-a', 'record-b'] });
      expect(parsed(columnsOf('record-c').carried_owner_turn)).toEqual({ ...POSITION, recordIds: ['record-a', 'record-b'] });
      expect(columnsOf('record-b')).toEqual({ open_turn: null, carried_owner_turn: null });
    });

    it('returns null and writes nothing when the old record has no row', () => {
      expect(sessions.carryOpenTurn('record-missing', 'record-b')).toBeNull();
      expect(columnsOf('record-b').carried_owner_turn).toBeNull();
    });

    it('returns null and leaves the new record NULL when the old record has no turn', () => {
      expect(sessions.carryOpenTurn('record-a', 'record-b')).toBeNull();
      expect(columnsOf('record-b').carried_owner_turn).toBeNull();
    });

    it('returns null and leaves the old record\'s open turn intact when the new record has no row', () => {
      sessions.setOpenTurn('record-a', POSITION);

      expect(sessions.carryOpenTurn('record-a', 'record-missing')).toBeNull();

      expect(parsed(columnsOf('record-a').open_turn)).toEqual(POSITION);
    });

    it('falls back to the open turn when the old record\'s carried turn is corrupt', () => {
      sessions.setOpenTurn('record-a', POSITION);
      database.prepare('UPDATE sessions SET carried_owner_turn = ? WHERE id = ?').run('{broken', 'record-a');

      const carried = sessions.carryOpenTurn('record-a', 'record-b');

      expect(carried).toEqual({ ...POSITION, recordIds: ['record-a'] });
      expect(columnsOf('record-a')).toEqual({ open_turn: null, carried_owner_turn: null });
    });
  });

  describe('takeCarriedOwnerTurn', () => {
    const carriedValue = { ...POSITION, recordIds: ['record-a'] };

    it('returns the value and clears it, so a second take returns null', () => {
      database.prepare('UPDATE sessions SET carried_owner_turn = ? WHERE id = ?').run(JSON.stringify(carriedValue), 'record-b');

      expect(sessions.takeCarriedOwnerTurn('record-b')).toEqual(carriedValue);
      expect(columnsOf('record-b').carried_owner_turn).toBeNull();
      expect(sessions.takeCarriedOwnerTurn('record-b')).toBeNull();
    });

    it('returns null for an unparseable value and still clears the column', () => {
      database.prepare('UPDATE sessions SET carried_owner_turn = ? WHERE id = ?').run('{broken', 'record-b');

      expect(sessions.takeCarriedOwnerTurn('record-b')).toBeNull();
      expect(columnsOf('record-b').carried_owner_turn).toBeNull();
    });

    it('returns null for a row that is missing', () => {
      expect(sessions.takeCarriedOwnerTurn('record-missing')).toBeNull();
    });
  });
});

describe('the open_turn and carried_owner_turn migration', () => {
  const columnNames = (database: Database.Database): string[] =>
    (database.pragma('table_info(sessions)') as Array<{ name: string }>).map((column) => column.name);

  it('adds both columns, and running the migrations again leaves exactly one of each', () => {
    const database = openMigratedProjectDatabase();
    try {
      expect(columnNames(database)).toEqual(expect.arrayContaining(['open_turn', 'carried_owner_turn']));

      expect(() => runProjectMigrations(database)).not.toThrow();

      const names = columnNames(database);
      expect(names.filter((name) => name === 'open_turn')).toHaveLength(1);
      expect(names.filter((name) => name === 'carried_owner_turn')).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
