import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import type { IpcLogEntry, IpcPayloadTruncated } from '../../shared/types';
import { queueAppendWithRotation } from './async-file-queue';

/**
 * Records every IPC handler invocation when `developer.recordIpcTraffic` is on.
 *
 * Implementation: monkey-patches `ipcMain.handle` once at install time, before
 * any handler registers. Each subsequent `ipcMain.handle(channel, fn)` call
 * gets the recorder injected automatically - no changes to the existing
 * handler files. Logs go to `<projectRoot>/.kangentic/logs/ipc-<date>.jsonl`.
 *
 * Privacy: this code can run with arbitrary task descriptions, prompts, and
 * settings flowing through. We default-deny: only channels in the
 * `SAFE_CHANNELS` allowlist log args + result in full. Everything else logs
 * `{ redacted: true, channel }`. Add to the allowlist as new diagnostic
 * channels arrive - never relax a redaction without auditing the payload.
 */

/**
 * Channels whose args + result are safe to log in full. These are read-only
 * surfaces that return board / session / task data already visible elsewhere
 * in the agent's context. Mutating channels (settings writes, attachment
 * uploads, MCP config writes) are deliberately omitted - their payloads can
 * carry secrets or large binary blobs.
 *
 * Synced manually with `src/shared/ipc-channels.ts`. New diagnostic /
 * read-only channels can be added; new mutating channels stay redacted.
 */
const SAFE_CHANNELS = new Set<string>([
  'project:list',
  'project:getCurrent',
  'projectGroup:list',
  'task:list',
  'task:list-archived',
  'swimlane:list',
  'session:list',
  'session:getActivity',
  'session:getActivityReason',
  'session:getActivityReasons',
  'session:getActivityStats',
  'session:getEvents',
  'session:getEventsCache',
  'session:getUsage',
  'session:getFirstOutput',
  'task:getSpawnProgress',
  'backlog:list',
  'search:everything',
  'system:getAppVersion',
  'system:detectAgent',
  'diagnostics:logAppend',
]);

/**
 * Outbound main -> renderer push channels whose args are safe to log in
 * full. These are the agent-driven board invalidation pushes; their
 * payloads are task / swimlane id + title + columnName + projectId, the
 * same data class already allowed inbound via `task:list`. Kept separate
 * from `SAFE_CHANNELS` because the traffic direction differs and the
 * default-deny audit story stays clean per set.
 */
const SAFE_PUSH_CHANNELS = new Set<string>([
  'task:createdByAgent',
  'task:updatedByAgent',
  'task:deletedByAgent',
  'task:sessionResync',
  'swimlane:updatedByAgent',
  'backlog:changedByAgent',
  'backlog:labelColorsChanged',
]);

const REDACTED = (channel: string) => ({ redacted: true as const, channel });

/**
 * Cap a serialized args/result payload at this many UTF-16 chars. Above it the
 * value is replaced with an `IpcPayloadTruncated` marker so the JSONL line stays
 * small. 32KB is generous for a normal diagnostic payload while cutting the
 * pathological cases (`task:list-archived`, `search:everything`) that stringify
 * ~1MB on the main thread.
 */
const MAX_SERIALIZED_PAYLOAD_CHARS = 32 * 1024;
/** How much of an over-cap payload's JSON to keep in the marker's preview. */
const TRUNCATION_PREVIEW_CHARS = 2 * 1024;
/** Per-day log file cap; the file rotates to `<file>.1` at this size (2x total on disk). */
const IPC_LOG_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Delete `ipc-<date>.jsonl(.1)` files older than this many days. */
const IPC_LOG_RETENTION_DAYS = 7;
/** Matches a daily IPC log file and its rotated copy, capturing the date. */
const IPC_LOG_FILE_PATTERN = /^ipc-(\d{4}-\d{2}-\d{2})\.jsonl(\.1)?$/;

