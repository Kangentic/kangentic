/**
 * The narration tag lives inside a thinking block's signature, and Claude Code
 * decides from it whether to print the block as a message. These cases pin the
 * decoder to the CLI's: real signatures read as their kind, and anything
 * malformed reads as no kind at all, so the parser keeps today's `thinking`.
 *
 * The real signatures come from two committed fixtures: an Opus 5.5 turn whose
 * narration lines carry made-up text (the decoder never checks a signature
 * against its text), and an Opus 5 archived run whose thinking is the usual
 * empty, signature-only block.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeThinkingSignatureKind,
  isNarrationSignature,
  reportUnrecognizedTextThinking,
  resetUnrecognizedTextThinkingReportForTests,
} from '../../src/main/agent/adapters/claude/thinking-signature';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/** Every thinking block in a fixture transcript, in file order. */
function thinkingBlocksIn(fileName: string): ThinkingBlock[] {
  const blocks: ThinkingBlock[] = [];
  for (const line of fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf-8').split('\n')) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as { message?: { content?: unknown } };
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string }>) {
      if (block.type === 'thinking') blocks.push(block as ThinkingBlock);
    }
  }
  return blocks;
}

const narrationTurnBlocks = thinkingBlocksIn('claude-narration-turn.jsonl');
const realNarrationSignatures = narrationTurnBlocks.filter((block) => block.thinking.length > 0).map((block) => block.signature);
const realOpus55ThinkingSignature = narrationTurnBlocks.find((block) => block.thinking.length === 0)?.signature ?? '';
const realOpus5ThinkingSignature = thinkingBlocksIn('claude-transcript-advisor-turn.jsonl')[0]?.signature ?? '';

