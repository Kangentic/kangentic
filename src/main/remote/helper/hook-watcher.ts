/**
 * Carries a session's hook files from the host to Kangentic (#913).
 *
 * An agent CLI on a host runs the session's hook script (`wsl-hook.sh`, the same POSIX script a WSL
 * distro uses), which only publishes files: events into `inbox/`, requests into `requests/`, and the
 * status line's JSON over `status.json`. Kangentic's half of the transport reads them from a folder on
 * its own disk. So the helper watches that folder here and sends each file across the link, and
 * Kangentic writes it into the same place on its side. After that nothing downstream knows the CLI was
 * remote: the inbox turns records into events, answers plan approvals, and relays MCP to the loopback
 * server. The host never dials that server, which only this computer can reach; the token still sits
 * on the host in the agent's MCP config, because the agent's bridge sends it with each request.
 *
 * - A file is sent once and removed from the host once it is sent. The link retains and replays what
 *   an interrupted connection lost, so a drop loses nothing already handed over.
 * - A REQUEST is the exception: it is sent once and stays on the host until Kangentic claims it (removes
 *   it, through `removeFiles`, before it acts on it) or the script that wrote it gives up and removes it
 *   itself. Whoever removes it first wins, since an unlink happens once. So a call sent while the link was
 *   down, delivered minutes later, finds its file gone, and is never acted on after the agent has been
 *   told it failed; and a call that was claimed is never reported as failed.
 * - Records are sent in name order, which is the order their hooks ran (names start with the epoch ns).
 * - A poll, not a watch: inotify drops events without an error under load, and a poll of three small
 *   folders every 100 ms is cheap next to the CLI it serves.
 * - A record too large for one frame is trimmed, never sent whole: a frame over the cap ends the
 *   connection, which would stall every terminal on the host.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type HookFolder = 'inbox' | 'requests' | 'status';

export interface HookFileEvent {
  sessionId: string;
  folder: HookFolder;
  name: string;
  content: string;
  /**
   * A request this watcher left on the host until it is claimed. Set only by a watcher that keeps requests,
   * so Kangentic claims only those: a program installed before this one removed every file as it sent it,
   * and a claim on one of its requests would find nothing and drop a call that is waiting.
   */
  claim?: boolean;
}

export interface HookWatcherOptions {
  emit: (event: HookFileEvent) => void;
  intervalMs?: number;
  /** The most bytes a content may take once JSON-escaped and UTF-8 encoded, below the frame cap. */
  maxContentJsonBytes?: number;
}

const DEFAULT_INTERVAL_MS = 100;
/** The frame's JSON cap is 256 KiB of bytes (`MAX_FRAME_JSON_BYTES`); the event around the content takes a little. */
const DEFAULT_MAX_CONTENT_JSON_BYTES = 200_000;
const RECORD_EXTENSION: Record<'inbox' | 'requests', string> = { inbox: '.rec', requests: '.req' };

interface Watched {
  directory: string;
  statusFile: string | null;
  statusSignature: string | null;
  /** The scan running now, so a poll joins it and `unwatch` can wait for it before its last pass. */
  current: Promise<void> | null;
  /** Files already sent whose removal failed, so they are not sent twice. */
  sent: Set<string>;
}

/** The published files of a folder in the order their hooks ran. Names start with a dot while being written. */
export function publishedNames(names: readonly string[], extension: string): string[] {
  return names.filter((name) => !name.startsWith('.') && name.endsWith(extension)).sort();
}

/**
 * The bytes a text takes in a frame's JSON body. Bytes, not characters: `JSON.stringify` leaves non-ASCII
 * text unescaped, so 200k characters of three-byte text would be 600 KB against a 256 KiB cap.
 */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}

/**
 * A record that fits one frame. A hook record is three header lines (version, kind, arguments) and
 * the hook's stdin, usually a JSON object whose bulk is one large string (a file the agent wrote).
 * Strings are cut down until the whole fits, which keeps the object's shape and the tool name; if
 * that cannot be done the stdin is dropped and the header alone is sent.
 */
export function fitHookRecord(content: string, maxJsonBytes: number): string {
  if (escapedBytes(content) <= maxJsonBytes) return content;
  let headerEnd = -1;
  for (let line = 0; line < 3; line += 1) {
    headerEnd = content.indexOf('\n', headerEnd + 1);
    // Six bytes covers the widest a character can grow escaped (`\uXXXX`) or encoded (four UTF-8 bytes).
    if (headerEnd < 0) return content.slice(0, Math.max(0, Math.floor(maxJsonBytes / 6)));
  }
  const header = content.slice(0, headerEnd + 1);
  const stdin = content.slice(headerEnd + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return header;
  }
  for (const limit of [20_000, 2_000, 200, 20]) {
    const trimmed = JSON.stringify(trimStrings(parsed, limit));
    if (escapedBytes(header + trimmed) <= maxJsonBytes) return header + trimmed;
  }
  return header;
}

