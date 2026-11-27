/**
 * The retrieval worker: the `kangentic-retrieval` Electron utility process
 * that owns every read and write of the retrieval index, so none of that work
 * runs on the main process (see `protocol.ts`).
 *
 * This file only dispatches. The handlers are in `methods.ts`; this adds the
 * worker's database access, the message loop, the event-loop watchdog
 * (`event-loop-watchdog.ts`), and the dev-only relay of slow spans to main's
 * lag report.
 *
 * Bundled by esbuild as its own entry (`.vite/build/retrieval-worker.js`), and
 * kept free of `electron`'s main-only modules, analytics and Sentry by
 * `tests/unit/retrieval-out-of-process-boundary.test.ts`.
 */

import fs from 'node:fs';
import { format } from 'node:util';
import type Database from 'better-sqlite3';
import { closeProjectDb, configureProjectDbAccess, getProjectDb, projectDbPath, setProjectDbInitializer, setWalAutoCheckpoint } from '../../db/database';
import { setAfterCommitHook } from '../../db/transaction';
import { relaySlowSyncSpans, timeSyncWork } from '../../diagnostics/event-loop-lag';
import { loadVecExtensionFrom } from '../vec-support';
import { vecLoadCause } from '../vec-load-cause';
import { createCheckpointPacer } from './checkpoint-pacing';
import { checkpointRunner } from './checkpoint-runner';
import { startEventLoopWatchdog } from '../../utility-process/event-loop-watchdog';
import { installWriteBudget } from '../write-budget';
import { retrievalHandlers, type WorkerContext } from './methods';
import type { KnowledgeGraphBuildProgress } from '../../../shared/types';
import type {
  FromWorkerMessage,
  InitMessage,
  RequestMessage,
  RetrievalEventName,
  RetrievalMethod,
  ToWorkerMessage,
} from './protocol';
import { errorShapeOf, LONG_WRITE_HOLD_MS } from './protocol';

const parentPort = process.parentPort;

function post(message: FromWorkerMessage): void {
  parentPort.postMessage(message);
}

// The worker's stdout is not captured and its stderr is kept for crash
// reports, so what it logs goes to main's log as messages. An error still
// writes to stderr too, where a crash report reads it.
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try {
      post({ type: 'log', level, text: format(...args) });
    } catch {
      // The port is gone: the worker is exiting.
    }
    if (level === 'error') original(...args);
  };
}

/** Why sqlite-vec last failed to load, for the status line. */
let vecLoadError: string | null = null;
/** Where sqlite-vec loads from, as main resolved it. */
let vecLoadablePath: string | null = null;
/** A failed sqlite-vec load is relayed to main once per worker run. */
let vecLoadFailureSent = false;

function initialize(message: InitMessage): void {
  // First, so a startup that hangs is named too. Production as well as dev:
  // the slow-span relay below is dev-only, and this is what a packaged build
  // has when a call times out.
  startEventLoopWatchdog({ prefix: '[retrieval-worker]' });
  configureProjectDbAccess({ projectsDir: message.projectsDir, migrate: false });
  // Checkpoints are PASSIVE and come from two places only: main's 5 s request
  // (checkpoint-driver.ts), which covers what the pty host writes, and the
  // pacer below, after this worker's own commits. With SQLite's default, a
  // commit here that found the WAL over 1000 pages also checkpointed everything
  // the pty host wrote since the last one, inside that commit: 363 to 479 ms
  // for 16 rows after a terminal flood, which held up every request behind it
  // and read as a lock hold it was not.
  setWalAutoCheckpoint(0);
  // Both kinds run on the checkpoint thread, so a long one never holds this
  // loop (Sentry DESKTOP-4P); with no thread they run here, as before.
  checkpointRunner.configure(message.checkpointThreadPath ?? null);
  setAfterCommitHook(createCheckpointPacer());
  // A long hold also goes to main, which names it on a `SQLITE_BUSY` report
  // (Sentry DESKTOP-5V). Posted after the commit, so a hold under way is not.
  installWriteBudget((heldMs) => {
    if (heldMs >= LONG_WRITE_HOLD_MS) post({ type: 'write-hold', heldMs: Math.round(heldMs) });
  });
  vecLoadablePath = message.vecLoadablePath;
  if (!vecLoadablePath) vecLoadError = 'the sqlite-vec extension was not found';
  setProjectDbInitializer((db: Database.Database) => {
    if (!vecLoadablePath) return;
    try {
      loadVecExtensionFrom(db, vecLoadablePath);
      vecLoadError = null;
    } catch (error) {
      // Keywords only for this connection.
      const loadMessage = error instanceof Error ? error.message : String(error);
      vecLoadError = loadMessage;
      console.warn('[retrieval-worker] sqlite-vec unavailable, semantic search disabled:', error);
      // Semantic search is off for this install from here, so main hears of it,
      // once: the loader's reason as a fixed word and whether the file is there,
      // never the message, which holds the install path (Sentry DESKTOP-4Q).
      if (!vecLoadFailureSent) {
        vecLoadFailureSent = true;
        post({
          type: 'handledError',
          code: 'sqlite_vec_load',
          ...errorShapeOf(error),
          loadCause: vecLoadCause(loadMessage),
          fileExists: fs.existsSync(vecLoadablePath),
        });
      }
    }
  });
  if (__KANGENTIC_DEV__) {
    relaySlowSyncSpans((label, elapsedMs) => post({ type: 'slow-span', label, ms: Math.round(elapsedMs) }));
  }
  post({ type: 'ready' });
}

