import type { BrowserCapability } from './browser-pane-driver';

/**
 * Structured record of one CDP drive, emitted after the pane resolves.
 *
 * The reported bug was invisible. `tool-call-logging.ts` inspects only
 * create_task / update_task, so no browser tool call recorded its caller: there
 * was no log line, no warning and no UI trace, which is why three subagents
 * fighting over one pane had to be spotted by eye.
 *
 * This lives in `withGuest` rather than in the MCP request logger for a
 * concrete reason: the request logger sees only the POST body, so it has no
 * guest id, no resolved pane and no idea whether the call queued. `withGuest`
 * after resolution is the only place all of those coexist.
 *
 * ## Reading contention out of this, honestly
 *
 * Concurrency ALONE is not evidence of multiple callers. An agent can issue
 * parallel tool calls within one turn, so a `wait` and a `screenshot` in flight
 * on one guest is ordinary. And subagents all inherit their parent's
 * `callerSessionId`, so identity alone cannot separate them either.
 *
 * What distinguishes the two is SHAPE. One agent's parallel calls are a brief
 * blip of depth 2. A fan-out is sustained depth over minutes. So the record
 * carries the queue depth seen at acquisition and how long the call waited,
 * and the warning below fires on sustained contention rather than on the first
 * overlap.
 */
export interface DriveTelemetryRecord {
  capability: BrowserCapability;
  /** MCP URL caller. Subagents share their parent's, which is the open problem. */
  callerSessionId: string | undefined;
  callerTaskId: string | undefined;
  /** The pane actually resolved, which may differ from the caller's own. */
  resolvedSessionId: string;
  resolvedTaskId: string;
  projectId: string | null;
  webContentsId: number;
  /** Drives queued or running on this guest when this one asked for its turn. */
  queueDepthAtEntry: number;
  /** Milliseconds spent waiting for the guest. 0 when uncontended. */
  waitedMs: number;
  durationMs: number;
  outcome: 'ok' | string;
}

/**
 * Depth at which a drive is worth warning about.
 *
 * 2 is normal (one agent's parallel tool calls). 3+ concurrent drives on one
 * guest is the reported shape, and is worth saying out loud.
 */
const CONTENTION_DEPTH_THRESHOLD = 3;

/** Wait beyond which a drive was materially delayed rather than merely queued. */
const CONTENTION_WAIT_MS = 1000;

export function logDrive(record: DriveTelemetryRecord): void {
  const caller = record.callerSessionId ? record.callerSessionId.slice(0, 8) : 'unattributed';
  const base =
    `[browser-drive] cap=${record.capability} caller=${caller} ` +
    `pane=${record.resolvedSessionId.slice(0, 8)} wc=${record.webContentsId} ` +
    `depth=${record.queueDepthAtEntry} waited=${record.waitedMs}ms ` +
    `dur=${record.durationMs}ms outcome=${record.outcome}`;

  if (record.queueDepthAtEntry >= CONTENTION_DEPTH_THRESHOLD || record.waitedMs >= CONTENTION_WAIT_MS) {
    // Named so it is greppable, and phrased so the reader knows what it means:
    // several callers are sharing one pane, which is legal but is what produces
    // the "each subagent believed it had exclusive control" failure.
    console.warn(
      `${base} CONTENTION - ${record.queueDepthAtEntry} drives are sharing this Browser pane. ` +
        'Concurrent workers should each open their own pane rather than share one.',
    );
    return;
  }

  console.log(base);
}
