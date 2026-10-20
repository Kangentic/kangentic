/**
 * extractPastedTranscript (tests/captures/helpers/message-trail-extract.ts) finds the Claude
 * history a Browser pane Send went into. The send resumes a finished conversation, so the history's
 * first user message is the ORIGINAL task and the prompt match extractTranscript uses cannot find
 * it. Instead the function looks for the one history file holding a user entry that carries the
 * pasted note and was written inside the recording's span. It had no test, and every way of
 * getting it wrong fails quietly: counting an assistant entry that quotes the note, counting a
 * note from an earlier or later run, or accepting two files, would each hand the send a trail
 * that is not the one the capture recorded.
 *
 * The history lives under `~/.claude/projects/<slug>/`, so `os.homedir()` is mocked to a temp home
 * (the seam locate-transcript-source.test.ts uses) and the real parser reads real JSONL lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import { TranscriptMatchError, extractPastedTranscript } from '../captures/helpers/message-trail-extract';

const CWD = '/home/dev/work/contoso-web';
const OTHER_CWD = '/home/dev/work/another-project';
const CAPTURED_AT = '2026-01-01T00:20:00.000Z';
const CAPTURED_AT_MS = Date.parse(CAPTURED_AT);
const DURATION_MS = 10 * 60 * 1000;
const START_MS = CAPTURED_AT_MS - DURATION_MS;
const HOUR_MS = 60 * 60 * 1000;

const ORIGINAL_TASK = 'add pagination to the orders table and cover it with a test';
const NOTE = 'Add rate limiting to the middleware';
const PASTED_TEXT = `${NOTE}\n<browser_context>\nscreenshot: page.png\n</browser_context>`;

type HistoryLine = { role: 'user' | 'assistant'; atMs: number; text: string };

/** One Claude history line, in the shape the real transcript parser reads. */
function historyLine(line: HistoryLine, index: number): string {
  const uuid = `${line.role}-${index}`;
  const timestamp = new Date(line.atMs).toISOString();
  if (line.role === 'user') {
    return JSON.stringify({ type: 'user', uuid, timestamp, message: { role: 'user', content: line.text } });
  }
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp,
    message: { id: `msg-${index}`, role: 'assistant', content: [{ type: 'text', text: line.text }] },
  });
}

