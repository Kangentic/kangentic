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
});
