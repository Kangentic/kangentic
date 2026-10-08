/**
 * The messages between main and the pty host (`kangentic-pty-host`, see
 * `pty-host-entry.ts`), the utility process that owns every node-pty instance
 * and the per-chunk work on its output: the headless xterm, the scrollback
 * ring, the raw transcript, and the adapters' output detectors.
 *
 * Three kinds travel over one ordered channel:
 * - Commands, main to host, fire-and-forget (`PtyHostCommand`). Order is the
 *   contract: a write posted before a kill lands before it.
 * - Requests, main to host, answered once (`PtyHostRequest`, matched by id).
 * - Events, host to main (`PtyHostEvent`), in the order the host produced them.
 *   A reply and the events around it keep that order too, which is what the
 *   scrollback replay relies on: data flushed before a sample arrives before
 *   the sample's reply.
 *
 * Every field is plain data, because the utility process path structured-clones
 * it. The in-process host used by unit tests passes the same objects by
 * reference.
 */

import type { ActivityState, SessionEvent, SessionUsage } from '../../../shared/types';
import type { StopProcessRequest, StopProcessResult, TaggedReapRequest, TaggedReapResult } from '../process-tag/tagged-reap';

/** Where and how to spawn one PTY, plus the session state the host keeps. */
export interface PtyHostSpawnParams {
  /** Main's id for this PTY, unique for the life of the main process. A
   *  session id is not enough: a respawn can reuse it while the old PTY is
   *  still exiting. */
  ptyId: number;
  sessionId: string;
  projectId: string;
  /** The adapter's registry name, so the host can run its output detectors.
   *  Null for a session with no agent (a bare shell, a script). */
  agentName: string | null;
  /** A Command Terminal: no transcript, no pre-TUI strip. */
  transient: boolean;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** The session whose scrollback and geometry the new one inherits (a
   *  resume or respawn). Its state stays: main drops the task's earlier
   *  sessions with `removeSession` once it knows the spawn was not cancelled
   *  in the round trip, so a cancel leaves them as they were. */
  carryoverFromSessionId: string | null;
  /** The agent's own session id is already known (caller-owned id), so the
   *  host need not scan the output for one. */
  agentSessionIdKnown: boolean;
}

/** A thrown error, flattened for the wire. */
export interface PtyHostError {
  message: string;
  code?: string;
  errno?: number;
  stack?: string;
}

/** A short-lived PTY with no session behind it (the Claude model picker
 *  probe, the Antigravity print runner): its output goes back to main raw,
 *  with none of the session pipeline. */
export interface PtyHostRawSpawnParams {
  ptyId: number;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  name: string;
}

export type PtyHostRawSpawnResult =
  | { ok: true; pid: number }
  | { ok: false; error: PtyHostError };

/** An agent CLI's headless run with piped stdio (`off-main-cli.ts`). */
export interface PtyHostCliSpawnParams {
  /** Main's id for this run, unique for the life of the main process. */
  processId: number;
  command: string;
  args: string[];
  cwd: string;
  /** Run through the platform shell (a Windows `.cmd` or `.bat` shim). */
  shell: boolean;
  env: Record<string, string>;
  /** Lead a process group (POSIX), so a stop signals what the CLI started. */
  detached: boolean;
}

export type PtyHostSpawnResult =
  | { ok: true; pid: number }
  /** The spawn threw. `previousScrollback` is the carry-over the host had read,
   *  so main can show it with the failure's diagnostic. */
  | { ok: false; error: PtyHostError; previousScrollback: string };

