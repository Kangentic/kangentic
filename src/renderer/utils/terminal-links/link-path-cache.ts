/**
 * Remembers which printed paths exist, so hovering a row costs one IPC at most and
 * hovering it again costs none. Owned by a terminal's path provider, so it goes
 * with the terminal and holds no module state.
 */

/** A file an agent just wrote should link within seconds of being printed. */
export const MISSING_PATH_TTL_MS = 3_000;
/** A click re-resolves in main, so an entry past its file's life costs only that toast. */
export const EXISTING_PATH_TTL_MS = 60_000;
export const MAX_CACHED_PATHS = 512;

interface CacheEntry {
  exists: boolean;
  expiresAt: number;
}

export interface LinkPathCache {
  /** The cached answer, or undefined when the path has none or it expired. */
  peek(path: string): boolean | undefined;
  /** Asks about every path with no answer in one call. Rejections reach the caller. */
  resolve(paths: readonly string[]): Promise<void>;
}

export function createLinkPathCache(
  askMain: (paths: string[]) => Promise<boolean[]>,
  now: () => number = Date.now,
): LinkPathCache {
  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<void>>();

  const peek = (path: string): boolean | undefined => {
    const entry = entries.get(path);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(path);
      return undefined;
    }
    return entry.exists;
  };

  const store = (path: string, exists: boolean): void => {
    // Map keeps insertion order, so the first key is the oldest.
    if (entries.size >= MAX_CACHED_PATHS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(path, { exists, expiresAt: now() + (exists ? EXISTING_PATH_TTL_MS : MISSING_PATH_TTL_MS) });
  };

  return {
    peek,
    resolve: async (paths) => {
      const toAsk: string[] = [];
      const waits = new Set<Promise<void>>();
      // A row can print one path twice, and each entry would spend main's cap.
      for (const path of new Set(paths)) {
        if (peek(path) !== undefined) continue;
        const wait = inFlight.get(path);
        if (wait) waits.add(wait);
        else toAsk.push(path);
      }
      if (toAsk.length > 0) {
        const ask = askMain(toAsk).then((answers) => {
          toAsk.forEach((path, index) => store(path, answers[index] === true));
        }).finally(() => {
          for (const path of toAsk) inFlight.delete(path);
        });
        for (const path of toAsk) inFlight.set(path, ask);
        waits.add(ask);
      }
      await Promise.all(waits);
    },
  };
}