/**
 * Replace an args/result value with a compact marker when its serialized form
 * exceeds the cap. Returns the value unchanged when it is within budget (or a
 * marker when it cannot be serialized at all). The stringify is paid once here;
 * with the archive fix removing the dominant offender, an over-cap value is a
 * rare, user-triggered event.
 */
function capOversizedPayload(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    const marker: IpcPayloadTruncated = { truncated: true, serializedChars: -1, preview: 'unserializable payload' };
    return marker;
  }
  if (serialized === undefined || serialized.length <= MAX_SERIALIZED_PAYLOAD_CHARS) return value;
  const marker: IpcPayloadTruncated = {
    truncated: true,
    serializedChars: serialized.length,
    preview: serialized.slice(0, TRUNCATION_PREVIEW_CHARS),
  };
  return marker;
}

interface IpcRecorderOptions {
  getProjectRoot: () => string | null;
  enabled: () => boolean;
  /** Per-day log-file rotation cap in bytes. Defaults to IPC_LOG_MAX_FILE_BYTES; overridable for tests. */
  maxLogFileBytes?: number;
}

let installed = false;
let recorderOptions: IpcRecorderOptions | null = null;
// Latch so the async retention prune runs at most once per project root per
// process. A Set (not a single last-root) so alternating between two projects
// (A -> B -> A) does not re-prune A. Cleared in resetForTest.
const prunedProjectRoots = new Set<string>();
let pendingPrunePromise: Promise<void> | null = null;

/**
 * Best-effort async prune of `ipc-*.jsonl(.1)` files older than the retention
 * window. Latched per project root so it runs once per process. Never on the
 * shutdown path (the before-quit contract stays synchronous); a slow readdir
 * only delays deletion, never a write.
 */
