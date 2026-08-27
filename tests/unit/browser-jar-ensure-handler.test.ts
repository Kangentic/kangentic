/**
 * Unit tests for the BROWSER_JAR_ENSURE IPC handler in
 * src/main/ipc/handlers/browser.ts.
 *
 * The handler seeds a task's cookie jar from the project identity jar before
 * the pane's guest attaches. Two properties are the load-bearing behavior and
 * are easy to silently regress:
 *   - it has NO ambient-project fallback: a null/undefined explicit
 *     projectId must never fall back to context.currentProjectId, because
 *     the pane computes its own partition from its OWN projectId prop, not
 *     the ambient one;
 *   - a rejecting syncJarFromIdentity must never reject the invoke (this is
 *     a best-effort load-boundary hook, wrapped in try/catch that only
 *     warns).
 *
 * Strategy mirrors browser-clear-storage-handler.test.ts: capture
 * ipcMain.handle registrations via a mocked electron module, then invoke the
 * captured handler directly without a running Electron process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { capturedHandlers, fakeSyncJarFromIdentity } = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const fakeSyncJarFromIdentity = vi.fn();
  return { capturedHandlers, fakeSyncJarFromIdentity };
});

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/mock/userData'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  session: {
    fromPartition: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: {
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    register: vi.fn(),
    unregister: vi.fn(),
    // registerBrowserHandlers installs the lane hand-off, which subscribes to
    // both registry callbacks. Omitting them makes every test in this file
    // throw at registration time, before it reaches its own subject.
    setPaneClosedHandler: vi.fn(),
    setPaneRegisteredHandler: vi.fn(),
  },
}));

vi.mock('../../src/main/browser/jar-seeder', () => ({
  syncJarFromIdentity: fakeSyncJarFromIdentity,
}));

// ---------------------------------------------------------------------------
// Import under test (must come after all vi.mock() calls)
// ---------------------------------------------------------------------------

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { browserPartitionForTask } from '../../src/shared/browser-partition';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const EXPLICIT_PROJECT_ID = '11111111-1111-1111-1111-111111111111';
// Deliberately DIFFERENT from EXPLICIT_PROJECT_ID, and set as the context's
// ambient "current project" in every test below. If the handler ever regains
// the `projectId ?? context.currentProjectId` fallback it used to have, a
// call made with a null/undefined explicit projectId would resolve to THIS
// value and fire, instead of returning without calling anything.
const AMBIENT_PROJECT_ID = '99999999-9999-9999-9999-999999999999';
const TASK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeContext() {
  return {
    currentProjectPath: '/mock/project',
    currentProjectId: AMBIENT_PROJECT_ID,
    configManager: {
      loadProjectOverrides: vi.fn(() => null),
    },
    sessionManager: {
      getSessionProjectId: vi.fn(() => undefined),
    },
  };
}

async function invokeJarEnsure(
  taskId: string | null | undefined,
  projectId?: string | null,
): Promise<unknown> {
  const handler = capturedHandlers.get('browser:jarEnsure');
  if (!handler) throw new Error('browser:jarEnsure handler not registered');
  return handler(undefined, taskId, projectId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BROWSER_JAR_ENSURE IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeSyncJarFromIdentity.mockReset();
    fakeSyncJarFromIdentity.mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerBrowserHandlers(makeContext() as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with an explicit projectId and taskId, syncs the task jar from that project identity', async () => {
    await invokeJarEnsure(TASK_ID, EXPLICIT_PROJECT_ID);

    expect(fakeSyncJarFromIdentity).toHaveBeenCalledTimes(1);
    expect(fakeSyncJarFromIdentity).toHaveBeenCalledWith(
      browserPartitionForTask(EXPLICIT_PROJECT_ID, TASK_ID),
      EXPLICIT_PROJECT_ID,
    );
  });

  it('does not sync when projectId is null, even with an ambient current project set', async () => {
    await invokeJarEnsure(TASK_ID, null);
    expect(fakeSyncJarFromIdentity).not.toHaveBeenCalled();
  });

  it('does not sync when projectId is undefined, even with an ambient current project set', async () => {
    await invokeJarEnsure(TASK_ID, undefined);
    expect(fakeSyncJarFromIdentity).not.toHaveBeenCalled();
  });

  it('does not sync when taskId is an empty string', async () => {
    await invokeJarEnsure('', EXPLICIT_PROJECT_ID);
    expect(fakeSyncJarFromIdentity).not.toHaveBeenCalled();
  });

  it('does not sync when taskId is undefined', async () => {
    await invokeJarEnsure(undefined, EXPLICIT_PROJECT_ID);
    expect(fakeSyncJarFromIdentity).not.toHaveBeenCalled();
  });

  it('resolves undefined even when syncJarFromIdentity rejects', async () => {
    fakeSyncJarFromIdentity.mockRejectedValueOnce(new Error('sync exploded'));
    await expect(invokeJarEnsure(TASK_ID, EXPLICIT_PROJECT_ID)).resolves.toBeUndefined();
  });
});
