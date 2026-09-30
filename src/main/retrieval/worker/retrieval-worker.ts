/**
 * The retrieval worker: the `kangentic-retrieval` Electron utility process
 * that owns every read and write of the retrieval index, so none of that work
 * runs on the main process (see `protocol.ts`).
 *
 * This file only dispatches. The handlers are in `methods.ts`; this adds the
 * worker's database access, the message loop, and the dev-only relay of slow
 * spans to main's lag report.
 *
 * Bundled by esbuild as its own entry (`.vite/build/retrieval-worker.js`), and
 * kept free of `electron`'s main-only modules, analytics and Sentry by
 * `tests/unit/retrieval-out-of-process-boundary.test.ts`.
 */

import type Database from 'better-sqlite3';
import { closeProjectDb, configureProjectDbAccess, getProjectDb, setProjectDbInitializer } from '../../db/database';
import { relaySlowSyncSpans } from '../../diagnostics/event-loop-lag';
import { loadVecExtensionFrom } from '../vec-support';
import { retrievalHandlers, type WorkerContext } from './methods';
import type {
  FromWorkerMessage,
  InitMessage,
  RequestMessage,
  RetrievalEventName,
  RetrievalMethod,
  ToWorkerMessage,
} from './protocol';

const parentPort = process.parentPort;

function post(message: FromWorkerMessage): void {
  parentPort.postMessage(message);
}

/** Why sqlite-vec last failed to load, for the status line. */
let vecLoadError: string | null = null;

function initialize(message: InitMessage): void {
  configureProjectDbAccess({ projectsDir: message.projectsDir, migrate: false });
  const vecLoadablePath = message.vecLoadablePath;
  if (!vecLoadablePath) vecLoadError = 'the sqlite-vec extension was not found';
  setProjectDbInitializer((db: Database.Database) => {
    if (!vecLoadablePath) return;
    try {
      loadVecExtensionFrom(db, vecLoadablePath);
      vecLoadError = null;
    } catch (error) {
      // Keywords only for this connection.
      vecLoadError = error instanceof Error ? error.message : String(error);
      console.warn('[retrieval-worker] sqlite-vec unavailable, semantic search disabled:', error);
    }
  });
  if (__KANGENTIC_DEV__) {
    relaySlowSyncSpans((label, elapsedMs) => post({ type: 'slow-span', label, ms: Math.round(elapsedMs) }));
  }
  post({ type: 'ready' });
}

const context: WorkerContext = {
  getDb: (projectId) => getProjectDb(projectId),
  closeDb: (projectId) => closeProjectDb(projectId),
  vecLoadError: () => vecLoadError,
  emit: (event: RetrievalEventName, projectId: string) => post({ type: 'event', event, projectId }),
};

async function dispatch(message: RequestMessage): Promise<void> {
  const method: RetrievalMethod = message.method;
  const handler = retrievalHandlers[method] as (params: unknown, handlerContext: WorkerContext) => unknown;
  if (typeof handler !== 'function') {
    post({ type: 'reply', id: message.id, ok: false, error: `Unknown retrieval method: ${String(method)}` });
    return;
  }
  try {
    const result = await handler(message.params, context);
    post({ type: 'reply', id: message.id, ok: true, result });
  } catch (error) {
    post({ type: 'reply', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
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