export type PtyHostCommand =
  | { type: 'write'; ptyId: number; data: string }
  /** Reshape the PTY itself (the child sees a SIGWINCH). */
  | { type: 'resizePty'; ptyId: number; cols: number; rows: number }
  /** Reshape the session's headless parser and arm the repaint settle. */
  | { type: 'resizeBuffer'; sessionId: string; cols: number; rows: number }
  /** A PTY resize was applied: start the redraw grace that keeps the repaint
   *  from reading as new activity. */
  | { type: 'markResized'; sessionId: string }
  | { type: 'kill'; ptyId: number }
  /** The union of every renderer's visible sessions: only these emit `data`. */
  | { type: 'setFocused'; sessionIds: string[] }
  /** Sessions a phone streams: these emit `tap` for every flushed byte. */
  | { type: 'setTapped'; sessionIds: string[] }
  /** The renderer consumed this many characters of a session's output. */
  | { type: 'ack'; sessionId: string; bytes: number }
  /** Forget these sessions' in-flight accounting and resume their PTYs. */
  | { type: 'releaseBackpressure'; sessionIds: string[] }
  /** The session's activity changed; the host's redraw filter reads it. */
  | { type: 'setActivity'; sessionId: string; activity: ActivityState }
  /** The agent's session id was captured another way; stop scanning for it. */
  | { type: 'setAgentSessionIdKnown'; sessionId: string }
  | { type: 'finalizeTranscript'; sessionId: string }
  /** The session left main's registry: drop everything the host keeps for it. */
  | { type: 'removeSession'; sessionId: string }
  /** Seed a session's ring with no PTY behind it (a failed spawn's diagnostic). */
  | { type: 'initSession'; sessionId: string; scrollback: string; cols: number }
  /** Start an agent CLI run. A command, so main has its handle at once; a
   *  spawn that fails comes back as `cliError`. */
  | { type: 'cliSpawn'; params: PtyHostCliSpawnParams }
  | { type: 'cliWrite'; processId: number; data: string }
  /** End the run's stdin, after writing `data` when given. */
  | { type: 'cliEndInput'; processId: number; data?: string }
  /** Stop the run and what it started (`taskkill /T /F` on Windows, the
   *  process group's SIGTERM then SIGKILL on POSIX). */
  | { type: 'cliStop'; processId: number }
  /** The app is quitting: flush every transcript. Main has already posted
   *  every kill (a young session's after its grace). The utility process then
   *  waits for the exit callbacks and exits itself, so none lands after Node
   *  has stopped (Sentry DESKTOP-C, now in this process). `exitWaitMs` bounds
   *  that wait inside main's quit drain, so the host is gone before main stops
   *  waiting for it. */
  | { type: 'shutdown'; exitWaitMs?: number };

export interface PtyHostPipelineStats {
  sessionId: string;
  pendingBytes: number;
  scrollbackBytes: number;
  paused: boolean;
  inFlightBytes: number;
}

export interface PtyHostDimensionStats {
  sessionId: string;
  lastCols: number;
  lastRows: number;
  pendingRepaintAt: number | null;
  pendingRepaintStacked: boolean;
  inAltScreen: boolean;
  geometryChangedAtRingIndex: number | null;
}

export interface PtyHostDiagnostics {
  pipeline: PtyHostPipelineStats[];
  dimensions: PtyHostDimensionStats[];
}

/** What a one-shot child process may be given. Encoding is always utf8. */
export interface HostExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
}

/** A one-shot child process for the host to run: `exec` through a shell, or
 *  `execFile` without one, as `node:child_process` names them. */
export type HostExecRequest =
  | { kind: 'exec'; command: string; options: HostExecOptions }
  | { kind: 'execFile'; file: string; args: string[]; options: HostExecOptions };

/** A failed run, with what `promisify(exec)` attaches to its rejection. */
export interface HostExecFailure extends PtyHostError {
  /** The exit status, when the process ran and exited non-zero. */
  exitCode: number | null;
  killed: boolean;
  signal: string | null;
  stdout: string;
  stderr: string;
  cmd?: string;
}

export type HostExecResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: HostExecFailure };

/** One row of the process table, as the process-tree probe reports it. */
export interface HostProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
}

