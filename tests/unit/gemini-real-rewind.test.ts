/**
 * Replays a real Gemini CLI 0.66.0 chat file (tests/fixtures/gemini-real-rewind.jsonl,
 * home paths replaced with placeholders). It was written by
 * `gemini --session-id 7c3f9a12-4b5e-4d6a-9f21-0e8b7d6c5a43 -p "..."` on Windows
 * while the API answered 503 to every retry. The CLI then wrote
 * `$rewindTo: <the prompt's id>` to drop the unanswered prompt, so the file is
 * a real sample of the rewind record and of the name the CLI gives a chat
 * started under a chosen id (`session-2026-11-04T01-39-7c3f9a12.jsonl`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGeminiTranscript, parseGeminiTranscriptWindow } from '../../src/main/agent/adapters/gemini/transcript-parser';
import { geminiChatFilePattern } from '../../src/main/agent/adapters/gemini/session-history-parser';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'gemini-real-rewind.jsonl');
const SESSION_ID = '7c3f9a12-4b5e-4d6a-9f21-0e8b7d6c5a43';
const PROMPT_TEXT = 'Use your file reading tool to read notes.txt';
const REAL_FILE_NAME = 'session-2026-11-04T01-39-7c3f9a12.jsonl';

const temporaryDirectories: string[] = [];

function copyFixture(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-real-rewind-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, REAL_FILE_NAME);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('a real Gemini chat file with a $rewindTo record', () => {
  it('names the chat for the chosen id, so the readers find it by that id', () => {
    expect(geminiChatFilePattern(SESSION_ID).test(REAL_FILE_NAME)).toBe(true);
  });

  it('drops the rewound prompt from the transcript', async () => {
    const filePath = copyFixture(fs.readFileSync(FIXTURE, 'utf8'));
    const entries = await parseGeminiTranscript(SESSION_ID, filePath);
    const texts = entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []));
    expect(texts.some((text) => text.includes(PROMPT_TEXT))).toBe(false);
  });

  it('shows the prompt when the rewind line is absent, so the drop is the rewind', async () => {
    const withoutRewind = fs.readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter((line) => !line.includes('"$rewindTo"'))
      .join('\n');
    const filePath = copyFixture(withoutRewind);
    const entries = await parseGeminiTranscript(SESSION_ID, filePath);
    const texts = entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []));
    expect(texts.some((text) => text.includes(PROMPT_TEXT))).toBe(true);
  });

  it('drops the rewound prompt from a window read too', async () => {
    const filePath = copyFixture(fs.readFileSync(FIXTURE, 'utf8'));
    const window = await parseGeminiTranscriptWindow(SESSION_ID, filePath, 0, 1024 * 1024);
    const texts = window.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []));
    expect(texts.some((text) => text.includes(PROMPT_TEXT))).toBe(false);
  });
});
