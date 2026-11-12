/**
 * Carries the growing files of a session from the host to Kangentic (#913): the transcript an agent
 * appends to. Kangentic's readers (the conversation viewer, the search index, the token ledger) read a
 * session's transcript from this computer's disk. So the helper tails the file on the host by byte
 * offset and sends what it has not sent, and Kangentic writes those bytes at the same offset into its
 * mirror of the host's home folder. After that nothing downstream knows the agent was remote.
 *
 * - A poll of the file's size every 250 ms, like the hook watcher: inotify drops events without an
 *   error under load, and a stat per tailed file is cheap.
 * - Bytes, not lines, base64 in the event: a chunk may end in the middle of a line or of a character,
 *   and the write at an offset puts it back together. A reader of the mirror already copes with a
 *   half-written last line, because the agent itself writes in the middle of one.
 * - A backfill is paced: a few chunks a scan, so a large transcript on resume streams in beside the
 *   terminal instead of in front of it. The last pass at `unwatch` is not paced, so the final entries of
 *   a session are not left behind. It is capped, so a large backfill can end short, and says so in the log.
 * - A file that shrinks or is replaced (another inode) starts over: the first chunk says `reset`, and
 *   Kangentic empties its copy before it writes. A file that is not there yet is skipped until it is.
 * - A quit leaves the agent running. The next launch is a new process that discarded what the old one
 *   retained. A tail that kept its byte offset would send nothing for a file that has not grown, and
 *   the new process's empty copy would stay empty. `markDetached` makes the next `watch` of each
 *   session start from byte 0 with reset, the same job HookWatcher's `resendUnclaimed` does for hook
 *   records.
 * - A CLI that puts a timestamp in a file's name cannot have the file named from here, so it is searched for
 *   by a pattern, newest name first, and held once found. A walk reads a folder per day of history, so it runs
 *   on a backoff instead of every poll. The last pass looks once more, so a session that ended soon after its
 *   file appeared still sends it. Only regular files match: a symlink is neither followed nor taken.
 *
 * Imports nothing of electron. Runs in the helper on the host.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HostFileSearch } from '../protocol/messages';

export interface TailedFile {
  /** What the app calls the file, so the host's path never has to be mapped back. */
  key: string;
  /** Absolute, on the host. The helper checks it is beneath the user's home before it is watched. */
  path: string;
}

export interface FileChunkEvent {
  sessionId: string;
  key: string;
  /** Where in the file the bytes start. */
  offset: number;
  /** The file was replaced or shortened: the copy is emptied before this chunk is written. */
  reset: boolean;
  /** The file's whole size when this chunk was read, so a copy that must be whole knows when it is. */
  size: number;
  /** The bytes, base64. */
  data: string;
}

export interface FileTailOptions {
  emit: (event: FileChunkEvent) => void;
  intervalMs?: number;
  /** Raw bytes in one chunk. Base64 grows it by a third, and the frame's JSON cap is 256 KiB. */
  chunkBytes?: number;
  /** The most chunks one file sends in a scan, so a backfill leaves room for the terminal's own traffic. */
  chunksPerScan?: number;
  /** The most chunks one file sends in the last pass at `unwatch`. */
  finalChunks?: number;
  /** The wait after a search finds nothing, doubled each time up to `searchMaxDelayMs`. */
  searchDelayMs?: number;
  searchMaxDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_CHUNK_BYTES = 150_000;
const DEFAULT_CHUNKS_PER_SCAN = 2;
const DEFAULT_FINAL_CHUNKS = 64;
const DEFAULT_SEARCH_DELAY_MS = 1_000;
const DEFAULT_SEARCH_MAX_DELAY_MS = 15_000;

/** A file being looked for, and when to look next. */
interface SearchState extends HostFileSearch {
  pattern: RegExp;
  nextAt: number;
  /** The wait before the next look, or null before the first has failed. */
  delayMs: number | null;
}

interface TailState {
  key: string;
  /** Absolute, on the host. Null until a search finds the file, and held from then on. */
  path: string | null;
  /** How the file is found, when its name was not given. */
  search: SearchState | null;
  /** Bytes sent so far: the offset of the next chunk. */
  sent: number;
  /** Device and inode of the file last seen, so a replaced file is told from a grown one. */
  identity: string | null;
  /** The file was replaced or shortened and the next chunk sent has not said so yet. */
  pendingReset: boolean;
}

interface Tailing {
  files: TailState[];
  /** The scan running now, so a poll joins it and `unwatch` can wait for it before its last pass. */
  current: Promise<void> | null;
  /** `unwatch` has begun its last pass, so a `watch` of this id is a new tail, not a change to this one. */
  closing: boolean;
  /**
   * The link dropped. Scans skip this until `watch` starts it from byte 0. A kept offset would send
   * nothing for a file that has not grown, and the new app process never saw the bytes already sent.
   */
  stale: boolean;
}

function freshFile(file: TailedFile): TailState {
  return { key: file.key, path: file.path, search: null, sent: 0, identity: null, pendingReset: false };
}

function freshSearch(search: HostFileSearch): TailState {
  return {
    key: search.key,
    path: null,
    search: { ...search, pattern: new RegExp(search.fileName), nextAt: 0, delayMs: null },
    sent: 0,
    identity: null,
    pendingReset: false,
  };
}

function isSameSearch(kept: SearchState, search: HostFileSearch): boolean {
  return kept.directory === search.directory && kept.depth === search.depth && kept.fileName === search.fileName;
}

/** The first regular file `pattern` matches, walking newest name first, so a recent session costs a few reads. */
async function findFile(directory: string, pattern: RegExp, depth: number): Promise<string | null> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => (left.name < right.name ? 1 : -1));
  const match = entries.find((entry) => entry.isFile() && pattern.test(entry.name));
  if (match) return path.join(directory, match.name);
  if (depth === 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(path.join(directory, entry.name), pattern, depth - 1);
    if (found) return found;
  }
  return null;
}

