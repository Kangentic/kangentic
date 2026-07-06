import { describe, it, expect } from 'vitest';
import { chunkTranscript, CHUNKER_VERSION } from '../../src/main/retrieval/conversation/transcript-chunker';
import type { TranscriptEntry, TranscriptBlock } from '../../src/shared/types';

/**
 * The transcript chunker greedily accumulates rendered conversation fragments
 * into ~400-token chunks (MAX 480, MIN 60), splitting oversize single fragments
 * and merging a trailing sub-MIN chunk backward. These tests assert the shape
 * contract (dense seq, window bounds, anchors, roles, sanitization) against the
 * real algorithm - hashes are checked for stability, never pinned to a literal.
 */

// Mirrors the private MAX_TOKENS window in transcript-chunker.ts.
const MAX_TOKENS = 480;

function userEntry(uuid: string, text: string, ts = 1000): TranscriptEntry {
  return { kind: 'user', uuid, ts, text };
}
function assistantEntry(uuid: string, blocks: TranscriptBlock[], ts = 2000): TranscriptEntry {
  return { kind: 'assistant', uuid, ts, blocks };
}
function toolResultEntry(uuid: string, content: string, isError = false, ts = 3000): TranscriptEntry {
  return { kind: 'tool_result', uuid, ts, toolUseId: 'tu-1', content, isError };
}

describe('CHUNKER_VERSION', () => {
  it('is a positive integer used to invalidate stored chunks on change', () => {
    expect(Number.isInteger(CHUNKER_VERSION)).toBe(true);
    expect(CHUNKER_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('chunkTranscript - shape contract', () => {
  it('assigns dense seq 0..n and keeps every chunk within the MAX window', () => {
    // Three ~400-token user turns each flush to their own chunk.
    const entries = [
      userEntry('u1', 'A'.repeat(1600)),
      userEntry('u2', 'B'.repeat(1600)),
      userEntry('u3', 'C'.repeat(1600)),
    ];
    const chunks = chunkTranscript(entries);

    expect(chunks.length).toBe(3);
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(MAX_TOKENS);
      expect(chunk.role).toBe('user');
    }
  });

  it('is deterministic: identical input yields identical seq/text/hash', () => {
    const entries = [
      userEntry('u1', 'hello world '.repeat(30)),
      assistantEntry('a1', [{ type: 'text', text: 'a reply '.repeat(30) }]),
      toolResultEntry('t1', 'some output '.repeat(20)),
    ];
    const first = chunkTranscript(entries);
    const second = chunkTranscript(entries);

    expect(second).toEqual(first);
    // Explicit hash-stability assertion without pinning the literal value.
    expect(second.map((chunk) => chunk.contentHash)).toEqual(
      first.map((chunk) => chunk.contentHash),
    );
  });

  it('merges a trailing sub-MIN chunk backward into its predecessor', () => {
    // u1 renders one ~400-token chunk; u2 renders a tiny <MIN trailing chunk
    // that must fold back, collapsing two chunks into one spanning both turns.
    const entries = [
      userEntry('u1', 'A'.repeat(1600)),
      userEntry('u2', 'B'.repeat(100)),
    ];
    const chunks = chunkTranscript(entries);

    expect(chunks.length).toBe(1);
    const merged = chunks[0];
    expect(merged.seq).toBe(0);
    expect(merged.tokenEstimate).toBeLessThanOrEqual(MAX_TOKENS);
    // The merged chunk spans from the first turn's anchor to the last turn's.
    expect(merged.turnUuidStart).toBe('u1');
    expect(merged.turnUuidEnd).toBe('u2');
    // Both turns' text is preserved.
    expect(merged.text).toContain('A'.repeat(20));
    expect(merged.text).toContain('B'.repeat(20));
  });

  it('splits one oversize user turn into multiple chunks that all carry that turn uuid', () => {
    // A single ~1500-token turn (no sentence/paragraph breaks) must hard-split.
    const entries = [userEntry('big', 'x'.repeat(6000))];
    const chunks = chunkTranscript(entries);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(MAX_TOKENS);
      // Every split piece keeps the source turn's anchors.
      expect(chunk.turnUuidStart).toBe('big');
      expect(chunk.turnUuidEnd).toBe('big');
      expect(chunk.tsStart).toBe(1000);
    }
    // Dense seq across the split pieces.
    expect(chunks.map((chunk) => chunk.seq)).toEqual(
      chunks.map((_, index) => index),
    );
  });
});

describe('chunkTranscript - pre-flush guard', () => {
  it('flushes before folding in a fragment that would push the already-past-MIN accumulator over MAX', () => {
    // u1 renders to ~202 tokens ("User: " + 800 chars): strictly between
    // MIN(60) and TARGET(400), so it neither trailing-merges nor eager-flushes
    // on its own. u2 renders to ~352 tokens on its own ("User: " + 1400
    // chars), under MAX(480) so the oversize splitter never explodes it - but
    // folding it into the still-open accumulator would land at ~554 tokens,
    // over MAX. The pre-flush guard must flush u1's chunk BEFORE accepting u2,
    // instead of merging both into one oversize chunk.
    const entries = [
      userEntry('u1', 'A'.repeat(800)),
      userEntry('u2', 'B'.repeat(1400)),
    ];
    const chunks = chunkTranscript(entries);

    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(MAX_TOKENS);
    }
    // The boundary lands cleanly between the two turns: u1 alone in the first
    // chunk, u2 alone in the second - never merged into one oversize chunk.
    expect(chunks[0].turnUuidStart).toBe('u1');
    expect(chunks[0].turnUuidEnd).toBe('u1');
    expect(chunks[0].text).toContain('A'.repeat(20));
    expect(chunks[0].text).not.toContain('B');
    expect(chunks[1].turnUuidStart).toBe('u2');
    expect(chunks[1].turnUuidEnd).toBe('u2');
    expect(chunks[1].text).toContain('B'.repeat(20));
    expect(chunks[1].text).not.toContain('A');
  });
});

describe('chunkTranscript - roles', () => {
  it('labels a single-role chunk with that role', () => {
    const chunks = chunkTranscript([userEntry('u1', 'A'.repeat(1600))]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].role).toBe('user');
  });

  it("labels an evenly mixed chunk 'mixed'", () => {
    // One small user fragment + one small assistant fragment accumulate into a
    // single chunk with a 1:1 role split -> dominantRole returns 'mixed'.
    const entries = [
      userEntry('u1', 'short question'),
      assistantEntry('a1', [{ type: 'text', text: 'short answer' }]),
    ];
    const chunks = chunkTranscript(entries);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].role).toBe('mixed');
  });

  it('picks the strict-majority role when one role dominates', () => {
    // Two assistant fragments (text + thinking) + one user fragment in one
    // chunk -> assistant wins 2:1.
    const entries = [
      assistantEntry('a1', [
        { type: 'text', text: 'answer part' },
        { type: 'thinking', text: 'reasoning part' },
      ]),
      userEntry('u1', 'follow up'),
    ];
    const chunks = chunkTranscript(entries);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].role).toBe('assistant');
  });
});

