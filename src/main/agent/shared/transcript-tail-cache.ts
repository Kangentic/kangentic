import fs from 'node:fs/promises';

/**
 * Bounded tail reader with an LRU content-identity cache, shared by the
 * submission verifiers that read an appendable TEXT history: Claude and Aider
 * import it directly, Codex / Qwen / Kimi reach it through
 * `submitted-text-verifier.ts`. Copilot (a global JSON blob it must re-read
 * whole) and OpenCode (a SQL query) have nothing to tail and bypass it.
 *
 * This is generic file reading, not per-agent parsing: `agent-adapters-boundary`
 * constrains where agent-specific RECORD SHAPES live, and those stay in each
 * adapter's folder. Copying this machinery per adapter is the failure mode it
 * exists to prevent - the cache is only correct while it is module-global and
 * shared (see below).
 */

/**
 * Bytes read from the end of the transcript.
 *
 * The scan walks backwards and stops at the `sentAt` watermark, so it only ever
 * needs entries written in the last few hundred milliseconds. Reading the whole
 * file to look at its tail is what made verification expensive: a long session's
 * JSONL is multiple megabytes, and `pollForConfirmation` asks every 25ms.
 */
export const TAIL_BYTES = 256 * 1024;

/**
 * Parsed tail, keyed by path and invalidated by (size, mtime).
 *
 * Verification polls at 25ms for up to ~2s per command, but the agent writes to
 * the transcript far less often than that, so the overwhelming majority of
 * polls would re-read and re-split bytes that have not changed. A `stat` costs
 * microseconds against a read plus a `split()` over tens of thousands of lines.
 *
 * Cached by CONTENT IDENTITY rather than by query result, which keeps it safe
 * for any (command, sentAt) pair: identical bytes always parse to identical
 * lines, so a later poll for a different command reuses the array without
 * inheriting an answer. That property is also what lets adapters share one
 * cache: a Codex rollout and a Claude transcript are distinct keys, and neither
 * can answer the other's query.
 *
 * This matters most in bursts. Injection concurrency is per task, so dragging
 * several tasks into a column at once starts several poll loops, each of which
 * was independently re-reading a multi-megabyte file 40 times a second in the
 * MAIN process, where the cost lands on IPC and therefore on the UI.
 *
 * MODULE-GLOBAL ON PURPOSE. It cannot be scoped to a verifier closure:
 * `getSubmissionVerifier` builds a fresh verifier once per POLL (the transcript
 * path is derived from a session id that is re-resolved each time, to survive a
 * mid-burst `/clear` fork), so a closure-local cache would be rebuilt 40 times a
 * second and never hit.
 *
 * EVICTION IS LRU, NOT CLEAR-ALL, and that distinction is the whole point in
 * the case this exists for. A clear-all on overflow degenerates precisely
 * under burst: with more concurrent transcripts than slots, each insert wipes
 * every other burst's entry, they all miss on their next poll, re-read, and
 * evict each other again - turning the cache into pure overhead at exactly
 * the concurrency where it is needed. Least-recently-used eviction keeps every
 * actively-polling burst resident and ages out only finished ones.
 */
export const TAIL_CACHE_LIMIT = 32;

interface TailCacheEntry {
  size: number;
  mtimeMs: number;
  lines: string[];
}

const tailCache = new Map<string, TailCacheEntry>();

/**
 * Mark `filePath` most-recently-used and drop the oldest entries past the cap.
 * A Map iterates in insertion order, so delete-then-set moves an entry to the
 * end and `keys().next()` yields the least recently used.
 *
 * The cap is sized against CONCURRENT TRANSCRIPTS, not tasks: the `/clear`-fork
 * fallback in `buildCommandInjectionVerifier` scans two paths per poll (the
 * re-resolved id, then the one captured at plan-build time), so a forked
 * session occupies two slots. Now that every adapter shares this cache, a mixed
 * board can hold entries for several agents at once, which is a further reason
 * the bound is generous. 32 leaves room for well past any realistic
 * simultaneous drag. Entries self-invalidate on `(size, mtime)`, so the only
 * cost of a larger bound is retained bytes: at most `TAIL_BYTES` per entry, and
 * far less for the short transcripts a fresh session has.
 */
function touchCacheEntry(filePath: string, entry: TailCacheEntry): void {
  tailCache.delete(filePath);
  tailCache.set(filePath, entry);
  while (tailCache.size > TAIL_CACHE_LIMIT) {
    const leastRecent = tailCache.keys().next();
    if (leastRecent.done) break;
    tailCache.delete(leastRecent.value);
  }
}

/** Reset between tests so one test's cached tail cannot answer another's poll. */
export function clearTranscriptTailCache(): void {
  tailCache.clear();
}

/**
 * Read the last `TAIL_BYTES` of `filePath` and return its lines, or `null` when
 * the file cannot be read (which callers must treat as "keep polling", never as
 * a verified failure - a missing file is the normal state for the first few
 * hundred milliseconds after a spawn).
 */
export async function readTranscriptTailLines(filePath: string): Promise<string[] | null> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return null;
  }

  const cached = tailCache.get(filePath);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    // A hit is a use: re-stamp it so a burst that keeps polling never ages out
    // behind bursts that merely started later.
    touchCacheEntry(filePath, cached);
    return cached.lines;
  }

  let content: string;
  try {
    if (stats.size <= TAIL_BYTES) {
      content = await fs.readFile(filePath, 'utf-8');
    } else {
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(TAIL_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, TAIL_BYTES, stats.size - TAIL_BYTES);
        // The window starts mid-line, and possibly mid-UTF-8-sequence. Dropping
        // everything before the first newline discards both, and costs nothing:
        // a truncated leading entry could not have parsed anyway.
        const raw = buffer.subarray(0, bytesRead).toString('utf-8');
        const firstNewline = raw.indexOf('\n');
        content = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
      } finally {
        await handle.close();
      }
    }
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  touchCacheEntry(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, lines });
  return lines;
}