export class FileTail {
  private readonly tailing = new Map<string, Tailing>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: FileTailOptions) {}

  /**
   * Start tailing a session's files from their first byte. A second call names the session's whole set: a
   * file in both keeps its place, so a transcript found late (a session id that arrives after the start)
   * does not send the others again, a new one starts from byte 0, and one left out stops. `searches` are files
   * found by a pattern, and one in both calls keeps what it found. A session marked stale by `markDetached`
   * is a new tail, from byte 0 with reset, even when the keys and paths are the ones it had.
   */
  watch(sessionId: string, files: readonly TailedFile[], searches: readonly HostFileSearch[] = []): void {
    const existing = this.tailing.get(sessionId);
    const restarting = !existing || existing.closing || existing.stale;
    const held = restarting ? [] : existing.files;
    const named = files.map((file) => held.find((kept) => kept.search === null && kept.key === file.key && kept.path === file.path) ?? freshFile(file));
    const found = searches.map((search) => held.find((kept) => kept.search !== null && kept.key === search.key && isSameSearch(kept.search, search)) ?? freshSearch(search));
    if (existing && existing.stale && !existing.closing) {
      for (const file of [...named, ...found]) file.pendingReset = true;
    }
    if (existing && !existing.closing) {
      existing.files = [...named, ...found];
      existing.stale = false;
    } else {
      this.tailing.set(sessionId, { files: [...named, ...found], current: null, closing: false, stale: false });
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.scanAll(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /**
   * The link dropped. Each live tail stops sending and keeps its files, and the next `watch` of that
   * session starts from byte 0 with reset. Sending into a detached link would hand chunks to a connection
   * nobody reads, and a new app process discards what the old one retained, so bytes already counted as
   * sent would never reach the copy.
   */
  markDetached(): void {
    for (const entry of this.tailing.values()) {
      if (!entry.closing) entry.stale = true;
    }
  }

  /**
   * The app process that was attached when the link dropped is attached again. It kept every byte it was
   * sent, and nothing was sent while the tails were held, so each one goes on from where it stopped, with
   * no reset. Without this a transcript stops being copied after any dropped connection, since only a
   * `watch` ends a hold and the same app has no reason to ask again. A different process never reaches
   * this: it asks for its files itself, and `watch` then starts them over.
   */
  resumeDetached(): void {
    for (const entry of this.tailing.values()) entry.stale = false;
  }

  /** Stop tailing, after one last unpaced pass, so the end of the file is not left behind. */
  async unwatch(sessionId: string): Promise<void> {
    const entry = this.tailing.get(sessionId);
    if (!entry) return;
    entry.closing = true;
    if (entry.current) await entry.current;
    await this.scan(sessionId, entry, this.options.finalChunks ?? DEFAULT_FINAL_CHUNKS, true);
    await this.warnWhenBehind(sessionId, entry);
    // A `watch` of this id during the last pass replaced this entry, and that tail goes on.
    if (this.tailing.get(sessionId) !== entry) return;
    this.tailing.delete(sessionId);
    if (this.tailing.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The last pass is capped, so a large file still backfilling ends short. The next session here starts over. */
  private async warnWhenBehind(sessionId: string, entry: Tailing): Promise<void> {
    for (const file of entry.files) {
      if (file.path === null) continue;
      const stats = await fs.stat(file.path).catch(() => null);
      if (stats && file.sent < stats.size) {
        console.warn(`[file-tail] ${sessionId.slice(0, 8)}: stopped ${stats.size - file.sent} bytes before the end of file ${file.key}`);
      }
    }
  }

  /** Each tailed file's size now, by key, leaving out one that is not there: what a file held before the agent ran. */
  async sizes(sessionId: string): Promise<Record<string, number>> {
    const sizes: Record<string, number> = {};
    for (const file of this.tailing.get(sessionId)?.files ?? []) {
      if (file.path === null) continue;
      const stats = await fs.stat(file.path).catch(() => null);
      if (stats?.isFile()) sizes[file.key] = stats.size;
    }
    return sizes;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tailing.clear();
  }

  isWatching(sessionId: string): boolean {
    return this.tailing.has(sessionId);
  }

  private async scanAll(): Promise<void> {
    await Promise.all(
      [...this.tailing]
        .filter(([, entry]) => !entry.stale && !entry.closing)
        .map(([sessionId, entry]) => this.scan(sessionId, entry, this.options.chunksPerScan ?? DEFAULT_CHUNKS_PER_SCAN)),
    );
  }

  private scan(sessionId: string, entry: Tailing, maxChunks: number, lastPass = false): Promise<void> {
    if (entry.current) return entry.current;
    const running = this.runScan(sessionId, entry, maxChunks, lastPass).finally(() => {
      if (entry.current === running) entry.current = null;
    });
    entry.current = running;
    return running;
  }

  private async runScan(sessionId: string, entry: Tailing, maxChunks: number, lastPass: boolean): Promise<void> {
    for (const file of entry.files) {
      try {
        if (file.path === null) await this.searchFor(file, lastPass);
        if (file.path !== null) await this.scanFile(sessionId, file, file.path, maxChunks);
      } catch (error) {
        // A file the agent removed under us, or one that cannot be read right now: the next poll tries again.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[file-tail] ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Set `file.path` to the file a search names, once it is there. A miss waits out the backoff, unless this is the last pass. */
  private async searchFor(file: TailState, lastPass: boolean): Promise<void> {
    const search = file.search;
    if (!search || (!lastPass && Date.now() < search.nextAt)) return;
    file.path = await findFile(search.directory, search.pattern, search.depth);
    if (file.path === null) {
      const firstDelayMs = this.options.searchDelayMs ?? DEFAULT_SEARCH_DELAY_MS;
      search.delayMs = search.delayMs === null ? firstDelayMs : Math.min(search.delayMs * 2, this.options.searchMaxDelayMs ?? DEFAULT_SEARCH_MAX_DELAY_MS);
      search.nextAt = Date.now() + search.delayMs;
    }
  }

  private async scanFile(sessionId: string, file: TailState, filePath: string, maxChunks: number): Promise<void> {
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || !stats.isFile()) return;
    const identity = `${stats.dev}:${stats.ino}`;
    if (file.identity !== null && (identity !== file.identity || stats.size < file.sent)) {
      file.sent = 0;
      file.pendingReset = true;
    }
    file.identity = identity;
    if (stats.size === 0 && file.pendingReset) {
      this.options.emit({ sessionId, key: file.key, offset: 0, reset: true, size: 0, data: '' });
      file.pendingReset = false;
      return;
    }
    if (file.sent >= stats.size) return;

    const chunkBytes = this.options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const handle = await fs.open(filePath, 'r');
    try {
      // A file swapped in between the stat and the open would read as more of the one it replaced. The
      // next poll sees the new identity and starts over.
      const opened = await handle.stat();
      if (`${opened.dev}:${opened.ino}` !== identity) return;
      for (let chunk = 0; chunk < maxChunks && file.sent < stats.size; chunk += 1) {
        const length = Math.min(chunkBytes, stats.size - file.sent);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, file.sent);
        if (bytesRead === 0) break;
        this.options.emit({ sessionId, key: file.key, offset: file.sent, reset: file.pendingReset, size: stats.size, data: buffer.subarray(0, bytesRead).toString('base64') });
        file.pendingReset = false;
        file.sent += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}
