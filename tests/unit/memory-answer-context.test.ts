/**
 * What Ask sends the agent: which retrieved passages fit the budget, and the
 * prompt built from them.
 *
 * Both halves are pure, which is the point of the split - the quality of an
 * answer is decided here, and it can be checked without spawning a CLI.
 */

import { describe, it, expect } from 'vitest';
import {
  selectAnswerSources,
  ANSWER_TOKEN_BUDGET,
  MAX_ANSWER_SOURCES,
} from '../../src/main/retrieval/answer-context';
import { buildAnswerPrompt } from '../../src/main/retrieval/answer-prompt';
import type { StoredChunk } from '../../src/main/retrieval/types';
import type { TranscriptSearchHit } from '../../src/main/retrieval/memory-search';

/** Measured on the real corpus: a chunk averages 394 tokens. */
const TYPICAL_TOKENS = 394;

function hit(chunkId: number, overrides: Partial<TranscriptSearchHit> = {}): TranscriptSearchHit {
  return {
    chunkId,
    projectId: 'project',
    projectName: 'Project',
    sessionId: `session-${chunkId}`,
    taskId: `task-${chunkId}`,
    taskTitle: `Conversation ${chunkId}`,
    agentName: 'Claude Code',
    role: 'user',
    turnUuid: null,
    turnTs: null,
    snippet: 'snippet',
    matchStart: 0,
    matchEnd: 0,
    score: 0.5,
    matchKind: 'hybrid',
    matchCount: 1,
    ...overrides,
  };
}

function chunk(id: number, overrides: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id,
    corpus: 'conversation',
    docId: `doc-${id}`,
    sessionId: `session-${id}`,
    taskId: `task-${id}`,
    agentSessionId: `agent-${id}`,
    embeddedModel: 'bge-large@q8-cls',
    seq: 0,
    text: `Passage ${id}`,
    contentHash: `hash-${id}`,
    tokenEstimate: TYPICAL_TOKENS,
    role: 'user',
    tsStart: 1_760_000_000_000,
    tsEnd: 1_760_000_000_000,
    turnUuidStart: null,
    turnUuidEnd: null,
    ...overrides,
  };
}

function chunkMap(chunks: StoredChunk[]): Map<number, StoredChunk> {
  return new Map(chunks.map((entry) => [entry.id, entry]));
}

describe('answer context selection', () => {
  it('takes hits in retrieval order and numbers them for citation', () => {
    const hits = [hit(3), hit(1), hit(2)];
    const context = selectAnswerSources(hits, chunkMap([chunk(1), chunk(2), chunk(3)]));
    expect(context.sources.map((source) => source.index)).toEqual([1, 2, 3]);
    // The NUMBER is the citation handle and follows retrieval order, not chunk id.
    expect(context.sources.map((source) => source.text)).toEqual(['Passage 3', 'Passage 1', 'Passage 2']);
    expect(context.droppedConversations).toBe(0);
  });

  it('stops at the token budget and says how many it could not carry', () => {
    // Twice what the budget can hold, at the corpus's own average chunk size.
    const count = Math.ceil((ANSWER_TOKEN_BUDGET / TYPICAL_TOKENS) * 2);
    const hits = Array.from({ length: count }, (_unused, index) => hit(index + 1));
    const chunks = Array.from({ length: count }, (_unused, index) => chunk(index + 1));
    const context = selectAnswerSources(hits, chunkMap(chunks), { maxSources: count });

    expect(context.usedTokens).toBeLessThanOrEqual(ANSWER_TOKEN_BUDGET);
    expect(context.sources.length).toBeLessThan(count);
    // Every hit is accounted for: carried, or counted as dropped.
    expect(context.sources.length + context.droppedConversations).toBe(count);
  });

  it('skips one oversized passage rather than ending the selection behind it', () => {
    // Chunk sizes are tightly grouped, so an outlier near the front would
    // otherwise cost every ordinary passage that still fits after it.
    const hits = [hit(1), hit(2), hit(3)];
    const chunks = [
      chunk(1, { tokenEstimate: ANSWER_TOKEN_BUDGET * 2, text: 'Enormous' }),
      chunk(2),
      chunk(3),
    ];
    const context = selectAnswerSources(hits, chunkMap(chunks));
    expect(context.sources.map((source) => source.text)).toEqual(['Passage 2', 'Passage 3']);
    expect(context.droppedConversations).toBe(1);
  });

  it('caps the number of conversations even when the budget would allow more', () => {
    // An answer citing fifty sources is not an answer, so the source count is a
    // second bound in the unit the reader cares about.
    const count = MAX_ANSWER_SOURCES + 10;
    const hits = Array.from({ length: count }, (_unused, index) => hit(index + 1));
    const chunks = Array.from({ length: count }, (_unused, index) => chunk(index + 1, { tokenEstimate: 1 }));
    const context = selectAnswerSources(hits, chunkMap(chunks), { budgetTokens: 1_000_000 });
    expect(context.sources).toHaveLength(MAX_ANSWER_SOURCES);
    expect(context.droppedConversations).toBe(10);
  });

  it('skips a hit whose chunk has gone without counting it as budget pressure', () => {
    // The index is rebuilt incrementally, so a chunk can be deleted between the
    // search and this read. That is a race, not a reason to fail an answer.
    const context = selectAnswerSources([hit(1), hit(2)], chunkMap([chunk(2)]));
    expect(context.sources).toHaveLength(1);
    expect(context.droppedConversations).toBe(0);
  });

  it('falls back to a character estimate when a chunk carries no token count', () => {
    const context = selectAnswerSources(
      [hit(1)],
      chunkMap([chunk(1, { tokenEstimate: 0, text: 'x'.repeat(400) })]),
    );
    expect(context.usedTokens).toBe(100);
  });
});

