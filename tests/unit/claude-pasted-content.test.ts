/**
 * A column message Kangentic pasted never reads as the owner's message (#1138).
 *
 * Claude Code stores a bracketed paste wrapped as
 * `<pasted_content id="af6a">\n...\n</pasted_content id="af6a">`. The typed-message ledger
 * recorded the Design contract unwrapped, the transcript held it wrapped, and the keys differed,
 * so the contract's own "signed off" counted as the owner's words at a turn end. Only the column's
 * `!` patterns kept the card in Design. What a user loses if this goes: a card that moves itself
 * out of Design on its own column message.
 *
 * Real Claude transcript parse (a JSONL file on disk), real queued-message read, real ledger over
 * migrated SQLite, real matcher, and the board file's own Design rows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

const hoisted = vi.hoisted(() => ({ database: null as Database.Database | null }));
vi.mock('../../src/main/db/database', () => ({
  getOpenProjectDb: () => hoisted.database,
}));

import { parseClaudeTranscript } from '../../src/main/agent/adapters/claude/transcript-parser';
import { queuedHumanMessageOf } from '../../src/main/agent/adapters/claude/queued-user-messages';
import { unwrapPastedContent } from '../../src/main/agent/adapters/claude/pasted-content';
import { turnUserMessages } from '../../src/main/agent/shared/agent-reply';
import {
  personMessagesInTurn,
  recordKangenticTyped,
  resetTypedMessageLedgerForTest,
} from '../../src/main/automations/turn-end/typed-message-ledger';
import { matchUserMessage } from '../../src/shared/final-line-match';

const SESSION_ID = 'session-design';
const PROJECT_ID = 'project-a';

interface BoardRow { name: string; message?: string; condition?: { text?: { from: string; patterns: string[] } } }
interface BoardFile { columns: Array<{ name: string; automations?: Record<string, BoardRow[]> }> }

const board = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../kangentic.json'), 'utf8')) as BoardFile;
const design = board.columns.find((column) => column.name === 'Design');
const designContract = design?.automations?.onEnter?.find((row) => row.name === 'Design contract')?.message ?? '';
const onToPlanningPatterns = (design?.automations?.onTurnEnd?.find((row) => row.name === 'On to Planning')?.condition?.text?.patterns ?? []).join('\n');

/** Claude's wrapper around a paste, as 2.1.329 writes it. */
function wrapped(text: string, id = 'af6a'): string {
  return `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
}

function userLine(uuid: string, timestamp: string, content: string): string {
  return JSON.stringify({ type: 'user', uuid, timestamp, message: { role: 'user', content } });
}

function queuedLine(timestamp: string, prompt: string): unknown {
  return {
    type: 'attachment',
    timestamp,
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' } },
  };
}

let transcriptDir: string;

async function userMessagesOf(lines: string[]): Promise<string[]> {
  const filePath = path.join(transcriptDir, `${lines.length}-${Date.now()}.jsonl`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return turnUserMessages(await parseClaudeTranscript(filePath));
}

beforeEach(() => {
  resetTypedMessageLedgerForTest();
  hoisted.database = openMigratedProjectDatabase();
  insertTask(hoisted.database, 'task-a');
  hoisted.database.prepare(`
    INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
    VALUES (?, 'task-a', 'claude_agent', 'claude', '/mock/worktree', 'running', '2026-11-12T10:00:00.000Z')
  `).run(SESSION_ID);
  transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-pasted-content-'));
});

afterEach(() => {
  hoisted.database?.close();
  hoisted.database = null;
  fs.rmSync(transcriptDir, { recursive: true, force: true });
});

describe('the Design board rows this test reads', () => {
  it('finds the contract, which names the sign-off phrase, and the On to Planning patterns', () => {
    expect(designContract).toContain('signed off');
    expect(onToPlanningPatterns).toContain('*signed off*');
  });
});

describe('unwrapPastedContent', () => {
  it('keeps the pasted text and drops the tags, ids on both ends', () => {
    expect(unwrapPastedContent(wrapped('Line one.\nLine two.'))).toBe('Line one.\nLine two.');
  });

  it('unwraps a paste inside typed text, and each of several pastes', () => {
    const text = `Before\n${wrapped('first', 'a1')}\nbetween\n${wrapped('second', 'b2')}`;
    expect(unwrapPastedContent(text)).toBe('Before\nfirst\nbetween\nsecond');
  });

  it('accepts a wrapper with no id', () => {
    expect(unwrapPastedContent('<pasted_content>\nhello\n</pasted_content>')).toBe('hello');
  });

  it('leaves text with no wrapper, or a closing tag for another paste, alone', () => {
    expect(unwrapPastedContent('signed off')).toBe('signed off');
    const mismatched = '<pasted_content id="a1">\nhello\n</pasted_content id="b2">';
    expect(unwrapPastedContent(mismatched)).toBe(mismatched);
  });

  it('drops one CRLF inside each end of a wrapper', () => {
    expect(unwrapPastedContent('<pasted_content id="a1">\r\nhello\r\n</pasted_content id="a1">')).toBe('hello');
  });

  it('closes an opening that has an id at a closing tag that has none', () => {
    expect(unwrapPastedContent('<pasted_content id="a1">\nhello\n</pasted_content>')).toBe('hello');
  });

  it('leaves an opening tag with no closer as it is', () => {
    const unclosed = 'see <pasted_content id="a1">\nhello';
    expect(unwrapPastedContent(unclosed)).toBe(unclosed);
  });

  // The scan is one pass: a line quoting an opener many times, with no closer
  // for any of them, must not cost a rescan per opener.
  it('leaves 20000 unclosed openers as they are, without rescanning for each', () => {
    const openers = '<pasted_content id="a1">\n'.repeat(20_000);
    const withOtherClosing = `${openers}</pasted_content id="zz">`;
    const startedAt = Date.now();

    expect(unwrapPastedContent(openers)).toBe(openers);
    expect(unwrapPastedContent(withOtherClosing)).toBe(withOtherClosing);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  // Pins the current behavior: the outer wrapper closes at its own id, so the
  // inner pair, which sits inside its body, is left as text.
  it('unwraps one level of a wrapper nested in another with a different id', () => {
    const inner = '<pasted_content id="b2">\ninner\n</pasted_content id="b2">';
    const nested = `<pasted_content id="a1">\nouter ${inner} tail\n</pasted_content id="a1">`;
    expect(unwrapPastedContent(nested)).toBe(`outer ${inner} tail`);
  });
});

describe('the transcript parser around unwrapPastedContent', () => {
  it('trims blank lines around a wrapped paste', async () => {
    const messages = await userMessagesOf([userLine('u1', '2026-11-20T17:54:52.000Z', wrapped('\n\nhello\n\n'))]);
    expect(messages).toEqual(['hello']);
  });

  it('records no user entry for a wrapper around only whitespace', async () => {
    const messages = await userMessagesOf([userLine('u1', '2026-11-20T17:54:52.000Z', wrapped('  \n \t '))]);
    expect(messages).toEqual([]);
  });

  // The parser joins an array's text blocks with a newline, then unwraps the whole.
  it('unwraps a paste held in an array of text blocks', async () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-11-20T17:54:52.000Z',
      message: { role: 'user', content: [{ type: 'text', text: wrapped('Line one.\nLine two.') }] },
    });
    expect(await userMessagesOf([line])).toEqual(['Line one.\nLine two.']);
  });

  // A fresh spawn's opening is the template, a blank line, then the column
  // message, and the ledger records all of it as one Kangentic message.
  it('never reads a pasted joined opening (template, blank line, column message) as the owner\'s', async () => {
    const joinedOpening = `<task>\n  <title>Fix login flow</title>\n</task>\n\n${designContract}`;
    recordKangenticTyped({ getSession: () => ({ projectId: PROJECT_ID, taskId: 'task-a' }) }, SESSION_ID, joinedOpening);
    const messages = await userMessagesOf([userLine('u1', '2026-11-20T17:54:52.000Z', wrapped(joinedOpening))]);

    expect(messages).toEqual([joinedOpening]);
    expect(personMessagesInTurn(hoisted.database, SESSION_ID, messages)).toEqual({ readable: true, messages: [] });
  });

  // The user line's keys and nesting come from tests/fixtures/claude-queued-command.jsonl
  // (a sanitized Claude Code transcript user line); only the content is replaced by a
  // paste wrapper around neutral text. The wrapper shape was measured on Claude Code 2.1.329.
  it('unwraps the paste in a real-shape user line', async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/claude-pasted-content-user-line.jsonl');
    const messages = turnUserMessages(await parseClaudeTranscript(fixturePath));
    expect(messages).toEqual(['Review the diff.\nList every finding.']);
  });
});

describe('a turn whose user text is the Design contract Kangentic pasted', () => {
  it('reads the transcript\'s paste without the wrapper', async () => {
    const messages = await userMessagesOf([userLine('u1', '2026-11-20T17:54:52.000Z', wrapped(designContract))]);
    expect(messages).toEqual([designContract]);
  });

  it('never satisfies a Text match on the user\'s message', async () => {
    recordKangenticTyped({ getSession: () => ({ projectId: PROJECT_ID, taskId: 'task-a' }) }, SESSION_ID, designContract);
    const messages = await userMessagesOf([userLine('u1', '2026-11-20T17:54:52.000Z', wrapped(designContract))]);

    const read = personMessagesInTurn(hoisted.database, SESSION_ID, messages);

    // Red before the fix: the wrapper's words changed the key, the contract
    // stayed in as the owner's message, and its "signed off" met the match.
    expect(read).toEqual({ readable: true, messages: [] });
    expect(matchUserMessage(onToPlanningPatterns, read).met).toBe(false);
  });

  it('drops a contract that queued while Claude was mid-turn the same way', () => {
    recordKangenticTyped({ getSession: () => ({ projectId: PROJECT_ID, taskId: 'task-a' }) }, SESSION_ID, designContract);
    const queued = queuedHumanMessageOf(queuedLine('2026-11-20T17:54:52.000Z', wrapped(designContract)));

    expect(queued?.text).toBe(designContract);
    const read = personMessagesInTurn(hoisted.database, SESSION_ID, turnUserMessages([], queued ? [queued] : []));
    expect(read).toEqual({ readable: true, messages: [] });
  });

  it('still reads a person\'s own pasted sign-off as theirs', async () => {
    recordKangenticTyped({ getSession: () => ({ projectId: PROJECT_ID, taskId: 'task-a' }) }, SESSION_ID, designContract);
    const messages = await userMessagesOf([
      userLine('u1', '2026-11-20T17:54:52.000Z', wrapped(designContract)),
      userLine('u2', '2026-11-20T18:10:00.000Z', wrapped('signed off', 'c3d4')),
    ]);

    const read = personMessagesInTurn(hoisted.database, SESSION_ID, messages);

    expect(read).toEqual({ readable: true, messages: ['signed off'] });
    expect(matchUserMessage(onToPlanningPatterns, read).met).toBe(true);
  });
});
