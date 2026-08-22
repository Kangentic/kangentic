import fs from 'node:fs/promises';
import type { TranscriptEntry } from '../../shared/types';
import { touchBounded } from './shared/bounded-lru';

/** Per-block/content clamp so a multi-MB transcript never ships whole over IPC
 *  into React state. Individual spans over this are truncated with a marker.
 *  Exported so the index-fallback path in `transcript-service.ts` clamps by the
 *  identical rule instead of maintaining a second copy that could drift. */
export const MAX_SPAN_CHARS = 20_000;

/**
 * Cached results are keyed by `(sessionType, agentSessionId)`.
 *
 * The entry cap used to be 16, which is smaller than a single working set: a
 * `--resume` writes a NEW transcript file replaying its parent's whole
 * history, so one task resumed five times owns five files, and a live board
 * measured 20 files (319MB) behind ONE mobile Home-feed refresh. At 16 the
 * LRU evicted faster than the feed could reuse it, so every refresh re-parsed
 * from scratch - the cache was doing strictly negative work.
 *
 * Raised well past a realistic board, and bounded by BYTES as well so the
 * larger count cannot turn into unbounded memory: parsed entries are roughly
 * proportional to their source file, and a handful of 50MB transcripts would
 * otherwise dwarf everything else. Whichever bound binds first evicts.
 *
 * THE BYTE BUDGET COUNTS SOURCE BYTES, NOT RETAINED HEAP. `record.size` is the
 * transcript's size on disk, which is a CONSERVATIVE proxy: measured on a real
 * 137.9MB transcript, a whole-file parse retained 12.7MB of entries (0.09x
 * source), and these records are truncated on top of that. So the nominal 192MB
 * corresponds to well under 192MB of heap in practice. The one place the proxy
 * understates cost is tool-heavy transcripts, because `truncateEntries` passes
 * `tool_use` blocks through by reference with their `input` deliberately
 * unclamped.
 *
 * Kept at 192MB rather than lowered: the working set this exists to hold was
 * measured at 20 files / 319MB behind a single mobile Home-feed refresh, and
 * cutting under that reintroduces the thrash described above. The per-parse cap
 * (`MAX_PARSE_SOURCE_BYTES`) is what keeps any SINGLE record small.
 */
const CACHE_LIMIT = 64;
const CACHE_BYTE_BUDGET = 192 * 1024 * 1024;

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

/** Move `key` to the most-recently-used end and evict past both bounds. The
 *  eviction itself lives in `shared/bounded-lru.ts`: this loop used to be
 *  hand-copied into the sibling caches, and one copy silently dropped the byte
 *  budget, which is what caused a main-process OOM. */
function touch(key: string, record: CacheRecord): void {
  touchBounded(cache, key, record, {
    limit: CACHE_LIMIT,
    byteBudget: CACHE_BYTE_BUDGET,
    sizeOf: (held) => held.size,
    minRetained: 1,
  });
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

/**
 * The file signature this session's cached parse was validated against, or
 * null when nothing is cached for it yet.
 *
 * Exported so the task-level stitch memo can ask "is every file behind this
 * task still untouched?" using stats alone. Without it, answering that
 * question required parsing every session first, which is precisely the work
 * the memo exists to avoid - a task with five resumed sessions re-read
 * hundreds of megabytes of near-identical JSONL to serve one tail request.
 */
export function peekCachedFileSignature(
  sessionType: string,
  agentSessionId: string,
): { sourcePath: string; mtimeMs: number; size: number } | null {
  const cached = cache.get(`${sessionType}:${agentSessionId}`);
  if (!cached) return null;
  return { sourcePath: cached.sourcePath, mtimeMs: cached.mtimeMs, size: cached.size };
}

/** True when the file behind a signature is still byte-identical by stat. */
export async function isCachedFileUnchanged(signature: {
  sourcePath: string;
  mtimeMs: number;
  size: number;
}): Promise<boolean> {
  try {
    const stat = await fs.stat(signature.sourcePath);
    return stat.mtimeMs === signature.mtimeMs && stat.size === signature.size;
  } catch {
    return false;
  }
}

/** Test-only: clear the module-scope cache between test cases. */
export function resetForTests(): void {
  cache.clear();
}
