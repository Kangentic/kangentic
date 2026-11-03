/**
 * Carries a session's hook files from the host to Kangentic (#913).
 *
 * An agent CLI on a host runs the session's hook script (`wsl-hook.sh`, the same POSIX script a WSL
 * distro uses), which only publishes files: events into `inbox/`, requests into `requests/`, and the
 * status line's JSON over `status.json`. Kangentic's half of the transport reads them from a folder on
 * its own disk. So the helper watches that folder here and sends each file across the link, and
 * Kangentic writes it into the same place on its side. After that nothing downstream knows the CLI was
 * remote: the inbox turns records into events, answers plan approvals, and relays MCP to the loopback
 * server, so the MCP token never leaves the app.
 *
 * - A file is sent once and removed from the host once it is sent. The link retains and replays what
 *   an interrupted connection lost, so a drop loses nothing already handed over.
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
}

export interface HookWatcherOptions {
  emit: (event: HookFileEvent) => void;
  intervalMs?: number;
  /** The most JSON characters a content may take once escaped, below the frame cap. */
  maxContentJsonChars?: number;
}

const DEFAULT_INTERVAL_MS = 100;
/** The frame's JSON cap is 256 KiB; the event around the content takes a little. */
const DEFAULT_MAX_CONTENT_JSON_CHARS = 200_000;
const RECORD_EXTENSION: Record<'inbox' | 'requests', string> = { inbox: '.rec', requests: '.req' };

interface Watched {
  directory: string;
  statusFile: string | null;
  statusSignature: string | null;
  scanning: boolean;
  /** Files already sent whose removal failed, so they are not sent twice. */
  sent: Set<string>;
}

/** The published files of a folder in the order their hooks ran. Names start with a dot while being written. */
export function publishedNames(names: readonly string[], extension: string): string[] {
  return names.filter((name) => !name.startsWith('.') && name.endsWith(extension)).sort();
}

function escapedLength(text: string): number {
  return JSON.stringify(text).length;
}

/**
 * A record that fits one frame. A hook record is three header lines (version, kind, arguments) and
 * the hook's stdin, usually a JSON object whose bulk is one large string (a file the agent wrote).
 * Strings are cut down until the whole fits, which keeps the object's shape and the tool name; if
 * that cannot be done the stdin is dropped and the header alone is sent.
 */
export function fitHookRecord(content: string, maxJsonChars: number): string {
  if (escapedLength(content) <= maxJsonChars) return content;
  let headerEnd = -1;
  for (let line = 0; line < 3; line += 1) {
    headerEnd = content.indexOf('\n', headerEnd + 1);
    if (headerEnd < 0) return content.slice(0, Math.max(0, Math.floor(maxJsonChars / 8)));
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
    if (escapedLength(header + trimmed) <= maxJsonChars) return header + trimmed;
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
    this.watched.set(sessionId, { directory, statusFile, statusSignature: null, scanning: false, sent: new Set() });
    if (!this.timer) {
      this.timer = setInterval(() => void this.scanAll(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /** Stop watching. Anything already published is sent first, so the exit's last records are not lost. */
  async unwatch(sessionId: string): Promise<void> {
    const entry = this.watched.get(sessionId);
    if (!entry) return;
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

  private async scan(sessionId: string, entry: Watched): Promise<void> {
    if (entry.scanning) return;
    entry.scanning = true;
    try {
      for (const folder of ['inbox', 'requests'] as const) {
        await this.scanFolder(sessionId, entry, folder);
      }
      await this.scanStatus(sessionId, entry);
    } catch (error) {
      // A folder the session removed under us, or an unreadable file: the next poll tries again.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[hook-watcher] ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      entry.scanning = false;
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
          content: fitHookRecord(content, this.options.maxContentJsonChars ?? DEFAULT_MAX_CONTENT_JSON_CHARS),
        });
        entry.sent.add(key);
      }
      // Removed once sent. A removal that fails leaves it in `sent`, so it is not sent again.
      if (await fs.rm(file, { force: true }).then(() => true, () => false)) entry.sent.delete(key);
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
    if (escapedLength(content) > (this.options.maxContentJsonChars ?? DEFAULT_MAX_CONTENT_JSON_CHARS)) return;
    this.options.emit({ sessionId, folder: 'status', name: path.basename(entry.statusFile), content });
  }
}
