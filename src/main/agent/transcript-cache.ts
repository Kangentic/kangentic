import fs from 'node:fs/promises';
import type { TranscriptEntry } from '../../shared/types';

/** Per-block/content clamp so a multi-MB transcript never ships whole over IPC
 *  into React state. Individual spans over this are truncated with a marker.
 *  Exported so the index-fallback path in `transcript-service.ts` clamps by the
 *  identical rule instead of maintaining a second copy that could drift. */
export const MAX_SPAN_CHARS = 20_000;

/** Cached results are keyed by `(sessionType, agentSessionId)`; cap the number
 *  of distinct sessions held so a long-running app with many opened
 *  conversations does not grow this map unbounded. */
const CACHE_LIMIT = 16;

export function clampSpan(text: string): string {
  if (text.length <= MAX_SPAN_CHARS) return text;
  return `${text.slice(0, MAX_SPAN_CHARS)}\n[truncated ${text.length - MAX_SPAN_CHARS} chars]`;
}

/** Apply the per-span clamp across every entry's text/blocks/content. A
 *  tool_use block's `input` is deliberately left untouched (the diff/tool-use
 *  renderer needs it intact). */
export function truncateEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'user':
        return { ...entry, text: clampSpan(entry.text) };
      case 'assistant':
        return {
          ...entry,
          blocks: entry.blocks.map((block) =>
            block.type === 'tool_use' ? block : { ...block, text: clampSpan(block.text) },
          ),
        };
      case 'tool_result':
        return { ...entry, content: clampSpan(entry.content) };
      case 'system':
        return { ...entry, text: clampSpan(entry.text) };
    }
  });
}

interface CacheRecord {
  sourcePath: string;
  mtimeMs: number;
  size: number;
  truncatedEntries: TranscriptEntry[];
}

const cache = new Map<string, CacheRecord>();

/** Move `key` to the most-recently-used end and evict the oldest entry past
 *  the cap. Map iteration order is insertion order, so re-inserting after a
 *  delete is enough to implement LRU without a separate linked list. */
function touch(key: string, record: CacheRecord): void {
  cache.delete(key);
  cache.set(key, record);
  while (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export interface ParsedTranscriptResult {
  entries: TranscriptEntry[];
  sourcePath: string | null;
}

/**
 * Stat-validated per-file result cache wrapping an adapter's `parseTranscript`
 * call. On a cache hit (the previously-parsed file's path/mtime/size are
 * unchanged), returns the SAME `truncatedEntries` array reference with zero
 * parsing - this is what lets the task-level stitch memo (see
 * `transcript-service.ts`) and the renderer's row reconciler skip their own
 * re-work when a live-poll tick finds nothing new.
 *
 * Deliberately does not require a separate "locate" call: the cache
 * remembers the sourcePath the last successful parse returned and re-stats
 * THAT path directly on the next call, so a session whose file is genuinely
 * unchanged never has to ask the adapter to parse at all. The first call for
 * a session (or a call after the remembered path stops matching) always
 * parses once to (re)learn the current path.
 */
export async function getCachedTranscript(
  sessionType: string,
  agentSessionId: string,
  parse: () => Promise<ParsedTranscriptResult>,
): Promise<ParsedTranscriptResult> {
  const key = `${sessionType}:${agentSessionId}`;
  const cached = cache.get(key);

  if (cached) {
    let stat: { mtimeMs: number; size: number } | null = null;
    try {
      stat = await fs.stat(cached.sourcePath);
    } catch {
      stat = null;
    }
    if (stat && stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
      touch(key, cached);
      return { entries: cached.truncatedEntries, sourcePath: cached.sourcePath };
    }
  }

  const parsed = await parse();
  const truncatedEntries = truncateEntries(parsed.entries);

  if (parsed.sourcePath) {
    try {
      const stat = await fs.stat(parsed.sourcePath);
      touch(key, { sourcePath: parsed.sourcePath, mtimeMs: stat.mtimeMs, size: stat.size, truncatedEntries });
    } catch {
      // File disappeared between the parse and this stat (a genuine race, or
      // the parser located a path that does not actually exist): nothing
      // stable to cache against, so leave any prior entry in place rather
      // than caching a record we cannot validate next time.
      cache.delete(key);
    }
  } else {
    cache.delete(key);
  }

  return { entries: truncatedEntries, sourcePath: parsed.sourcePath };
}

/** Test-only: clear the module-scope cache between test cases. */
export function resetForTests(): void {
  cache.clear();
}