/**
 * Projects main closed here to delete or prune them (`project.close` has no
 * other caller). A request still queued for one, a checkpoint tick or a drain
 * step, must not reopen its database between this close and the unlink:
 * Windows then refuses the unlink and the file is left behind. Project ids
 * are never reused, and a restarted worker starts with none.
 */
const closedProjectIds = new Set<string>();

function assertNotClosed(projectId: string): void {
  if (closedProjectIds.has(projectId)) throw new Error(`Project ${projectId} was closed for deletion`);
}

const context: WorkerContext = {
  getDb: (projectId) => {
    assertNotClosed(projectId);
    return getProjectDb(projectId);
  },
  closeDb: async (projectId) => {
    closedProjectIds.add(projectId);
    closeProjectDb(projectId);
    // The thread's connection too, or Windows refuses the unlink that follows.
    if (checkpointRunner.usesThread) await checkpointRunner.close(projectDbPath(projectId));
  },
  // No await before the runner's call: with no thread, `inLoop` runs inside the
  // caller's `method:db.checkpoint` span, so a hold there is still named.
  checkpointDb: async (projectId, inLoop) => {
    assertNotClosed(projectId);
    return checkpointRunner.checkpoint(() => projectDbPath(projectId), inLoop);
  },
  vecLoadError: () => vecLoadError,
  vecLoadablePath: () => vecLoadablePath,
  emit: (event: RetrievalEventName, projectId: string, progress?: KnowledgeGraphBuildProgress) => (
    post(progress ? { type: 'event', event, projectId, progress } : { type: 'event', event, projectId })
  ),
};

async function dispatch(message: RequestMessage): Promise<void> {
  const method: RetrievalMethod = message.method;
  const handler = retrievalHandlers[method] as (params: unknown, handlerContext: WorkerContext) => unknown;
  if (typeof handler !== 'function') {
    post({ type: 'reply', id: message.id, ok: false, error: `Unknown retrieval method: ${String(method)}` });
    return;
  }
  try {
    // Labels each handler's synchronous slice, up to its first await. Work after
    // that await carries a span of its own, or it reads as outside any step.
    const result = await timeSyncWork(`method:${method}`, () => handler(message.params, context));
    post({ type: 'reply', id: message.id, ok: true, result });
  } catch (error) {
    post({ type: 'reply', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error), ...errorShapeOf(error) });
  }
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as ToWorkerMessage;
  // A malformed payload is ignored, never thrown inside the handler.
  if (typeof message !== 'object' || message === null) return;
  if (message.type === 'shutdown') {
    // Exit, never return to the event loop: an orderly teardown would close
    // database handles under work still in flight.
    process.exit(0);
    return;
  }
  if (message.type === 'init') {
    initialize(message);
    return;
  }
  if (message.type === 'request') void dispatch(message);
});
