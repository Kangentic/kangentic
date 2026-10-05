/**
 * locateTranscriptSource (tests/captures/helpers/message-trail-extract.ts) is what the Knowledge
 * Graph capture calls to find each recorded run's history: it composes `extractTranscript` (the
 * prompt and start-time match) with `agentSessionIdOf` (the agent's own session id), and the
 * capture writes both into a session row so main's indexer finds the file the way it does on the
 * desktop. Nothing called it directly.
 *
 * The Claude case runs the real parser over real JSONL files in a temp home (`os.homedir()` is
 * mocked to it, so `~/.claude/projects/<slug>/` lands there). Two sibling files carry the same
 * prompt and a third starts closest of all but carries another prompt, so only the real chooser
 * (prompt match first, then nearest start) lands on the target, and a wrong file, a wrong id, or a
 * path taken from anywhere else fails the assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import {
  AGENTS_WITHOUT_TRANSCRIPTS,
  TranscriptMatchError,
  locateTranscriptSource,
  type RecordingFacts,
} from '../captures/helpers/message-trail-extract';

const CWD = '/home/dev/work/contoso-web';
const PROMPT = 'add pagination to the orders table and cover it with a test';
const CAPTURED_AT = '2026-01-01T00:20:00.000Z';
const DURATION_MS = 10 * 60 * 1000;
const START_MS = Date.parse(CAPTURED_AT) - DURATION_MS;

const TARGET_ID = '3f9c1e52-7a4b-4d18-9c60-2b5e8a1d7f04';
const SIBLING_ID = 'b7d20c4e-91f3-4a6a-8e15-c0a7d3f29b61';
const UNRELATED_ID = '0c5a8f13-6e2d-47b9-a4d0-5f1e9b3c7a28';

/** One Claude session file: the user's prompt, then one assistant reply a second later. */
function claudeSessionFile(prompt: string, startedAtMs: number, uuidPrefix: string): string {
  const userLine = {
    type: 'user',
    uuid: `${uuidPrefix}-user`,
    timestamp: new Date(startedAtMs).toISOString(),
    message: { role: 'user', content: prompt },
  };
  const assistantLine = {
    type: 'assistant',
    uuid: `${uuidPrefix}-assistant`,
    timestamp: new Date(startedAtMs + 1000).toISOString(),
    message: { id: `msg-${uuidPrefix}`, role: 'assistant', content: [{ type: 'text', text: 'Done. Pagination added.' }] },
  };
  return `${JSON.stringify(userLine)}\n${JSON.stringify(assistantLine)}\n`;
}

describe('locateTranscriptSource', () => {
  let tempHome: string;
  let projectDirectory: string;

  const facts = (agent: string): RecordingFacts => ({
    agent,
    prompt: PROMPT,
    capturedAt: CAPTURED_AT,
    durationMs: DURATION_MS,
  });

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-locate-transcript-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    projectDirectory = path.join(tempHome, '.claude', 'projects', claudeProjectSlug(CWD));
    fs.mkdirSync(projectDirectory, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('an agent that keeps no transcript Kangentic can read', () => {
    it('lists at least one such agent, so the cases below are not an empty loop', () => {
      expect(Object.keys(AGENTS_WITHOUT_TRANSCRIPTS).length).toBeGreaterThan(0);
    });

    it.each(Object.keys(AGENTS_WITHOUT_TRANSCRIPTS))('returns null for %s instead of reading a session id off nothing', async (agent) => {
      // A Claude file sits in the temp home: a locator that ignored the agent and read it anyway
      // would return a source, not null.
      fs.writeFileSync(path.join(projectDirectory, `${TARGET_ID}.jsonl`), claudeSessionFile(PROMPT, START_MS + 2000, 'target'));

      await expect(locateTranscriptSource(facts(agent), CWD)).resolves.toBeNull();
    });
  });

  describe('a Claude recording', () => {
    it('returns the chosen file as historyPath and its basename without .jsonl as agentSessionId', async () => {
      // Same prompt, 2 s after the recording began: the target.
      fs.writeFileSync(path.join(projectDirectory, `${TARGET_ID}.jsonl`), claudeSessionFile(PROMPT, START_MS + 2000, 'target'));
      // Same prompt, but a retry 60 s later (inside the 120 s tolerance, so a real candidate, and farther).
      fs.writeFileSync(path.join(projectDirectory, `${SIBLING_ID}.jsonl`), claudeSessionFile(PROMPT, START_MS + 60_000, 'sibling'));
      // Starts at the exact millisecond the recording did, but it is another conversation.
      fs.writeFileSync(path.join(projectDirectory, `${UNRELATED_ID}.jsonl`), claudeSessionFile('rename the billing module', START_MS, 'unrelated'));

      const source = await locateTranscriptSource(facts('claude'), CWD);

      expect(source).toEqual({
        agentSessionId: TARGET_ID,
        historyPath: path.join(projectDirectory, `${TARGET_ID}.jsonl`),
      });
    });

    it('lets the match error through when no transcript carries the prompt, rather than answering null', async () => {
      fs.writeFileSync(path.join(projectDirectory, `${UNRELATED_ID}.jsonl`), claudeSessionFile('rename the billing module', START_MS, 'unrelated'));

      await expect(locateTranscriptSource(facts('claude'), CWD)).rejects.toBeInstanceOf(TranscriptMatchError);
    });
  });
});