describe('extractPastedTranscript', () => {
  let temporaryHome: string;
  let projectDirectory: string;

  const writeHistory = (fileName: string, lines: HistoryLine[], directory: string = projectDirectory): string => {
    const historyPath = path.join(directory, fileName);
    fs.writeFileSync(historyPath, `${lines.map(historyLine).join('\n')}\n`);
    return historyPath;
  };

  const facts = (pastedText: string = PASTED_TEXT): { pastedText: string; capturedAt: string; durationMs: number } => ({
    pastedText,
    capturedAt: CAPTURED_AT,
    durationMs: DURATION_MS,
  });

  /** A resumed conversation: the original task long before the window, then the note inside it. */
  const resumedConversation = (noteAtMs: number): HistoryLine[] => [
    { role: 'user', atMs: START_MS - 3 * HOUR_MS, text: ORIGINAL_TASK },
    { role: 'assistant', atMs: START_MS - 3 * HOUR_MS + 1000, text: 'Done. Pagination added.' },
    { role: 'user', atMs: noteAtMs, text: PASTED_TEXT },
    { role: 'assistant', atMs: noteAtMs + 1000, text: 'Rate limiting is in place.' },
  ];

  beforeEach(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-pasted-transcript-'));
    vi.spyOn(os, 'homedir').mockReturnValue(temporaryHome);
    projectDirectory = path.join(temporaryHome, '.claude', 'projects', claudeProjectSlug(CWD));
    fs.mkdirSync(projectDirectory, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });

  it('returns the one history whose user entry carries the note inside the window, whole, with the run start', async () => {
    const target = writeHistory('target.jsonl', resumedConversation(START_MS + 5000));
    // Decoys: a conversation with no note at all, and one with a user entry inside the window
    // whose text is something else. Neither may be counted as a second match.
    writeHistory('untouched.jsonl', [{ role: 'user', atMs: START_MS - 2 * HOUR_MS, text: ORIGINAL_TASK }]);
    writeHistory('other-turn.jsonl', [{ role: 'user', atMs: START_MS + 8000, text: 'Rename the billing module' }]);

    const extracted = await extractPastedTranscript(facts(), CWD);

    expect(extracted.sourcePath).toBe(target);
    expect(extracted.startMs).toBe(CAPTURED_AT_MS - DURATION_MS);
    // The whole history comes back, not only the entries inside the window: the reprinted
    // conversation is older, and the trail builder drops what predates the capture itself.
    expect(extracted.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const userTexts = extracted.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []));
    expect(userTexts).toEqual([ORIGINAL_TASK, PASTED_TEXT]);
  });

  it.each([
    ['the first millisecond of the capture', START_MS],
    ['the last millisecond of the capture', CAPTURED_AT_MS],
  ])('counts a note written at %s, since the window is closed at both ends', async (_label, noteAtMs) => {
    const target = writeHistory('target.jsonl', resumedConversation(noteAtMs));

    const extracted = await extractPastedTranscript(facts(), CWD);

    expect(extracted.sourcePath).toBe(target);
  });

  it.each([
    ['one millisecond before the capture began', START_MS - 1],
    ['a day before the capture, as a reprinted conversation would carry it', START_MS - 24 * HOUR_MS],
    ['one millisecond after the capture ended', CAPTURED_AT_MS + 1],
  ])('does not count a note written %s', async (_label, noteAtMs) => {
    writeHistory('outside.jsonl', resumedConversation(noteAtMs));

    const thrown = await extractPastedTranscript(facts(), CWD).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toMatch(/0 claude transcript/);
  });

  it('does not count an assistant entry that carries the note, only a user entry', async () => {
    writeHistory('assistant-quote.jsonl', [
      { role: 'user', atMs: START_MS - 3 * HOUR_MS, text: ORIGINAL_TASK },
      { role: 'assistant', atMs: START_MS + 5000, text: `You asked: ${PASTED_TEXT}` },
    ]);

    const thrown = await extractPastedTranscript(facts(), CWD).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toMatch(/0 claude transcript/);
  });

  it('throws when two histories both received the note inside the window, rather than picking one', async () => {
    writeHistory('first.jsonl', resumedConversation(START_MS + 5000));
    writeHistory('second.jsonl', resumedConversation(START_MS + 9000));

    const thrown = await extractPastedTranscript(facts(), CWD).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toMatch(/2 claude transcript/);
    expect((thrown as Error).message).toMatch(/expected one/);
  });

  it('matches the note without regard to case or whitespace, the way the prompt match does', async () => {
    const target = writeHistory('target.jsonl', resumedConversation(START_MS + 5000));

    const extracted = await extractPastedTranscript(facts('add   RATE limiting\nto the middleware'), CWD);

    expect(extracted.sourcePath).toBe(target);
  });

  it('reads only the history of the working directory it is given', async () => {
    const otherDirectory = path.join(temporaryHome, '.claude', 'projects', claudeProjectSlug(OTHER_CWD));
    fs.mkdirSync(otherDirectory, { recursive: true });
    writeHistory('elsewhere.jsonl', resumedConversation(START_MS + 5000), otherDirectory);

    const thrown = await extractPastedTranscript(facts(), CWD).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toMatch(/0 claude transcript/);
  });

  it('ignores files that are not .jsonl histories', async () => {
    fs.writeFileSync(path.join(projectDirectory, 'notes.txt'), historyLine({ role: 'user', atMs: START_MS + 5000, text: PASTED_TEXT }, 0));

    const thrown = await extractPastedTranscript(facts(), CWD).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toMatch(/0 claude transcript/);
  });
});