// A minimal protobuf writer, so each malformed case below is one visible byte change.
function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 128) {
    bytes.push((remaining % 128) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function lengthDelimited(fieldNumber: number, payload: number[]): number[] {
  return [...varint(fieldNumber * 8 + 2), ...varint(payload.length), ...payload];
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...varint(fieldNumber * 8), ...varint(value)];
}

function utf8(text: string): number[] {
  return [...Buffer.from(text, 'utf-8')];
}

/** The signature shape Claude writes: field 2 > field 1 > string field 8, beside some varints. */
function signatureBytes(...kinds: string[]): number[] {
  const metadata = [...varintField(1, 18), ...varintField(3, 2), ...kinds.flatMap((kind) => lengthDelimited(8, utf8(kind)))];
  return [...varintField(1, 4), ...lengthDelimited(2, lengthDelimited(1, metadata)), ...varintField(3, 1)];
}

function base64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

/** A fixed64 field (wire type 1): the tag, then exactly 8 payload bytes. */
function fixed64Field(fieldNumber: number): number[] {
  return [...varint(fieldNumber * 8 + 1), 1, 2, 3, 4, 5, 6, 7, 8];
}

/** A fixed32 field (wire type 5): the tag, then exactly 4 payload bytes. */
function fixed32Field(fieldNumber: number): number[] {
  return [...varint(fieldNumber * 8 + 5), 1, 2, 3, 4];
}

/** A metadata message (the inside of field 2 > field 1) that carries one kind string in field 8. */
function metadataWithKind(kind: string): number[] {
  return lengthDelimited(8, utf8(kind));
}

/** The whole signature wrapped around the given metadata messages, each as its own field 1 inside ONE field 2. */
function signatureWithMetadata(...metadataMessages: number[][]): number[] {
  return lengthDelimited(2, metadataMessages.flatMap((metadata) => lengthDelimited(1, metadata)));
}

describe('decodeThinkingSignatureKind on real signatures', () => {
  it('reads both Opus 5.5 narration signatures as narration', () => {
    expect(realNarrationSignatures).toHaveLength(2);
    for (const signature of realNarrationSignatures) {
      expect(decodeThinkingSignatureKind(signature)).toBe('narration');
      expect(isNarrationSignature(signature)).toBe(true);
    }
  });

  it('reads an Opus 5.5 and an Opus 5 thinking signature as thinking', () => {
    for (const signature of [realOpus55ThinkingSignature, realOpus5ThinkingSignature]) {
      expect(signature.length).toBeGreaterThan(0);
      expect(decodeThinkingSignatureKind(signature)).toBe('thinking');
      expect(isNarrationSignature(signature)).toBe(false);
    }
  });
});

describe('decodeThinkingSignatureKind on built signatures', () => {
  it('reads the kind from field 2 > 1 > 8', () => {
    expect(decodeThinkingSignatureKind(base64(signatureBytes('narration')))).toBe('narration');
    expect(decodeThinkingSignatureKind(base64(signatureBytes('thinking')))).toBe('thinking');
  });

  it('takes the last occurrence of a repeated field, as the CLI does', () => {
    expect(decodeThinkingSignatureKind(base64(signatureBytes('thinking', 'narration')))).toBe('narration');
    expect(decodeThinkingSignatureKind(base64(signatureBytes('narration', 'thinking')))).toBe('thinking');
  });

  it('ignores a kind string at the wrong depth', () => {
    expect(decodeThinkingSignatureKind(base64(lengthDelimited(2, lengthDelimited(8, utf8('narration')))))).toBeUndefined();
    expect(decodeThinkingSignatureKind(base64(lengthDelimited(8, utf8('narration'))))).toBeUndefined();
  });

  it('reads no kind when field 8 is missing', () => {
    expect(decodeThinkingSignatureKind(base64(lengthDelimited(2, lengthDelimited(1, varintField(1, 18)))))).toBeUndefined();
  });

  /**
   * Each case is a valid narration signature with one bad tail appended. The
   * CLI gives up on the whole buffer when any byte fails to parse, so these
   * must read as no kind, not as the narration in front of the bad bytes.
   */
  it.each([
    ['a truncated varint', [0x80]],
    ['an 11-byte varint', [...varint(3 * 8), 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]],
    ['wire type 3', [3 * 8 + 3]],
    ['wire type 4', [3 * 8 + 4]],
    ['a length past the end', [...varint(3 * 8 + 2), 0x7f, 0x01, 0x02]],
    ['a fixed64 past the end', [3 * 8 + 1, 0x01, 0x02, 0x03]],
    ['a fixed32 past the end', [3 * 8 + 5, 0x01]],
  ])('reads no kind when the buffer ends in %s', (_label, badTail) => {
    const signature = base64([...signatureBytes('narration'), ...badTail]);
    expect(decodeThinkingSignatureKind(signature)).toBeUndefined();
    expect(isNarrationSignature(signature)).toBe(false);
  });

  it('takes the last field 2 when several carry a payload, at the outer level too', () => {
    const narrationPayload = lengthDelimited(2, lengthDelimited(1, metadataWithKind('narration')));
    const thinkingPayload = lengthDelimited(2, lengthDelimited(1, metadataWithKind('thinking')));
    expect(decodeThinkingSignatureKind(base64([...thinkingPayload, ...narrationPayload]))).toBe('narration');
    expect(decodeThinkingSignatureKind(base64([...narrationPayload, ...thinkingPayload]))).toBe('thinking');
  });

  it('takes the last field 1 when one payload carries several metadata messages', () => {
    const narration = metadataWithKind('narration');
    const thinking = metadataWithKind('thinking');
    expect(decodeThinkingSignatureKind(base64(signatureWithMetadata(thinking, narration)))).toBe('narration');
    expect(decodeThinkingSignatureKind(base64(signatureWithMetadata(narration, thinking)))).toBe('thinking');
  });

  it('skips a well-formed fixed64 and fixed32 field ahead of the kind', () => {
    const skippedFields = [...fixed64Field(4), ...fixed32Field(5)];
    // At every level, so each of the three field reads must step over them.
    const signature = base64([
      ...fixed64Field(6),
      ...fixed32Field(7),
      ...lengthDelimited(2, [
        ...fixed32Field(6),
        ...fixed64Field(7),
        ...lengthDelimited(1, [...skippedFields, ...metadataWithKind('narration')]),
      ]),
    ]);
    expect(decodeThinkingSignatureKind(signature)).toBe('narration');
    expect(isNarrationSignature(signature)).toBe(true);
  });

  it('skips a legal 10-byte varint value ahead of the kind', () => {
    // 9 continuation bytes and a final byte: the longest varint protobuf allows.
    const tenByteVarintField = [...varint(3 * 8), 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
    expect(tenByteVarintField).toHaveLength(11);
    const signature = base64(signatureWithMetadata([...tenByteVarintField, ...metadataWithKind('narration')]));
    expect(decodeThinkingSignatureKind(signature)).toBe('narration');
  });

  it('rejects a character outside the base64 alphabet, which Buffer would have skipped', () => {
    const signature = realNarrationSignatures[0] ?? '';
    expect(signature.length).toBeGreaterThan(8);
    const middle = Math.floor(signature.length / 2);
    const withStrayCharacter = `${signature.slice(0, middle)}*${signature.slice(middle)}`;
    // Sanity: Buffer skips the stray character and recovers the very same bytes,
    // so a decoder built on it would still read `narration`.
    expect(Buffer.from(withStrayCharacter, 'base64').equals(Buffer.from(signature, 'base64'))).toBe(true);
    expect(decodeThinkingSignatureKind(signature)).toBe('narration');
    expect(decodeThinkingSignatureKind(withStrayCharacter)).toBeUndefined();
    expect(isNarrationSignature(withStrayCharacter)).toBe(false);
  });

  it('reads no kind when a nested message is malformed', () => {
    const badMetadata = [...lengthDelimited(8, utf8('narration')), 0x80];
    const signature = base64(lengthDelimited(2, lengthDelimited(1, badMetadata)));
    expect(decodeThinkingSignatureKind(signature)).toBeUndefined();
  });
});

describe('isNarrationSignature on inputs that are not signatures', () => {
  // The first four are the placeholder signatures other Claude fixtures in this repo carry.
  it.each(['ErcCCmIIDB...', 'fixture-signature', 'sig', 'enc', '', 'not base64 at all!', base64(utf8('narration'))])(
    'is false for %j',
    (signature) => {
      expect(isNarrationSignature(signature)).toBe(false);
    },
  );

  it.each([undefined, null, 42, { kind: 'narration' }])('is false for a non-string %j', (signature) => {
    expect(isNarrationSignature(signature)).toBe(false);
  });
});

/**
 * The fallback to `thinking` is silent by itself, so a format change would
 * quietly bring the stale trail back. The report is the one visible trace.
 */
describe('reportUnrecognizedTextThinking', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    resetUnrecognizedTextThinkingReportForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    resetUnrecognizedTextThinkingReportForTests();
  });

  it('logs once per process, naming the decoded kind and signature length', () => {
    reportUnrecognizedTextThinking(realOpus55ThinkingSignature);
    reportUnrecognizedTextThinking('sig');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('kind: thinking');
    expect(line).toContain(`signature length: ${realOpus55ThinkingSignature.length}`);
  });

  it('says undecodable for a signature that is not one', () => {
    reportUnrecognizedTextThinking(undefined);
    expect(String(warn.mock.calls[0]?.[0])).toContain('kind: undecodable, signature length: 0');
  });
});