describe('the answer prompt', () => {
  it('numbers every excerpt and asks for those numbers back', () => {
    const context = selectAnswerSources([hit(1), hit(2)], chunkMap([chunk(1), chunk(2)]));
    const prompt = buildAnswerPrompt('Why did we drop the sphere fit?', context.sources);

    expect(prompt).toContain('[1] Conversation 1');
    expect(prompt).toContain('[2] Conversation 2');
    expect(prompt).toContain('Passage 1');
    expect(prompt).toContain('Question: Why did we drop the sphere fit?');
    // The citation instruction has to name the SHAPE, or the answer cites titles.
    expect(prompt).toMatch(/\[3\] or \[1\]\[4\]/);
    // And the refusal has to be offered, or a question the excerpts do not cover
    // gets answered from the model's own knowledge of the codebase.
    expect(prompt).toMatch(/do not answer the question, say so/i);
  });

  it('states corroboration only where there is some', () => {
    const context = selectAnswerSources(
      [hit(1, { matchCount: 7 }), hit(2, { matchCount: 1 })],
      chunkMap([chunk(1), chunk(2)]),
    );
    const prompt = buildAnswerPrompt('anything', context.sources);
    expect(prompt).toContain('matched in 7 passages');
    // Not "matched in 1 passages", and not a bare "1" the model has to interpret.
    expect(prompt).not.toContain('matched in 1 passages');
  });

  it('dates an excerpt, and says so plainly when it cannot', () => {
    const context = selectAnswerSources(
      [hit(1), hit(2)],
      chunkMap([
        chunk(1, { tsStart: Date.UTC(2026, 2, 12), tsEnd: Date.UTC(2026, 2, 12) }),
        chunk(2, { tsStart: null, tsEnd: null }),
      ]),
    );
    const prompt = buildAnswerPrompt('anything', context.sources);
    expect(prompt).toContain('2026-03-12');
    expect(prompt).toContain('date unknown');
  });

  it('truncates one runaway passage rather than letting it crowd the rest out', () => {
    const context = selectAnswerSources(
      [hit(1), hit(2)],
      chunkMap([chunk(1, { text: 'y'.repeat(20_000), tokenEstimate: 10 }), chunk(2)]),
    );
    const prompt = buildAnswerPrompt('anything', context.sources);
    expect(prompt).toContain('Passage 2');
    expect(prompt.length).toBeLessThan(6_000);
  });
});
