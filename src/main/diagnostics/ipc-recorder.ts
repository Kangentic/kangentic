import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import type { IpcLogEntry, IpcPayloadTruncated } from '../../shared/types';
import { queueAppendWithRotation } from './async-file-queue';
import { timeSyncWork } from './event-loop-lag';

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
  'task:prLinkChanged',
  // A bare project id, sent after a task write from the detached Agent Monitor.
  'task:changedInOtherWindow',
  'swimlane:updatedByAgent',
  'backlog:changedByAgent',
  'backlog:labelColorsChanged',
  // A task id and a display label ("Switching model...", "Removing worktree
  // (waiting 45s)"); nothing sensitive, and the label is the evidence a
  // respawn-vs-park question turns on.
  'task:spawnProgress',
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

/** Objects nested deeper than this are counted as empty: a cycle must not recurse forever. */
const MAX_MEASURE_DEPTH = 32;
/** What a number, boolean or null takes from the preview's budget. Rough on purpose: the preview is clipped to its length afterwards. */
const PRIMITIVE_CHARS = 8;

/** An object JSON serializes as whatever its `toJSON` returns: a Date, a Buffer. */
function hasToJson(node: object): boolean {
  return typeof (node as { toJSON?: unknown }).toJSON === 'function';
}

/**
 * A member that may add nothing to an object's JSON, key and all: JSON leaves
 * out undefined, a function and a symbol, and a `toJSON` may return any of them.
 */
function mayBeLeftOutOfJson(member: unknown): boolean {
  if (member === undefined || typeof member === 'function' || typeof member === 'symbol') return true;
  return typeof member === 'object' && member !== null && hasToJson(member);
}

/**
 * The fewest characters `value` can serialize to, counted without serializing
 * it and stopped as soon as the count passes `limit`. The cost is bounded by
 * the limit, never by the payload: a 2.2 MB `task:list` result (800 tasks)
 * cost main up to 5 ms per call while it was stringified whole, as much as
 * the handler that produced it.
 *
 * Every term is a floor, so a count over the limit means the JSON is over it
 * too. A string is its length and two quotes, and escapes only add. A number
 * is at least one character, `true` and `null` are four, and a member JSON
 * leaves out adds nothing. An object with `toJSON` serializes to whatever
 * that returns, so it counts as nothing. The count was once eight per
 * primitive, which put 5,000 small integers (10 KB of JSON) over a 32 KB cap
 * and swapped them for a marker whose size was not a lower bound.
 */
function serializedCharsUpTo(value: unknown, limit: number): number {
  let counted = 0;
  const visit = (node: unknown, depth: number): void => {
    if (typeof node === 'string') {
      counted += node.length + 2;
      return;
    }
    if (typeof node === 'number' || typeof node === 'bigint') {
      counted += 1;
      return;
    }
    if (node === null || typeof node !== 'object') {
      // `true` and `null`, and what an array holds as `null`: undefined, a function, a symbol.
      counted += 4;
      return;
    }
    if (hasToJson(node)) return;
    counted += 2;
    if (depth >= MAX_MEASURE_DEPTH) return;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length && counted <= limit; index++) {
        if (index > 0) counted += 1;
        visit(node[index], depth + 1);
      }
      return;
    }
    let isFirstMember = true;
    for (const key in node) {
      if (counted > limit) return;
      if (!Object.hasOwn(node, key)) continue;
      const member = (node as Record<string, unknown>)[key];
      if (mayBeLeftOutOfJson(member)) continue;
      // The quoted key and its colon, and a comma before every member but the first.
      counted += key.length + (isFirstMember ? 3 : 4);
      isFirstMember = false;
      visit(member, depth + 1);
    }
  };
  visit(value, 0);
  return counted;
}

/**
 * A copy of `value` cut down to about `budget` characters: strings clipped,
 * and the children of an array or object dropped once the budget is spent.
 * Only the marker's preview is built from it.
 */
function pruneToBudget(value: unknown, budget: number): unknown {
  let remaining = budget;
  const visit = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') {
      const clipped = node.length > remaining ? node.slice(0, Math.max(0, remaining)) : node;
      remaining -= clipped.length + 2;
      return clipped;
    }
    if (node === null || typeof node !== 'object') {
      remaining -= PRIMITIVE_CHARS;
      return node;
    }
    remaining -= 2;
    if (depth >= MAX_MEASURE_DEPTH) return Array.isArray(node) ? [] : {};
    if (Array.isArray(node)) {
      const items: unknown[] = [];
      for (let index = 0; index < node.length && remaining > 0; index++) items.push(visit(node[index], depth + 1));
      return items;
    }
    const pruned: Record<string, unknown> = {};
    for (const key in node) {
      if (remaining <= 0) break;
      remaining -= key.length + 4;
      pruned[key] = visit((node as Record<string, unknown>)[key], depth + 1);
    }
    return pruned;
  };
  return visit(value, 0);
}