describe('chunkTranscript - fragment rendering', () => {
  it('includes assistant thinking text with its labeled prefix', () => {
    const entries = [
      assistantEntry('a1', [{ type: 'thinking', text: 'DEEP_HIDDEN_THOUGHT' }]),
    ];
    const chunks = chunkTranscript(entries);
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    expect(joined).toContain('Assistant (thinking):');
    expect(joined).toContain('DEEP_HIDDEN_THOUGHT');
  });

  it('renders a tool_use block as a "Tool:" fragment with the tool name', () => {
    const entries = [
      assistantEntry('a1', [
        { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls -la' } },
      ]),
    ];
    const chunks = chunkTranscript(entries);
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    expect(joined).toContain('Tool: Bash');
    // The summarized input is folded onto the same fragment.
    expect(joined).toContain('ls -la');
  });

  it('renders a tool_result and strips embedded ANSI escapes', () => {
    // Raw terminal colour codes must not survive into the indexed text.
    const ansiBody = 'before[31mRED[0mafter';
    const entries = [toolResultEntry('t1', ansiBody)];
    const chunks = chunkTranscript(entries);
    const joined = chunks.map((chunk) => chunk.text).join('\n');

    expect(joined).toContain('Tool result:');
    expect(joined).toContain('beforeREDafter');
    // No escape byte and no CSI parameter remnant leaked through.
    expect(joined).not.toContain('');
    expect(joined).not.toContain('[31m');
  });

  it('labels a tool error result distinctly from a success result', () => {
    const chunks = chunkTranscript([toolResultEntry('t1', 'boom', true)]);
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    expect(joined).toContain('Tool error:');
    expect(joined).not.toContain('Tool result:');
  });

  it('drops turns that render to empty (whitespace-only) text', () => {
    const chunks = chunkTranscript([userEntry('blank', '   \n  \t ')]);
    expect(chunks).toEqual([]);
  });

  it("renders a 'system' kind entry (rather than silently dropping it), labeled with its subtype and role", () => {
    const entries: TranscriptEntry[] = [
      { kind: 'system', uuid: 'sys-1', ts: 5000, subtype: 'command', text: 'RUN_MARKER echo hello' },
    ];
    const chunks = chunkTranscript(entries);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].role).toBe('system');
    expect(chunks[0].text).toContain('[command]: RUN_MARKER echo hello');
  });

  it('truncates a tool_use input summary over 200 chars with an ellipsis marker', () => {
    const bigCommand = 'y'.repeat(300);
    const entries = [
      assistantEntry('a1', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: bigCommand } }]),
    ];
    const chunks = chunkTranscript(entries);
    const joined = chunks.map((chunk) => chunk.text).join('\n');

    expect(joined).toContain('Tool: Bash');
    expect(joined).toContain('…');
    expect(joined).not.toContain('y'.repeat(300));
  });

  it("summarizeToolInput falls back to '' when JSON.stringify throws on a circular input, rendering just the tool name", () => {
    const circularInput: Record<string, unknown> = {};
    circularInput.self = circularInput;
    const entries = [
      assistantEntry('a1', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: circularInput }]),
    ];
    const chunks = chunkTranscript(entries);
    const joined = chunks.map((chunk) => chunk.text).join('\n');

    // No trailing summary text is appended when JSON.stringify throws - just
    // the bare tool name.
    expect(joined.trim()).toBe('Tool: Bash');
  });
});

