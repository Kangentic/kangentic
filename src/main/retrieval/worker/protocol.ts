/**
 * The messages between the retrieval worker (`retrieval-worker.ts`, the
 * `kangentic-retrieval` utility process) and its client in main
 * (`retrieval-client.ts`).
 *
 * The worker owns every read and write of the retrieval index: the `memory_*`
 * tables, the vec0 and full-text tables, the turn-usage ledger and the task
 * summaries. Main schedules work and asks for results; it never runs a
 * retrieval query itself. Both processes open the same WAL database file, so
 * SQLite lets one of them write at a time (see `db/transaction.ts`).
 *
 * `RetrievalMethods` is the one list of what the worker answers: a method's
 * params and result types are declared once here and checked on both sides.
 */

import type { RetrievalMethods } from './methods';
import type { KnowledgeGraphBuildProgress } from '../../../shared/types';
import type { VecLoadCause } from '../vec-load-cause';

export type { RetrievalMethods };
export type RetrievalMethod = keyof RetrievalMethods;
export type MethodParams<Method extends RetrievalMethod> = RetrievalMethods[Method]['params'];
export type MethodResult<Method extends RetrievalMethod> = RetrievalMethods[Method]['result'];

/** Sent once, right after the fork: what the worker cannot work out itself. A
 *  worker is forked with no arguments, so it cannot see `--data-dir`, and it
 *  has no `app` to resolve the unpacked sqlite-vec binary with. */
export interface InitMessage {
  type: 'init';
  /** Where the project databases are (`PATHS.projectsDir` in main). */
  projectsDir: string;
  /** The sqlite-vec loadable binary, or null when main could not resolve it. */
  vecLoadablePath: string | null;
  /** The checkpoint thread's bundle (`retrieval-checkpoint-thread.js`, unpacked
   *  in a packaged build). Absent or null: checkpoints run on the worker's loop. */
  checkpointThreadPath?: string | null;
}

export interface RequestMessage<Method extends RetrievalMethod = RetrievalMethod> {
  type: 'request';
  id: number;
  method: Method;
  params: MethodParams<Method>;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export type ToWorkerMessage = InitMessage | RequestMessage | ShutdownMessage;

export interface ReadyMessage {
  type: 'ready';
}

export type ReplyMessage =
  | { type: 'reply'; id: number; ok: true; result: unknown }
  /** `errorName` and `errorCode` keep the failure's class and errno across the
   *  process line, so main can tell a SQLite lock from a defect. Optional: an
   *  older worker sends the message alone. */
  | { type: 'reply'; id: number; ok: false; error: string; errorName?: string; errorCode?: string };

/**
 * A failure the worker handled and main should hear of, by a fixed code. The
 * worker cannot import Sentry (`retrieval-out-of-process.md`), so main reports
 * it. Sent once per worker run.
 */
export interface HandledErrorMessage {
  type: 'handledError';
  code: 'sqlite_vec_load';
  errorName?: string;
  errorCode?: string;
  /** Why the loader refused the extension, read from SQLite's message in the
   *  worker (`vec-load-cause.ts`). The message itself never crosses. */
  loadCause?: VecLoadCause;
  /** Whether the extension's file was at the path main resolved. */
  fileExists?: boolean;
}

/** Something main should react to that the worker noticed on its own. */
export type RetrievalEventName =
  /** A project's graph snapshot shows something new: a map rebuilt, records swept. */
  | 'graph-changed'
  /** A first build moved on. Carries `progress`, so nothing reads the snapshot for it. */
  | 'graph-progress';

export interface EventMessage {
  type: 'event';
  event: RetrievalEventName;
  projectId: string;
  /** With `graph-progress` only. */
  progress?: KnowledgeGraphBuildProgress;
}

/** A synchronous span the worker measured at 16 ms or more, relayed so main's
 *  dev lag report can name work that ran in the worker. */
export interface SlowSpanMessage {
  type: 'slow-span';
  label: string;
  ms: number;
}

/** The shortest write hold the worker posts to main. A shorter one cannot
 *  explain a write on main that waited out its 5 s busy timeout. */
export const LONG_WRITE_HOLD_MS = 1_000;

/** A write transaction of the worker's that held the database's lock at
 *  least `LONG_WRITE_HOLD_MS`, posted when it committed, in production too.
 *  Main keeps the recent ones for a `SQLITE_BUSY` report's `sqlite_busy`
 *  context (`src/main/diagnostics/sqlite-busy-holders.ts`, Sentry DESKTOP-5V). */
export interface WriteHoldMessage {
  type: 'write-hold';
  heldMs: number;
}

/** The message the worker posts for a committed hold of `heldMs`, or null for one too short to post. */
export function writeHoldMessageFor(heldMs: number): WriteHoldMessage | null {
  return heldMs >= LONG_WRITE_HOLD_MS ? { type: 'write-hold', heldMs: Math.round(heldMs) } : null;
}

/** A line the worker logged. Its stdout goes nowhere and its stderr is kept
 *  for crash reports, so its console reaches main's log this way. */
export interface LogMessage {
  type: 'log';
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export type FromWorkerMessage = ReadyMessage | ReplyMessage | EventMessage | SlowSpanMessage | LogMessage | HandledErrorMessage | WriteHoldMessage;

/** The class and errno of a thrown value, for the wire. Names that are not class names are left out. */
export function errorShapeOf(error: unknown): { errorName?: string; errorCode?: string } {
  if (!(error instanceof Error)) return {};
  const shape: { errorName?: string; errorCode?: string } = {};
  if (/^[A-Za-z_$][\w$]{0,63}$/.test(error.name)) shape.errorName = error.name;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) shape.errorCode = code;
  return shape;
}
