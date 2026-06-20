import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActivityStatsSnapshot } from '../../../shared/types';

/**
 * Async, per-session coalescing writer for activity-engine snapshots.
 *
 * Each session has at most ONE in-flight write at a time. Snapshots
 * arriving while a write is pending overwrite the queued snapshot - we
 * only care about the latest state for post-mortem, so intermediates
 * are dropped. This bounds disk I/O at one write per session per
 * setImmediate tick regardless of state-transition frequency.
 *
 * Replaces the prior synchronous writeFileSync + renameSync pair, which
 * blocked the main event loop on every activity transition. On Windows
 * with AV scanning that was 2-30 ms per transition; with 1-5 transitions/s
 * during active agent work, the cost on the critical path was significant.
 *
 * Atomicity: writes go to `<sessionId>.json.tmp` first, then rename over
 * the target. Partial reads of the JSON file by another tool will never
 * see a half-written document.
 *
 * Errors: best-effort. Disk full, permission errors, locked files are
 * swallowed so a debug-only feature can never crash the agent.
 */
export class ActivitySnapshotWriter {
  private readonly dumpDir: string;
  private dirReady = false;

  private readonly pending = new Map<string, ActivityStatsSnapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(dumpDir: string) {
    this.dumpDir = dumpDir;
  }

  /** Non-blocking. Disk write happens on the next setImmediate tick. */
  write(sessionId: string, snapshot: ActivityStatsSnapshot): void {
    this.pending.set(sessionId, snapshot);
    if (this.inFlight.has(sessionId)) return;
    const flushPromise = (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await this.drain(sessionId);
      } finally {
        this.inFlight.delete(sessionId);
      }
    })();
    this.inFlight.set(sessionId, flushPromise);
  }

  async remove(sessionId: string): Promise<void> {
    this.pending.delete(sessionId);
    const inFlightPromise = this.inFlight.get(sessionId);
    if (inFlightPromise) await inFlightPromise;
    if (!this.dirReady) return;
    try {
      await fs.promises.unlink(path.join(this.dumpDir, `${sessionId}.json`));
    } catch {
      // Best-effort.
    }
  }

  /** Test helper: await all pending writes across all sessions. */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      const inFlightPromises = Array.from(this.inFlight.values());
      await Promise.allSettled(inFlightPromises);
    }
  }

  private async drain(sessionId: string): Promise<void> {
    while (true) {
      const snapshot = this.pending.get(sessionId);
      if (!snapshot) return;
      this.pending.delete(sessionId);
      if (!(await this.ensureDir())) continue;
      const filePath = path.join(this.dumpDir, `${sessionId}.json`);
      const tmpPath = `${filePath}.tmp`;
      try {
        await fs.promises.writeFile(
          tmpPath,
          JSON.stringify(snapshot, null, 2),
          'utf-8'
        );
        await fs.promises.rename(tmpPath, filePath);
      } catch {
        // Best-effort.
      }
    }
  }

  private async ensureDir(): Promise<boolean> {
    if (this.dirReady) return true;
    try {
      await fs.promises.mkdir(this.dumpDir, { recursive: true });
      this.dirReady = true;
      return true;
    } catch {
      return false;
    }
  }
}
