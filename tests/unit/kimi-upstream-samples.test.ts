/**
 * Replays the Kimi Code CLI's own published wire fixtures through our readers.
 *
 * Source: `apps/vis/server/test/fixtures/sessions/sample-main/agents/main/wire.jsonl`
 * and `sample-compaction/agents/main/wire.jsonl` in github.com/MoonshotAI/kimi-code
 * at tag `@moonshot-ai/kimi-code@2.4.1` (MIT), copied byte for byte to
 * `tests/fixtures/kimi-upstream-sample-main-wire.jsonl` and
 * `kimi-upstream-sample-compaction-wire.jsonl`.
 *
 * These are the CLI's test fixtures, NOT a live capture. They are at wire
 * protocol 1.1 (our parser is written to 1.5), and hold no tool call, turn end
 * or interaction record. What they prove is that records written by the CLI's
 * own code read the way our parser assumes, which a hand-shaped fixture cannot.
 * What a user loses if this breaks: Kimi tasks showing no prompt, model, tokens
 * or conversation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWireJsonl } from '../../src/main/agent/adapters/kimi/wire-parser';
import { parseKimiTranscript } from '../../src/main/agent/adapters/kimi/transcript-parser';
import { kimiTranscriptUsage } from '../../src/main/agent/adapters/kimi/transcript-usage';
import { parseKimiSessionIndex } from '../../src/main/agent/adapters/kimi/session-index';
import { Activity, EventType } from '../../src/shared/types';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const MAIN_WIRE = path.join(FIXTURES, 'kimi-upstream-sample-main-wire.jsonl');
const COMPACTION_WIRE = path.join(FIXTURES, 'kimi-upstream-sample-compaction-wire.jsonl');
const SESSION_ID = 'session_4f1c0b2a-8d3e-4a91-9c77-2b5e6f0a1d34';

describe('the CLI\'s sample-main wire', () => {
  const content = fs.readFileSync(MAIN_WIRE, 'utf-8');

  it('reads the prompt as a Prompt event at its own time, and the turn as thinking', () => {
    const result = parseWireJsonl(content, 'full');
    expect(result.activity).toBe(Activity.Thinking);
    expect(result.events).toEqual([{ ts: 1779256800000, type: EventType.Prompt, detail: 'hi' }]);
  });

  it('reads the model from usage.record, and the step\'s tokens from step.end', () => {
    const { usage } = parseWireJsonl(content, 'full');
    expect(usage?.model).toEqual({ id: 'kimi-k2', displayName: 'kimi-k2', reportedByAgent: true });
    expect(usage?.contextWindow).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 5 });
  });

  it('folds the lifetime usage to the one step\'s 10 in and 5 out', async () => {
    await expect(kimiTranscriptUsage(MAIN_WIRE)).resolves.toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('holds the user turn and the assistant reply in the transcript', async () => {
    const entries = await parseKimiTranscript(SESSION_ID, MAIN_WIRE);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'hi', ts: 1779256800000 });
    expect(entries[1]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'hello' }], ts: 1779256800200 });
  });
});

describe('the CLI\'s sample-compaction wire', () => {
  it('carries the compaction into the transcript as a note with the CLI\'s summary', async () => {
    const entries = await parseKimiTranscript(SESSION_ID, COMPACTION_WIRE);
    const notes = entries.filter((entry) => entry.kind === 'system');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'system', subtype: 'compaction', text: 'compacted summary', ts: 1779256800500 });
  });

  it('raises no board event and no usage, since a compaction record is not one the activity parser acts on', () => {
    const result = parseWireJsonl(fs.readFileSync(COMPACTION_WIRE, 'utf-8'), 'full');
    expect(result.events).toEqual([]);
    expect(result.usage).toBeNull();
    expect(result.activity).toBeNull();
  });

  it('has no step to total', async () => {
    await expect(kimiTranscriptUsage(COMPACTION_WIRE)).resolves.toBeNull();
  });
});

// The index record shapes come from the CLI's `sessionLifecycleService.ts`
// (2.4.1), not from a captured file.
describe('the session index records the CLI writes', () => {
  it('reads a session line with its folder and working directory', () => {
    const line = JSON.stringify({ sessionId: SESSION_ID, sessionDir: '/home/dev/.kimi-code/sessions/ws/' + SESSION_ID, workDir: '/projects/my-app' });
    expect(parseKimiSessionIndex(line + '\n')).toEqual([
      { sessionId: SESSION_ID, sessionDir: '/home/dev/.kimi-code/sessions/ws/' + SESSION_ID, workDir: '/projects/my-app', deleted: false },
    ]);
  });

  it('reads a deletion line, which carries no folder or working directory', () => {
    const line = JSON.stringify({ sessionId: SESSION_ID, deleted: true });
    expect(parseKimiSessionIndex(line + '\n')).toEqual([{ sessionId: SESSION_ID, sessionDir: null, workDir: null, deleted: true }]);
  });
});