function trimStrings(value: unknown, limit: number): unknown {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}...[trimmed]` : value;
  if (Array.isArray(value)) return value.map((item) => trimStrings(item, limit));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimStrings(item, limit)]));
  }
  return value;
}

export class HookWatcher {
  private readonly watched = new Map<string, Watched>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HookWatcherOptions) {}

  /** Start watching a session's hook folder (the one holding `inbox/` and `requests/`), and its status file. */
  watch(sessionId: string, directory: string, statusFile: string | null = null): void {
    this.watched.set(sessionId, { directory, statusFile, statusSignature: null, current: null, sent: new Set() });
    if (!this.timer) {
      this.timer = setInterval(() => void this.scanAll(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /** Stop watching. Anything already published is sent first, so the exit's last records are not lost. */
  async unwatch(sessionId: string): Promise<void> {
    const entry = this.watched.get(sessionId);
    if (!entry) return;
    // A poll may be mid-scan, past its folder listing: a record published since would be missed by it.
    // So the running scan finishes, and then one full pass more runs.
    if (entry.current) await entry.current;
    await this.scan(sessionId, entry);
    this.watched.delete(sessionId);
    if (this.watched.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watched.clear();
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  isWatching(sessionId: string): boolean {
    return this.watched.has(sessionId);
  }

  private async scanAll(): Promise<void> {
    await Promise.all([...this.watched].map(([sessionId, entry]) => this.scan(sessionId, entry)));
  }

  private scan(sessionId: string, entry: Watched): Promise<void> {
    if (entry.current) return entry.current;
    const running = this.runScan(sessionId, entry).finally(() => {
      if (entry.current === running) entry.current = null;
    });
    entry.current = running;
    return running;
  }

  private async runScan(sessionId: string, entry: Watched): Promise<void> {
    try {
      for (const folder of ['inbox', 'requests'] as const) {
        await this.scanFolder(sessionId, entry, folder);
      }
      await this.scanStatus(sessionId, entry);
    } catch (error) {
      // A folder the session removed under us, or an unreadable file: the next poll tries again.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[hook-watcher] ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async scanFolder(sessionId: string, entry: Watched, folder: 'inbox' | 'requests'): Promise<void> {
    const folderPath = path.join(entry.directory, folder);
    const names = publishedNames(await fs.readdir(folderPath).catch(() => [] as string[]), RECORD_EXTENSION[folder]);
    for (const name of names) {
      const key = `${folder}/${name}`;
      const file = path.join(folderPath, name);
      if (!entry.sent.has(key)) {
        const content = await fs.readFile(file, 'utf8').catch(() => null);
        if (content === null) continue;
        this.options.emit({
          sessionId,
          folder,
          name,
          content: fitHookRecord(content, this.options.maxContentJsonBytes ?? DEFAULT_MAX_CONTENT_JSON_BYTES),
          ...(folder === 'requests' ? { claim: true } : {}),
        });
        entry.sent.add(key);
      }
      // A request stays until it is claimed or given up on (see the header).
      if (folder === 'requests') continue;
      // Removed once sent. A removal that fails leaves it in `sent`, so it is not sent again.
      if (await fs.rm(file, { force: true }).then(() => true, () => false)) entry.sent.delete(key);
    }
    // A request that is gone was claimed or given up on: forget it, so the set holds what is still there.
    if (folder === 'requests') {
      const present = new Set(names.map((name) => `${folder}/${name}`));
      for (const key of entry.sent) if (key.startsWith('requests/') && !present.has(key)) entry.sent.delete(key);
    }
  }

  private async scanStatus(sessionId: string, entry: Watched): Promise<void> {
    if (!entry.statusFile) return;
    const stats = await fs.stat(entry.statusFile).catch(() => null);
    if (!stats) return;
    const signature = `${stats.mtimeMs}:${stats.size}`;
    if (signature === entry.statusSignature) return;
    const content = await fs.readFile(entry.statusFile, 'utf8').catch(() => null);
    if (content === null) return;
    entry.statusSignature = signature;
    // The newest status replaces the last, so an over-size one is dropped rather than trimmed into a broken JSON.
    if (escapedBytes(content) > (this.options.maxContentJsonBytes ?? DEFAULT_MAX_CONTENT_JSON_BYTES)) return;
    this.options.emit({ sessionId, folder: 'status', name: path.basename(entry.statusFile), content });
  }
}