function schedulePruneOldIpcLogs(projectRoot: string): void {
  if (prunedProjectRoots.has(projectRoot)) return;
  prunedProjectRoots.add(projectRoot);
  const cutoffDate = new Date(Date.now() - IPC_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const logsDirectory = path.join(projectRoot, '.kangentic', 'logs');
  pendingPrunePromise = (async () => {
    try {
      const names = await fs.promises.readdir(logsDirectory);
      await Promise.allSettled(
        names
          .filter((name) => {
            const match = IPC_LOG_FILE_PATTERN.exec(name);
            // ISO date strings are zero-padded, so a lexical compare is a valid
            // chronological compare.
            return match !== null && match[1] < cutoffDate;
          })
          .map((name) => fs.promises.unlink(path.join(logsDirectory, name))),
      );
    } catch {
      // Best-effort: a missing logs dir or a locked file is non-fatal.
    }
  })();
}

export function installIpcRecorder(options: IpcRecorderOptions): void {
  if (installed) return;
  installed = true;
  recorderOptions = options;

  // Save the original implementation so we can delegate to it. Binding is
  // important because `ipcMain.handle` uses `this` internally.
  const originalHandle = ipcMain.handle.bind(ipcMain);

  // The replacement signature matches Electron's typings. We cast through
  // unknown because `ipcMain.handle` has many overloads we don't care about
  // here.
  (ipcMain as unknown as { handle: typeof ipcMain.handle }).handle = ((
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    originalHandle(channel, async (event, ...args) => {
      if (!options.enabled()) {
        return listener(event, ...args);
      }
      const start = performance.now();
      const ts = new Date().toISOString();
      let captured: unknown = undefined;
      let errorObj: Error | undefined;
      try {
        captured = await listener(event, ...args);
        return captured;
      } catch (error) {
        errorObj = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        const durationMs = performance.now() - start;
        const safe = SAFE_CHANNELS.has(channel);
        const entry: IpcLogEntry = errorObj
          ? {
              ts,
              channel,
              args: safe ? args : REDACTED(channel),
              durationMs,
              error: { name: errorObj.name, message: errorObj.message },
            }
          : {
              ts,
              channel,
              args: safe ? args : REDACTED(channel),
              result: safe ? captured : REDACTED(channel),
              durationMs,
            };
        writeEntry(options.getProjectRoot(), entry);
      }
    });
  }) as typeof ipcMain.handle;
}

/**
 * Record an outbound main -> renderer push (`webContents.send`). The IPC
 * recorder's `ipcMain.handle` patch only sees inbound invocations, so
 * pushes are invisible without this explicit hook. Call it from the send
 * chokepoint right after the send (or instead of it, with
 * `outcome.dropped`, when the window was destroyed and the push never
 * left). No-op until `installIpcRecorder` has run and the
 * `developer.recordIpcTraffic` toggle is on, mirroring the inbound gate.
 */
export function recordPush(
  channel: string,
  args: unknown[],
  outcome?: { dropped: true },
): void {
  if (!recorderOptions || !recorderOptions.enabled()) return;
  const safe = SAFE_PUSH_CHANNELS.has(channel);
  const entry: IpcLogEntry = {
    ts: new Date().toISOString(),
    channel,
    direction: 'out',
    args: safe ? args : REDACTED(channel),
    durationMs: 0,
    ...(outcome?.dropped
      ? { error: { name: 'PushDropped', message: 'mainWindow destroyed; push not delivered' } }
      : {}),
  };
  writeEntry(recorderOptions.getProjectRoot(), entry);
}

function writeEntry(projectRoot: string | null, entry: IpcLogEntry): void {
  if (!projectRoot) return;
  schedulePruneOldIpcLogs(projectRoot);
  const date = entry.ts.slice(0, 10);
  const file = path.join(projectRoot, '.kangentic', 'logs', `ipc-${date}.jsonl`);
  // Serialize the whole entry once. In the common case it is within the cap and
  // is written directly - no extra per-field stringify. Only an oversized entry
  // pays the per-field capping pass, which replaces the offending args/result
  // with a compact marker so the recorder never serializes a multi-MB result in
  // full a second time. Because every field's JSON is a substring of the entry's
  // JSON, an entry within the per-payload cap cannot contain an over-cap field,
  // so the fast path is exact, not a heuristic. Chokepointed here so both the
  // inbound `finally` path and `recordPush` are covered.
  let line = JSON.stringify(entry);
  if (line.length > MAX_SERIALIZED_PAYLOAD_CHARS) {
    const capped: IpcLogEntry = { ...entry, args: capOversizedPayload(entry.args) as IpcLogEntry['args'] };
    if (entry.result !== undefined) capped.result = capOversizedPayload(entry.result);
    line = JSON.stringify(capped);
  }
  // Async-buffered + size-capped rotation: queueAppendWithRotation returns
  // immediately. The previous appendFileSync ran inside the IPC handler's
  // `finally`, blocking the main event loop on every IPC call (incl.
  // IPC.SESSION_WRITE per terminal keystroke). On Windows that costs 5-50 ms
  // per call and was the dominant source of typing-stutter when
  // recordIpcTraffic is on. Rotation bounds each day's file at 2x the cap so
  // `.kangentic/logs/` stops accumulating unbounded gigabytes.
  const maxBytes = recorderOptions?.maxLogFileBytes ?? IPC_LOG_MAX_FILE_BYTES;
  queueAppendWithRotation(file, line + '\n', maxBytes);
}

/**
 * Exported for unit tests only. `resetForTest` lets the suite clear the
 * install latch + captured options between `vi.resetModules` cycles so a
 * `recordPush` call before install is exercised as a true no-op.
 */
export const __INTERNAL = {
  SAFE_CHANNELS,
  SAFE_PUSH_CHANNELS,
  MAX_SERIALIZED_PAYLOAD_CHARS,
  IPC_LOG_RETENTION_DAYS,
  resetForTest(): void {
    installed = false;
    recorderOptions = null;
    prunedProjectRoots.clear();
    pendingPrunePromise = null;
  },
  /** Await the in-flight retention prune (best-effort). */
  async awaitPendingPruneForTest(): Promise<void> {
    if (pendingPrunePromise) await pendingPrunePromise;
  },
};