/**
 * Replace an args/result value with a marker when it is far over the cap,
 * without serializing it. The marker's size is what was counted before the
 * count stopped, so it is a lower bound (`atLeast`). A value the count finds
 * within the cap is returned as it is, for the exact check in `serializeAndQueue`.
 */
function boundOversizedPayload(value: unknown): unknown {
  let counted: number;
  try {
    counted = serializedCharsUpTo(value, MAX_SERIALIZED_PAYLOAD_CHARS);
  } catch {
    // report-ok: a getter or a proxy trap threw while the payload was read. The marker says it could not be read, and the recorder must never fail the IPC call it is recording.
    const unreadable: IpcPayloadTruncated = { truncated: true, serializedChars: -1, preview: 'unserializable payload' };
    return unreadable;
  }
  if (counted <= MAX_SERIALIZED_PAYLOAD_CHARS) return value;
  let preview = 'unserializable payload';
  try {
    preview = (JSON.stringify(pruneToBudget(value, TRUNCATION_PREVIEW_CHARS * 2)) ?? '').slice(0, TRUNCATION_PREVIEW_CHARS);
  } catch {
    // report-ok: a payload JSON cannot hold (a BigInt). The marker says so, and the recorder must never fail the IPC call it is recording.
  }
  const marker: IpcPayloadTruncated = { truncated: true, serializedChars: counted, atLeast: true, preview };
  return marker;
}

/**
 * Replace an args/result value with a compact marker when its serialized form
 * exceeds the cap. Returns the value unchanged when it is within budget (or a
 * marker when it cannot be serialized at all). Runs only on a value
 * `boundOversizedPayload` already found near the cap, so this stringify is
 * bounded too.
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

/** Timed under this label, so the diagnostics budget sees what recording costs main. */
const RECORD_LABEL = 'diag:ipc-record';

/**
 * The entry as one JSON line, or null when JSON cannot hold it. This runs in
 * the `finally` of every recorded handler, where a throw would replace the
 * handler's own answer: a handler that returned a BigInt would fail its IPC
 * call only because recording was on.
 */
function serializeEntry(entry: IpcLogEntry): string | null {
  try {
    return JSON.stringify(entry);
  } catch {
    // report-ok: a payload JSON cannot hold. The caller caps the offending field to a marker and tries again, so nothing is lost but that one value.
    return null;
  }
}

function writeEntry(projectRoot: string | null, entry: IpcLogEntry): void {
  if (!projectRoot) return;
  timeSyncWork(RECORD_LABEL, () => serializeAndQueue(projectRoot, entry));
}

function serializeAndQueue(projectRoot: string, entry: IpcLogEntry): void {
  schedulePruneOldIpcLogs(projectRoot);
  const date = entry.ts.slice(0, 10);
  const file = path.join(projectRoot, '.kangentic', 'logs', `ipc-${date}.jsonl`);
  // First swap any payload far over the cap for a marker, by counting it and
  // never serializing it, so what is stringified below is small whatever the
  // handler returned.
  const boundedArgs = boundOversizedPayload(entry.args) as IpcLogEntry['args'];
  const boundedResult = entry.result === undefined ? undefined : boundOversizedPayload(entry.result);
  const bounded: IpcLogEntry = boundedArgs === entry.args && boundedResult === entry.result
    ? entry
    : { ...entry, args: boundedArgs, ...(boundedResult === undefined ? {} : { result: boundedResult }) };
  // Then serialize the whole entry once. In the common case it is within the
  // cap and is written directly. The count above is a floor, so an entry it let
  // through can still be over: that one pays the exact per-field pass. Because
  // every field's JSON is a substring of the entry's JSON, an entry within the
  // cap cannot contain an over-cap field. Chokepointed here so both the inbound
  // `finally` path and `recordPush` are covered.
  let line = serializeEntry(bounded);
  if (line === null || line.length > MAX_SERIALIZED_PAYLOAD_CHARS) {
    const capped: IpcLogEntry = { ...bounded, args: capOversizedPayload(bounded.args) as IpcLogEntry['args'] };
    if (bounded.result !== undefined) capped.result = capOversizedPayload(bounded.result);
    line = serializeEntry(capped);
  }
  if (line === null) return;
  // Async-buffered + size-capped rotation: queueAppendWithRotation returns
  // immediately. The previous appendFileSync ran inside the IPC handler's
  // `finally`, blocking the main event loop on every IPC call (then including
  // every terminal keystroke, which crossed main until each renderer got its
  // own port to the pty host). On Windows that costs 5-50 ms per call and was
  // the dominant source of typing-stutter when recordIpcTraffic is on. Rotation bounds each day's file at 2x the cap so
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
