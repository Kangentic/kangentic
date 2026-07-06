import crypto from 'node:crypto';
import type { TranscriptEntry } from '../../../shared/types';
import { sanitizeTranscriptText } from '../../../shared/ansi-strip';
import { estimateTokens } from '../token-estimate';
import type { ChunkInput } from '../types';

/**
 * Bump when the chunking algorithm changes in a way that invalidates existing
 * chunks (fragment rendering, window sizes, hashing). The indexer compares this
 * against memory_meta.chunker_version and reindexes everything on a mismatch.
 */
export const CHUNKER_VERSION = 1;

// Token windows sized for the MiniLM ~512-token model window, with margin.
const TARGET_TOKENS = 400;
const MAX_TOKENS = 480;
const MIN_TOKENS = 60;

const MAX_CHARS = MAX_TOKENS * 4;
const OVERLAP_CHARS = 200;
const TOOL_INPUT_SUMMARY_CHARS = 200;
const TOOL_RESULT_CHARS = 400;

/** One rendered unit of conversation, before accumulation into chunks. */
interface Fragment {
  text: string;
  role: string;
  ts: number | null;
  uuid: string | null;
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** Collapse a value to a compact single-ish-line summary for tool_use input. */
function summarizeToolInput(input: unknown): string {
  let raw: string;
  if (typeof input === 'string') {
    raw = input;
  } else {
    try {
      raw = JSON.stringify(input) ?? '';
    } catch {
      raw = '';
    }
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > TOOL_INPUT_SUMMARY_CHARS
    ? `${collapsed.slice(0, TOOL_INPUT_SUMMARY_CHARS)}…`
    : collapsed;
}

/** Render one TranscriptEntry into zero or more fragments. */
function renderEntry(entry: TranscriptEntry): Fragment[] {
  const fragments: Fragment[] = [];
  const push = (label: string, body: string, role: string): void => {
    const clean = sanitizeTranscriptText(body).trim();
    if (!clean) return;
    fragments.push({ text: `${label}: ${clean}`, role, ts: entry.ts, uuid: entry.uuid });
  };

  switch (entry.kind) {
    case 'user':
      push('User', entry.text, 'user');
      break;
    case 'assistant':
      for (const block of entry.blocks) {
        if (block.type === 'text') {
          push('Assistant', block.text, 'assistant');
        } else if (block.type === 'thinking') {
          push('Assistant (thinking)', block.text, 'assistant');
        } else if (block.type === 'tool_use') {
          const summary = summarizeToolInput(block.input);
          push('Tool', summary ? `${block.name} ${summary}` : block.name, 'assistant');
        }
      }
      break;
    case 'tool_result': {
      const body = entry.content.slice(0, TOOL_RESULT_CHARS);
      push(entry.isError ? 'Tool error' : 'Tool result', body, 'tool_result');
      break;
    }
    case 'system':
      push(`[${entry.subtype}]`, entry.text, 'system');
      break;
  }
  return fragments;
}

/** Split a single oversize fragment: blank lines -> sentences -> hard windows. */
function splitOversizeText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const pieces: string[] = [];
  const flushByLimit = (segment: string): void => {
    if (segment.length <= MAX_CHARS) {
      if (segment.trim()) pieces.push(segment);
      return;
    }
    // Hard char windows with overlap when even sentence-splitting is too coarse.
    let cursor = 0;
    while (cursor < segment.length) {
      const end = Math.min(segment.length, cursor + MAX_CHARS);
      pieces.push(segment.slice(cursor, end));
      if (end >= segment.length) break;
      cursor = end - OVERLAP_CHARS;
    }
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    if (!paragraph.trim()) continue;
    if (paragraph.length <= MAX_CHARS) {
      pieces.push(paragraph);
      continue;
    }
    // Sentence-level split before falling back to hard windows.
    let buffer = '';
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (buffer && estimateTokens(buffer + sentence) > MAX_TOKENS) {
        flushByLimit(buffer);
        buffer = '';
      }
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
    if (buffer) flushByLimit(buffer);
  }
  return pieces.length > 0 ? pieces : [text.slice(0, MAX_CHARS)];
}

/** Dominant role across an accumulator, or 'mixed'. */
function dominantRole(roles: string[]): string {
  const counts = new Map<string, number>();
  for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  if (counts.size === 1) return roles[0];
  let best = 'mixed';
  let bestCount = -1;
  let tie = false;
  for (const [role, count] of counts) {
    if (count > bestCount) {
      best = role;
      bestCount = count;
      tie = false;
    } else if (count === bestCount) {
      tie = true;
    }
  }
  return tie ? 'mixed' : best;
}

/**
 * Chunk a parsed transcript into indexable units. Turn-based greedy
 * accumulation of consecutive fragments toward TARGET tokens, flushing at MAX.
 * Oversize single fragments are split. A trailing sub-MIN chunk merges backward
 * into the previous chunk when possible. Chunks carry the dominant role and the
 * first/last contributing entry's ts + uuid anchors.
 */
export function chunkTranscript(entries: TranscriptEntry[]): ChunkInput[] {
  const fragments: Fragment[] = [];
  for (const entry of entries) {
    for (const fragment of renderEntry(entry)) {
      if (estimateTokens(fragment.text) > MAX_TOKENS) {
        // Explode oversize fragments; keep the same turn anchors on each piece.
        for (const piece of splitOversizeText(fragment.text)) {
          fragments.push({ ...fragment, text: piece });
        }
      } else {
        fragments.push(fragment);
      }
    }
  }

  interface Accumulator {
    texts: string[];
    roles: string[];
    tsStart: number | null;
    tsEnd: number | null;
    uuidStart: string | null;
    uuidEnd: string | null;
    tokens: number;
  }

  const chunks: ChunkInput[] = [];
  let accumulator: Accumulator | null = null;
  let seq = 0;

  const flush = (): void => {
    if (!accumulator || accumulator.texts.length === 0) return;
    const text = accumulator.texts.join('\n');
    chunks.push({
      seq: seq++,
      text,
      contentHash: sha1(text),
      tokenEstimate: estimateTokens(text),
      role: dominantRole(accumulator.roles),
      tsStart: accumulator.tsStart,
      tsEnd: accumulator.tsEnd,
      turnUuidStart: accumulator.uuidStart,
      turnUuidEnd: accumulator.uuidEnd,
    });
    accumulator = null;
  };

  for (const fragment of fragments) {
    const fragmentTokens = estimateTokens(fragment.text);
    if (
      accumulator &&
      accumulator.tokens + fragmentTokens > MAX_TOKENS &&
      accumulator.tokens >= MIN_TOKENS
    ) {
      flush();
    }
    if (!accumulator) {
      accumulator = {
        texts: [],
        roles: [],
        tsStart: fragment.ts,
        tsEnd: fragment.ts,
        uuidStart: fragment.uuid,
        uuidEnd: fragment.uuid,
        tokens: 0,
      };
    }
    accumulator.texts.push(fragment.text);
    accumulator.roles.push(fragment.role);
    accumulator.tokens += fragmentTokens;
    accumulator.tsEnd = fragment.ts;
    accumulator.uuidEnd = fragment.uuid;
    // Flush eagerly once we're at/over the target to keep chunks near TARGET.
    if (accumulator.tokens >= TARGET_TOKENS) flush();
  }
  flush();

  // Merge a trailing sub-MIN chunk backward into its predecessor when the
  // combined size still fits, so we don't emit a tiny dangling chunk.
  if (chunks.length >= 2) {
    const lastChunk = chunks[chunks.length - 1];
    const previousChunk = chunks[chunks.length - 2];
    if (lastChunk.tokenEstimate < MIN_TOKENS && previousChunk.tokenEstimate + lastChunk.tokenEstimate <= MAX_TOKENS) {
      const mergedText = `${previousChunk.text}\n${lastChunk.text}`;
      chunks.splice(chunks.length - 2, 2, {
        seq: previousChunk.seq,
        text: mergedText,
        contentHash: sha1(mergedText),
        tokenEstimate: estimateTokens(mergedText),
        role: dominantRole([previousChunk.role, lastChunk.role]),
        tsStart: previousChunk.tsStart,
        tsEnd: lastChunk.tsEnd,
        turnUuidStart: previousChunk.turnUuidStart,
        turnUuidEnd: lastChunk.turnUuidEnd,
      });
    }
  }

  return chunks;
}