/**
 * Scrollback rows the headless parser retains and a seed frame includes by
 * default. The CURRENT on-screen grid is always serialized in full regardless
 * of this value; these rows give the phone a little history above the fold.
 * A few hundred lines is ample for a phone seed and keeps both the retained
 * buffer and the per-serialize cost bounded. It is shared so the phone's
 * read-stream handler can ask for fewer rows when a seed would not fit the
 * wire (`getSeedFrame`'s `scrollbackLines`) and scale that request from this.
 */
export const SERIALIZED_SCROLLBACK_LINES = 500;

/**
 * The phone's seed frame with the parser offset its snapshot covers, so tap
 * chunks at or before `barrierOffset` can be dropped as already seeded, and
 * the time spent in the repaint settle and in the serialize.
 */
export interface SeedFrameResult {
  frame: string;
  barrierOffset: number;
  settleMs: number;
  serializeMs: number;
}

export interface PtyHostRequestMap {
  spawn: { params: PtyHostSpawnParams; result: PtyHostSpawnResult };
  /** The desktop replay. `settle` waits for a pending resize's repaint first,
   *  which only a live PTY can deliver. */
  getScrollback: { params: { sessionId: string; settle: boolean }; result: string };
  /** The parsed-grid frame, with the same settle (the prompt-options probe). */
  getSerializedFrame: { params: { sessionId: string; settle: boolean }; result: string };
  /** The phone's seed frame, with the same settle (see SeedFrameResult).
   *  `scrollbackLines` caps the history rows above the grid (default
   *  SERIALIZED_SCROLLBACK_LINES); 0 serializes the grid alone. */
  getSeedFrame: { params: { sessionId: string; settle: boolean; scrollbackLines?: number }; result: SeedFrameResult };
  getRawScrollback: { params: { sessionId: string }; result: string };
  getOutputPeek: { params: { sessionId: string }; result: string[] };
  getDiagnostics: { params: Record<string, never>; result: PtyHostDiagnostics };
  ping: { params: Record<string, never>; result: 'pong' };
  /** Close the host's handle on a project's database. A request, not a
   *  command, so a project delete can wait for it before unlinking the file
   *  (Windows will not unlink a file another process has open). */
  closeProject: { params: { projectId: string }; result: true };
  /** Run a one-shot child process here, so its CreateProcess (synchronous on
   *  the calling thread on Windows) does not block main. */
  exec: { params: HostExecRequest; result: HostExecResult };
  /** The whole process table, from `host-process-table.ts`: a Toolhelp
   *  snapshot on Windows, `ps` on POSIX. */
  listProcesses: { params: Record<string, never>; result: HostProcessInfo[] };
  /** Kill what these tasks left running: processes carrying a task's
   *  `KANGENTIC_TASK_ID` tag and working inside its directories, minus what is
   *  shared or protected (`process-tag/reap-plan.ts`). Concurrent requests
   *  share one scan. */
  reapTaggedProcesses: { params: TaggedReapRequest; result: TaggedReapResult };
  /** Stop one process a reap reported, and everything under it, after the
   *  user asked for it by name; its identity is re-checked first. */
  stopReportedProcess: { params: StopProcessRequest; result: StopProcessResult };
  /** Spawn a raw PTY (no session). `write`, `resizePty` and `kill` reach it
   *  by its ptyId like any other; its output arrives as `rawData`. */
  spawnRaw: { params: PtyHostRawSpawnParams; result: PtyHostRawSpawnResult };
}

export type PtyHostMethod = keyof PtyHostRequestMap;

export interface PtyHostRequest<M extends PtyHostMethod = PtyHostMethod> {
  type: 'request';
  id: number;
  method: M;
  params: PtyHostRequestMap[M]['params'];
}

