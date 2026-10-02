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
  | { type: 'reply'; id: number; ok: false; error: string };

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

/** A line the worker logged. Its stdout goes nowhere and its stderr is kept
 *  for crash reports, so its console reaches main's log this way. */
export interface LogMessage {
  type: 'log';
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export type FromWorkerMessage = ReadyMessage | ReplyMessage | EventMessage | SlowSpanMessage | LogMessage;