describe('chunkTranscript - splitOversizeText branches (via an oversize fragment)', () => {
  it('splits an oversize paragraph-structured text on paragraph boundaries, never mixing two paragraphs into one piece', () => {
    // Three ~1000-char paragraphs (no sentence punctuation at all), separated
    // by blank lines. Each paragraph individually fits under MAX_CHARS, so
    // the paragraph-split branch pushes each whole; a hard-character-window
    // fallback (no paragraph awareness) would instead cut every ~1920 chars
    // with a 200-char overlap, freely mixing content across paragraphs.
    const paragraphOne = `PARA_ONE_START ${'a'.repeat(1000)} PARA_ONE_END`;
    const paragraphTwo = `PARA_TWO_START ${'b'.repeat(1000)} PARA_TWO_END`;
    const paragraphThree = `PARA_THREE_START ${'c'.repeat(1000)} PARA_THREE_END`;
    const text = [paragraphOne, paragraphTwo, paragraphThree].join('\n\n');
    const entries = [userEntry('u1', text)];

    const chunks = chunkTranscript(entries);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(MAX_TOKENS);
    }

    const chunkFor = (marker: string) => chunks.find((chunk) => chunk.text.includes(marker));
    const chunkOne = chunkFor('PARA_ONE_START');
    const chunkTwo = chunkFor('PARA_TWO_START');
    const chunkThree = chunkFor('PARA_THREE_START');
    expect(chunkOne).toBeDefined();
    expect(chunkTwo).toBeDefined();
    expect(chunkThree).toBeDefined();
    expect(chunkOne!.text).toContain('PARA_ONE_END');
    expect(chunkTwo!.text).toContain('PARA_TWO_END');
    expect(chunkThree!.text).toContain('PARA_THREE_END');
    // No cross-contamination between paragraphs.
    expect(chunkOne!.text).not.toContain('PARA_TWO_START');
    expect(chunkOne!.text).not.toContain('PARA_THREE_START');
    expect(chunkTwo!.text).not.toContain('PARA_ONE_START');
    expect(chunkTwo!.text).not.toContain('PARA_THREE_START');
    expect(chunkThree!.text).not.toContain('PARA_ONE_START');
    expect(chunkThree!.text).not.toContain('PARA_TWO_START');
  });

  it('splits an oversize single-paragraph text on sentence boundaries, preserving every sentence exactly once', () => {
    // 60 short punctuated sentences with no blank lines, so the paragraph
    // branch is a no-op (one giant "paragraph") and the sentence-split loop
    // must do the work. Clean sentence-boundary splitting keeps every
    // "Sentence number NNN" marker intact and unique; a hard-window fallback
    // (200-char overlap, no punctuation awareness) would duplicate a marker
    // caught in the overlap zone or cut one in half, breaking the exact count.
    const sentenceCount = 60;
    const sentences = Array.from(
      { length: sentenceCount },
      (_, index) => `Sentence number ${String(index).padStart(3, '0')} padding text to add bulk.`,
    );
    const text = sentences.join(' ');
    const entries = [userEntry('u1', text)];

    const chunks = chunkTranscript(entries);

    expect(chunks.length).toBeGreaterThan(1);
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    const matches = joined.match(/Sentence number \d{3}/g) ?? [];
    expect(matches.length).toBe(sentenceCount);
    expect(new Set(matches).size).toBe(sentenceCount);
  });
});
