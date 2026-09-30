/**
 * A stand-in for `src/main/retrieval/retrieval-client` whose `call` runs the
 * worker's own handler in this process, so a test of main's side (the
 * retrieval service, an IPC handler) drives the same code the worker runs,
 * with whatever that code imports mocked as usual. Use it from a mock factory:
 *
 *   vi.mock('../../src/main/retrieval/retrieval-client', async () => (
 *     (await import('./helpers/in-process-retrieval-client')).inProcessRetrievalClientModule()
 *   ));
 *
 * The worker context reaches databases through `getProjectDb`, so a test that
 * mocks `db/database` controls what every handler reads.
 */
import { vi } from 'vitest';

export async function inProcessRetrievalClientModule() {
  const { retrievalHandlers } = await import('../../../src/main/retrieval/worker/methods');
  const { getProjectDb } = await import('../../../src/main/db/database');
  const context = { getDb: getProjectDb, closeDb: () => undefined, emit: () => undefined, vecLoadError: () => null };
  class RetrievalUnavailableError extends Error {}
  const call = async (method: keyof typeof retrievalHandlers, params: unknown) => (
    (retrievalHandlers[method] as (params: unknown, handlerContext: unknown) => unknown)(params, context)
  );
  const retrievalClient = {
    on: vi.fn(),
    call: vi.fn(call),
    notifyRunning: vi.fn((method: keyof typeof retrievalHandlers, params: unknown) => {
      void call(method, params);
    }),
    closeProject: vi.fn(async () => undefined),
    unavailableReason: null,
  };
  return { RetrievalUnavailableError, retrievalClient };
}