export type PtyHostEvent =
  | { type: 'exit'; ptyId: number; sessionId: string; exitCode: number }
  /** Output for a focused session, in flush-sized slices. */
  | { type: 'data'; sessionId: string; data: string }
  /** Output for a tapped session: every flushed slice, and the bytes a replay
   *  sample drained before they could flush. `endOffset` is the cumulative
   *  parser offset just past `data` (compare getSeedFrame's barrierOffset). */
  | { type: 'tap'; sessionId: string; data: string; endOffset: number }
  /** The adapter's first-output marker. `inAltScreen` is the stream's state
   *  at that moment. */
  | { type: 'firstOutput'; sessionId: string; inAltScreen: boolean }
  | { type: 'altScreen'; sessionId: string; inAltScreen: boolean }
  /** The PTY produced output. Coalesced in the utility process; each carries
   *  how many chunks it stands for. */
  | { type: 'outputSeen'; sessionId: string; chunks: number }
  /** The adapter's idle detector matched. */
  | { type: 'ptyIdle'; sessionId: string }
  /** Output that is not a redraw: new activity. Coalesced like `outputSeen`. */
  | { type: 'ptyData'; sessionId: string }
  | { type: 'agentSessionId'; sessionId: string; capturedId: string }
  | { type: 'streamTelemetry'; sessionId: string; usage?: Partial<SessionUsage>; events?: SessionEvent[] }
  /** A terminal lifecycle trace entry (dev builds only). */
  | { type: 'trace'; sessionId: string; event: string; detail?: Record<string, unknown>; ts: number }
  /** Output of a raw PTY, every chunk as it arrives. */
  | { type: 'rawData'; ptyId: number; data: string }
  | { type: 'rawExit'; ptyId: number; exitCode: number; signal: number | null }
  /** An agent CLI run started (its `spawn` event). */
  | { type: 'cliSpawned'; processId: number; pid: number | null }
  /** A chunk of its stdout or stderr, as the bytes arrived. */
  | { type: 'cliData'; processId: number; stream: 'stdout' | 'stderr'; data: Uint8Array }
  | { type: 'cliError'; processId: number; error: PtyHostError }
  | { type: 'cliExit'; processId: number; code: number | null; signal: string | null }
  /** Its stdio closed, after the last `cliData`; the run is over. */
  | { type: 'cliClose'; processId: number; code: number | null; signal: string | null };

export type PtyHostReply =
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: PtyHostError };

/** The first message to a utility host: what it cannot work out itself (it is
 *  forked with no arguments, so a `--data-dir` override never reaches it). */
export interface PtyHostInitMessage {
  type: 'init';
  projectsDir: string;
  /** Main's executable, so the host refuses to launch it too: on macOS the
   *  host runs from the Helper bundle, whose `execPath` is not the app's. */
  mainExecutable?: string;
}

/** Everything main sends the utility process. */
export type ToPtyHostMessage = PtyHostInitMessage | PtyHostCommand | PtyHostRequest;

/** Everything the utility process sends main. */
export type FromPtyHostMessage =
  | PtyHostEvent
  | PtyHostReply
  /** Initialized; requests are answered from here on. */
  | { type: 'ready' }
  /** A console line, for main's log. */
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  /** A span of 16 ms or more on the host's thread (dev builds only). */
  | { type: 'slow-span'; label: string; ms: number };

export function toPtyHostError(error: unknown): PtyHostError {
  if (error instanceof Error) {
    const errno = error as NodeJS.ErrnoException;
    return {
      message: error.message,
      code: typeof errno.code === 'string' ? errno.code : undefined,
      errno: typeof errno.errno === 'number' ? errno.errno : undefined,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

/** Rebuild a thrown-looking Error from its wire form, keeping code and errno
 *  for callers that classify on them. */
export function fromPtyHostError(wire: PtyHostError): Error {
  const error = new Error(wire.message) as NodeJS.ErrnoException;
  if (wire.code !== undefined) error.code = wire.code;
  if (wire.errno !== undefined) error.errno = wire.errno;
  if (wire.stack !== undefined) error.stack = wire.stack;
  return error;
}
