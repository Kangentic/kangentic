/**
 * A Text match on the user's message never reads Kangentic's own text as the user's (#1078).
 *
 * The agent's transcript cannot tell a column message Kangentic pasted from a person's words, so
 * the typed-message ledger is the only thing between the Design contract (which names "signed
 * off") and a card moving to Planning at a turn end. What a user loses if this goes: a card that
 * leaves Design on its own column message, before anyone signed it off. Real SQLite, the real
 * ledger, matcher and board file.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

const hoisted = vi.hoisted(() => ({ database: null as Database.Database | null }));
vi.mock('../../src/main/db/database', () => ({
  getOpenProjectDb: () => hoisted.database,
}));

import {
  forgetTypedMessageSession,
  lastUserMessage,
  recordKangenticTyped,
  recordKangenticTypedInProject,
  resetTypedMessageLedgerForTest,
} from '../../src/main/automations/turn-end/typed-message-ledger';
import { SessionTypedMessageRepository, TYPED_MESSAGES_KEPT_PER_SESSION, typedMessageKey } from '../../src/main/db/repositories/session-typed-message-repository';
import { matchUserMessage } from '../../src/shared/final-line-match';

const SESSION_ID = 'session-design';
const PROJECT_ID = 'project-a';

interface BoardRow { name: string; message?: string; condition?: { text?: { from: string; patterns: string[] } } }
interface BoardFile { columns: Array<{ name: string; automations?: Record<string, BoardRow[]> }> }

const board = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../kangentic.json'), 'utf8')) as BoardFile;
const design = board.columns.find((column) => column.name === 'Design');
const designContract = design?.automations?.onEnter?.find((row) => row.name === 'Design contract')?.message ?? '';
const onToPlanningPatterns = (design?.automations?.onTurnEnd?.find((row) => row.name === 'On to Planning')?.condition?.text?.patterns ?? []).join('\n');

function insertSession(database: Database.Database, sessionId: string): void {
  database.prepare(`
    INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
    VALUES (?, 'task-a', 'claude_agent', 'claude', '/mock/worktree', 'running', '2026-11-12T10:00:00.000Z')
  `).run(sessionId);
}

const lookup = { getSession: () => ({ projectId: PROJECT_ID, taskId: 'task-a' }) };

beforeEach(() => {
  resetTypedMessageLedgerForTest();
  hoisted.database = openMigratedProjectDatabase();
  insertTask(hoisted.database, 'task-a');
  insertSession(hoisted.database, SESSION_ID);
});

afterEach(() => {
  hoisted.database?.close();
  hoisted.database = null;
});

describe('the Design board rows this test reads', () => {
  it('finds the contract and the On to Planning patterns', () => {
    expect(designContract).toContain('signed off');
    expect(onToPlanningPatterns).toContain('*signed off*');
  });
});

describe('a turn whose only user text is Kangentic\'s', () => {
  it('does not run On to Planning on the Design contract Kangentic typed', () => {
    recordKangenticTyped(lookup, SESSION_ID, designContract);
    const read = lastUserMessage(hoisted.database, SESSION_ID, [designContract]);
    expect(read).toEqual({ readable: true, message: null });
    expect(matchUserMessage(onToPlanningPatterns, read).met).toBe(false);
  });

  it('does not run it on the contract a resume put on the command line', () => {
    recordKangenticTypedInProject(PROJECT_ID, SESSION_ID, designContract);
    expect(matchUserMessage(onToPlanningPatterns, lastUserMessage(hoisted.database, SESSION_ID, [designContract])).met).toBe(false);
  });

  // The record forgives what delivery changes: keystroke delivery turns line breaks into spaces,
  // and the Windows shim flattens a command-line prompt.
  it('drops the contract however its line breaks and case reached the transcript', () => {
    recordKangenticTyped(lookup, SESSION_ID, designContract.replace(/\. /g, '.\n'));
    const asDelivered = designContract.replace(/\s+/g, ' ').toUpperCase();
    expect(lastUserMessage(hoisted.database, SESSION_ID, [asDelivered])).toEqual({ readable: true, message: null });
  });

  // Defense in depth: even with no record, the contract's own words rule the row out.
  it('does not run On to Planning on the contract\'s words even unrecorded', () => {
    expect(matchUserMessage(onToPlanningPatterns, { readable: true, message: designContract }).met).toBe(false);
  });
});

describe('the user\'s own message', () => {
  it('reads the owner\'s sign-off after Kangentic\'s message, and it runs the row', () => {
    recordKangenticTyped(lookup, SESSION_ID, designContract);
    const read = lastUserMessage(hoisted.database, SESSION_ID, [designContract, 'Looks great, design is signed off']);
    expect(read).toEqual({ readable: true, message: 'Looks great, design is signed off' });
    expect(matchUserMessage(onToPlanningPatterns, read).met).toBe(true);
  });

  // The last message wins: a later "not signed off" overrules an earlier sign-off.
  it('reads the newest of the user\'s messages, and a later refusal stops the row', () => {
    const read = lastUserMessage(hoisted.database, SESSION_ID, ['signed off', 'wait, this is not signed off yet']);
    expect(read).toEqual({ readable: true, message: 'wait, this is not signed off yet' });
    expect(matchUserMessage(onToPlanningPatterns, read).met).toBe(false);
  });

  it('skips a Kangentic message typed after the owner\'s', () => {
    recordKangenticTyped(lookup, SESSION_ID, 'Continue with the canvas.');
    const read = lastUserMessage(hoisted.database, SESSION_ID, ['signed off', 'Continue with the canvas.']);
    expect(read).toEqual({ readable: true, message: 'signed off' });
  });

  it('keeps other feedback from moving the card', () => {
    expect(matchUserMessage(onToPlanningPatterns, lastUserMessage(hoisted.database, SESSION_ID, ['the rest look good'])).met).toBe(false);
  });
});

describe('fails closed', () => {
  it('is unreadable when the transcript read failed', () => {
    expect(lastUserMessage(hoisted.database, SESSION_ID, null)).toEqual({ readable: false });
  });

  it('is unreadable with no database', () => {
    expect(lastUserMessage(null, SESSION_ID, ['signed off'])).toEqual({ readable: false });
  });

  // A record that could not be written leaves Kangentic's text unaccounted for, so the session's
  // reads stop: reading on would hand the contract to the matcher as the user's words.
  it('marks a session whose record had no row, and reads it as unreadable from then on', () => {
    recordKangenticTyped(lookup, 'session-with-no-row', designContract);
    expect(lastUserMessage(hoisted.database, 'session-with-no-row', ['signed off'])).toEqual({ readable: false });
  });

  it('marks a session whose project had no open database', () => {
    const database = hoisted.database;
    hoisted.database = null;
    recordKangenticTyped(lookup, SESSION_ID, designContract);
    hoisted.database = database;
    expect(lastUserMessage(hoisted.database, SESSION_ID, ['signed off'])).toEqual({ readable: false });
  });

  // A removed session never ends another turn, so its mark is dropped. A session that is reused
  // (the same id) after that starts with a clean record.
  it('reads again after the session\'s unreliable mark is forgotten and its record is set up', () => {
    recordKangenticTyped(lookup, SESSION_ID + '-gone', designContract);
    expect(lastUserMessage(hoisted.database, SESSION_ID + '-gone', ['signed off'])).toEqual({ readable: false });

    forgetTypedMessageSession(SESSION_ID + '-gone');
    insertSession(hoisted.database!, SESSION_ID + '-gone');
    recordKangenticTyped(lookup, SESSION_ID + '-gone', designContract);

    expect(lastUserMessage(hoisted.database, SESSION_ID + '-gone', [designContract, 'signed off'])).toEqual({ readable: true, message: 'signed off' });
  });

  it('forgets only the session named, so another session stays unreadable', () => {
    recordKangenticTyped(lookup, 'session-no-row-a', designContract);
    recordKangenticTyped(lookup, 'session-no-row-b', designContract);
    forgetTypedMessageSession('session-no-row-a');
    expect(lastUserMessage(hoisted.database, 'session-no-row-a', ['signed off'])).toEqual({ readable: true, message: 'signed off' });
    expect(lastUserMessage(hoisted.database, 'session-no-row-b', ['signed off'])).toEqual({ readable: false });
  });

  it('forgetting a session that was never marked changes nothing', () => {
    forgetTypedMessageSession('session-never-marked');
    expect(lastUserMessage(hoisted.database, SESSION_ID, ['signed off'])).toEqual({ readable: true, message: 'signed off' });
  });

  // The transcript holds the text as the agent saw it, so the record matches on normalized words.
  it('drops a recorded message however it is cased or spaced, and returns the latest one that was not recorded', () => {
    recordKangenticTyped(lookup, SESSION_ID, 'Please   continue\nwith the CANVAS.');
    const read = lastUserMessage(hoisted.database, SESSION_ID, [
      'first thoughts',
      'the owner said: signed off',
      'please continue with the canvas',
      '...',
    ]);
    expect(read).toEqual({ readable: true, message: 'the owner said: signed off' });
  });

  it('returns no message when every one was recorded', () => {
    recordKangenticTyped(lookup, SESSION_ID, 'one');
    recordKangenticTyped(lookup, SESSION_ID, 'two');
    expect(lastUserMessage(hoisted.database, SESSION_ID, ['one', 'two'])).toEqual({ readable: true, message: null });
  });

  it('never reads a message that matches no pattern as met, nor an unreadable one', () => {
    expect(matchUserMessage(onToPlanningPatterns, { readable: false }).met).toBe(false);
    expect(matchUserMessage(onToPlanningPatterns, { readable: true, message: null }).met).toBe(false);
  });
});

describe('the record', () => {
  it('keeps only a session\'s newest records', () => {
    const repository = new SessionTypedMessageRepository(hoisted.database!);
    for (let index = 0; index < TYPED_MESSAGES_KEPT_PER_SESSION + 5; index += 1) repository.record(SESSION_ID, `message ${index}`);
    expect(repository.keysForSession(SESSION_ID).size).toBe(TYPED_MESSAGES_KEPT_PER_SESSION);
  });

  // The prune keeps the NEWEST rows. A prune that kept the oldest would forget the contract Kangentic
  // typed last, and a long session's latest column message would then read as the user's own.
  describe('pruning keeps the newest records', () => {
    const TOTAL = TYPED_MESSAGES_KEPT_PER_SESSION + 5;
    const textFor = (index: number): string => `typed message number ${index}`;

    function expectOnlyNewestKept(): void {
      const keys = new SessionTypedMessageRepository(hoisted.database!).keysForSession(SESSION_ID);
      expect(keys.size).toBe(TYPED_MESSAGES_KEPT_PER_SESSION);
      for (let index = 0; index < 5; index += 1) {
        expect(keys.has(typedMessageKey(textFor(index))!)).toBe(false);
      }
      for (let index = 5; index < TOTAL; index += 1) {
        expect(keys.has(typedMessageKey(textFor(index))!)).toBe(true);
      }
    }

    it('drops the first five and keeps the last KEPT when every record has its own time', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const repository = new SessionTypedMessageRepository(hoisted.database!);
        for (let index = 0; index < TOTAL; index += 1) {
          vi.setSystemTime(new Date(Date.UTC(2026, 10, 12, 10, 0, 0, index)));
          repository.record(SESSION_ID, textFor(index));
        }
      } finally {
        vi.useRealTimers();
      }
      expectOnlyNewestKept();
    });

    it('orders by insertion when every record has the same created_at', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(Date.UTC(2026, 10, 12, 10, 0, 0, 0)));
        const repository = new SessionTypedMessageRepository(hoisted.database!);
        for (let index = 0; index < TOTAL; index += 1) repository.record(SESSION_ID, textFor(index));
        const distinctTimes = hoisted.database!.prepare('SELECT COUNT(DISTINCT created_at) AS count FROM session_typed_messages').get() as { count: number };
        expect(distinctTimes.count).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expectOnlyNewestKept();
    });

    it('prunes one session without touching another\'s records', () => {
      insertSession(hoisted.database!, 'session-other');
      const repository = new SessionTypedMessageRepository(hoisted.database!);
      repository.record('session-other', 'the other session\'s message');
      for (let index = 0; index < TOTAL; index += 1) repository.record(SESSION_ID, textFor(index));
      expect(repository.keysForSession('session-other').size).toBe(1);
    });
  });

  it('stores a hash, never the text', () => {
    new SessionTypedMessageRepository(hoisted.database!).record(SESSION_ID, designContract);
    const rows = hoisted.database!.prepare('SELECT text_hash FROM session_typed_messages').all() as Array<{ text_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].text_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
