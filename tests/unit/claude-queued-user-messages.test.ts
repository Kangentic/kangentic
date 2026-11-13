/**
 * `readClaudeQueuedUserMessages`, the file reader behind a Text match on the user's message
 * (#1078), driven over a real-shape transcript: tests/fixtures/claude-queued-command.jsonl, a
 * sanitized copy of a Claude Code 2.1.323 transcript (a user line, two human queued prompts, a
 * subagent hand-back, a task notification, and a final truncated line).
 *
 * What a user loses if this goes: Claude records a message typed mid-turn as a `queued_command`
 * attachment, not a user turn. A format drift that hides one would hide a mid-turn "not signed
 * off", and an earlier "signed off" would move a card it should not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queuedHumanMessageOf, readClaudeQueuedUserMessages } from '../../src/main/agent/adapters/claude/queued-user-messages';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'claude-queued-command.jsonl');
/** `QUEUED_READ_MAX_BYTES` in queued-user-messages.ts (not exported). */
const READ_CAP_BYTES = 10 * 1024 * 1024;

const EXPECTED = [
  { text: 'include what the json payload would look like as well', ts: Date.parse('2026-11-12T19:25:31.758Z') },
  { text: '"An agent judges it" above "Agent evaluation" feels a little strange', ts: Date.parse('2026-11-12T19:44:54.054Z') },
];

describe('readClaudeQueuedUserMessages over a real Claude transcript', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-queued-test-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.copyFileSync(FIXTURE, transcriptPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the two human prompts in file order, leaving out the hand-back, the notification and the truncated line', async () => {
    expect(await readClaudeQueuedUserMessages(transcriptPath, 0)).toEqual(EXPECTED);
  });

  it('returns the same two from a start offset on the newline ending the first line', async () => {
    const content = fs.readFileSync(transcriptPath);
    const firstNewline = content.indexOf(0x0a);
    expect(firstNewline).toBeGreaterThan(0);
    expect(await readClaudeQueuedUserMessages(transcriptPath, firstNewline)).toEqual(EXPECTED);
  });

  it('answers null for no path', async () => {
    expect(await readClaudeQueuedUserMessages(null, 0)).toBeNull();
  });

  it('answers null for a file that is gone, never an empty list', async () => {
    // readJsonlWindow answers an open failure with an empty window; an empty list here would
    // read as "no message typed mid-turn" and let the turn's first message stand.
    expect(await readClaudeQueuedUserMessages(path.join(path.dirname(transcriptPath), 'missing.jsonl'), 0)).toBeNull();
  });

  it('answers null when the bytes past the start exceed the read cap (the end cannot be reached)', async () => {
    const original = fs.readFileSync(transcriptPath);
    fs.writeFileSync(transcriptPath, Buffer.concat([original, Buffer.alloc(READ_CAP_BYTES + 1024, 0x78)]));
    expect(await readClaudeQueuedUserMessages(transcriptPath, 0)).toBeNull();
  });
});

describe('queuedHumanMessageOf over each fixture line', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0);

  function parsedOrNull(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  it('reads the two human prompts and nothing else', () => {
    const results = lines.map((line) => queuedHumanMessageOf(parsedOrNull(line)));
    expect(results).toEqual([null, EXPECTED[0], null, null, EXPECTED[1], null]);
  });
});
