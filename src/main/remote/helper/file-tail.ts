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
 *   a session are not left behind.
 * - A file that shrinks or is replaced (another inode) starts over: the first chunk says `reset`, and
 *   Kangentic empties its copy before it writes. A file that is not there yet is skipped until it is.
 *
 * Imports nothing of electron. Runs in the helper on the host.
 */

import { promises as fs } from 'node:fs';

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
}

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_CHUNK_BYTES = 150_000;
const DEFAULT_CHUNKS_PER_SCAN = 2;
const DEFAULT_FINAL_CHUNKS = 64;

interface TailState extends TailedFile {
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
}

export class FileTail {
  private readonly tailing = new Map<string, Tailing>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: FileTailOptions) {}

  /** Start tailing a session's files from their first byte. A second call for one session replaces the first. */
  watch(sessionId: string, files: readonly TailedFile[]): void {
    this.tailing.set(sessionId, { files: files.map((file) => ({ ...file, sent: 0, identity: null, pendingReset: false })), current: null });
    if (!this.timer) {
      this.timer = setInterval(() => void this.scanAll(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /** Stop tailing, after one last unpaced pass, so the end of the file is not left behind. */
  async unwatch(sessionId: string): Promise<void> {
    const entry = this.tailing.get(sessionId);
    if (!entry) return;
    if (entry.current) await entry.current;
    await this.scan(sessionId, entry, this.options.finalChunks ?? DEFAULT_FINAL_CHUNKS);
    this.tailing.delete(sessionId);
    if (this.tailing.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    await Promise.all([...this.tailing].map(([sessionId, entry]) => this.scan(sessionId, entry, this.options.chunksPerScan ?? DEFAULT_CHUNKS_PER_SCAN)));
  }

  private scan(sessionId: string, entry: Tailing, maxChunks: number): Promise<void> {
    if (entry.current) return entry.current;
    const running = this.runScan(sessionId, entry, maxChunks).finally(() => {
      if (entry.current === running) entry.current = null;
    });
    entry.current = running;
    return running;
  }

  private async runScan(sessionId: string, entry: Tailing, maxChunks: number): Promise<void> {
    for (const file of entry.files) {
      try {
        await this.scanFile(sessionId, file, maxChunks);
      } catch (error) {
        // A file the agent removed under us, or one that cannot be read right now: the next poll tries again.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[file-tail] ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async scanFile(sessionId: string, file: TailState, maxChunks: number): Promise<void> {
    const stats = await fs.stat(file.path).catch(() => null);
    if (!stats || !stats.isFile()) return;
    const identity = `${stats.dev}:${stats.ino}`;
    if (file.identity !== null && (identity !== file.identity || stats.size < file.sent)) {
      file.sent = 0;
      file.pendingReset = true;
    }
    file.identity = identity;
    if (stats.size === 0 && file.pendingReset) {
      this.options.emit({ sessionId, key: file.key, offset: 0, reset: true, data: '' });
      file.pendingReset = false;
      return;
    }
    if (file.sent >= stats.size) return;

    const chunkBytes = this.options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const handle = await fs.open(file.path, 'r');
    try {
      for (let chunk = 0; chunk < maxChunks && file.sent < stats.size; chunk += 1) {
        const length = Math.min(chunkBytes, stats.size - file.sent);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, file.sent);
        if (bytesRead === 0) break;
        this.options.emit({ sessionId, key: file.key, offset: file.sent, reset: file.pendingReset, data: buffer.subarray(0, bytesRead).toString('base64') });
        file.pendingReset = false;
        file.sent += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}
