/**
 * Unit tests for the renderer-teardown wiring inside
 * `registerTaskDetailOwnershipHandlers` (src/main/ipc/handlers/task-detail-ownership.ts,
 * lines ~150-191).
 *
 * `tests/unit/detail-owner-registry.test.ts` calls `DetailOwnerRegistry.releaseAllFor`
 * directly on the class, bypassing this handler file entirely. `tests/unit/
 * derived-detail-ownership.test.ts` is a static source scan that never executes
 * anything. Neither exercises the actual `sender.once('destroyed', ...)` /
 * `sender.once('render-process-gone', ...)` / `sender.on('did-start-navigation', ...)`
 * wiring that calls `releaseAllFor` in response to a real renderer teardown.
 *
 * That wiring is what `.claude/rules/derived-detail-ownership.md` exists to protect:
 * without it, a closed pop-out or a reloaded window strands a claim, and the task
 * becomes permanently unopenable - every later `DETAIL_REQUEST_OPEN` answers
 * `focused-existing` for a window that no longer exists, silently. Each test below
 * proves the stronger property: not just that the registry's claim is dropped, but
 * that a subsequent open request actually resolves to `open-here` afterward.
 *
 * `electron` is mocked (ipcMain / webContents / BrowserWindow); everything else
 * (`DetailOwnerRegistry`, `ipc-channels`) is the real module, since the whole point
 * is to prove the wiring drives the real registry correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { IPC } from '../../src/shared/ipc-channels';
import type {
  TaskDetailHost,
  TaskDetailOwner,
  TaskDetailDestination,
  TaskDetailRemoteOwner,
} from '../../src/shared/types';
import type { DetailOwnerRegistry } from '../../src/main/task-detail/detail-owner-registry';

// ---------------------------------------------------------------------------
// Hoisted mocks for 'electron'
// ---------------------------------------------------------------------------

const { mockHandle, mockOn, mockGetAllWindows, mockFromId, mockFromWebContents } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockOn: vi.fn(),
  mockGetAllWindows: vi.fn(),
  mockFromId: vi.fn(),
  mockFromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, on: mockOn },
  webContents: { fromId: mockFromId },
  BrowserWindow: { getAllWindows: mockGetAllWindows, fromWebContents: mockFromWebContents },
}));

// ---------------------------------------------------------------------------
// Fakes: a real EventEmitter stands in for a renderer's webContents, so
// `.once('destroyed', ...)` / `.on('did-start-navigation', ...)` behave exactly
// like the production listeners (once-semantics included).
// ---------------------------------------------------------------------------

class FakeWebContents extends EventEmitter {
  readonly id: number;
  readonly send = vi.fn();
  private destroyed = false;

  constructor(webContentsId: number) {
    super();
    this.id = webContentsId;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** A destroyed webContents never fires further `send`s in production either. */
  markDestroyed(): void {
    this.destroyed = true;
  }
}

class FakeBrowserWindow {
  constructor(private readonly hostedWebContents: FakeWebContents) {}

  get webContents(): FakeWebContents {
    return this.hostedWebContents;
  }

  isDestroyed(): boolean {
    return this.hostedWebContents.isDestroyed();
  }
}

interface FakeNavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

type SyncOwnedHandler = (
  event: { sender: FakeWebContents },
  host: TaskDetailHost,
  entries: ReadonlyArray<TaskDetailRemoteOwner>,
) => void;

type RequestOpenHandler = (
  event: { sender: FakeWebContents },
  projectId: string,
  taskId: string,
  host: TaskDetailHost,
) => TaskDetailDestination;

function getSyncOwnedHandler(): SyncOwnedHandler {
  const registeredCall = mockOn.mock.calls.find((call) => call[0] === IPC.DETAIL_SYNC_OWNED);
  if (!registeredCall) throw new Error('DETAIL_SYNC_OWNED handler was not registered');
  return registeredCall[1] as SyncOwnedHandler;
}

function getRequestOpenHandler(): RequestOpenHandler {
  const registeredCall = mockHandle.mock.calls.find((call) => call[0] === IPC.DETAIL_REQUEST_OPEN);
  if (!registeredCall) throw new Error('DETAIL_REQUEST_OPEN handler was not registered');
  return registeredCall[1] as RequestOpenHandler;
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-a';
const TASK_ID = 'task-1';

const OWNER_ID = 1;
const SURVIVOR_ID = 2;
const NEW_RENDERER_ID = 3;

interface Harness {
  /** The renderer whose claim the teardown wiring is expected to release. */
  ownerSender: FakeWebContents;
  /** A second, unrelated live renderer that should learn the detail is free. */
  survivorSender: FakeWebContents;
  syncOwnedHandler: SyncOwnedHandler;
  requestOpenHandler: RequestOpenHandler;
  detailOwnerRegistry: DetailOwnerRegistry;
}

/**
 * Registers the real handlers against a fresh `detailOwnerRegistry` (module state
 * is reset via `vi.resetModules()` in `beforeEach`, so no test can leak an owned
 * claim into the next one), then has `ownerSender` report it hosts the fixture
 * task on the board.
 */
async function buildHarness(): Promise<Harness> {
  const ownerSender = new FakeWebContents(OWNER_ID);
  const survivorSender = new FakeWebContents(SURVIVOR_ID);
  mockGetAllWindows.mockImplementation(() => [
    new FakeBrowserWindow(ownerSender),
    new FakeBrowserWindow(survivorSender),
  ]);

  const { registerTaskDetailOwnershipHandlers, detailOwnerRegistry } = await import(
    '../../src/main/ipc/handlers/task-detail-ownership'
  );
  registerTaskDetailOwnershipHandlers();

  const syncOwnedHandler = getSyncOwnedHandler();
  const requestOpenHandler = getRequestOpenHandler();

  syncOwnedHandler({ sender: ownerSender }, 'board', [{ projectId: PROJECT_ID, taskId: TASK_ID }]);
  expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toEqual<TaskDetailOwner>({
    webContentsId: OWNER_ID,
    host: 'board',
  });

  // The initial sync itself publishes (added.length > 0); clear that noise so
  // each test's assertions are about the teardown path alone.
  ownerSender.send.mockClear();
  survivorSender.send.mockClear();

  return { ownerSender, survivorSender, syncOwnedHandler, requestOpenHandler, detailOwnerRegistry };
}

beforeEach(() => {
  vi.resetModules();
  mockHandle.mockReset();
  mockOn.mockReset();
  mockGetAllWindows.mockReset();
  mockFromId.mockReset();
  mockFromWebContents.mockReset();
});

describe('registerTaskDetailOwnershipHandlers - renderer teardown wiring', () => {
  it("'destroyed' releases the sender's claim, republishes to the survivor, and skips the destroyed target", async () => {
    const { ownerSender, survivorSender, requestOpenHandler, detailOwnerRegistry } = await buildHarness();

    ownerSender.markDestroyed();
    ownerSender.emit('destroyed');

    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toBeNull();

    // The property that actually matters: a NEW renderer asking for the task
    // gets to open it, rather than 'focused-existing' for a window that is gone.
    const destination = requestOpenHandler(
      { sender: new FakeWebContents(NEW_RENDERER_ID) },
      PROJECT_ID,
      TASK_ID,
      'monitor',
    );
    expect(destination.kind).toBe('open-here');

    expect(survivorSender.send).toHaveBeenCalledWith(IPC.DETAIL_REMOTE_OWNERS, []);
    expect(ownerSender.send).not.toHaveBeenCalled();
  });

  it("'render-process-gone' releases the sender's claim, republishes to the survivor, and skips the destroyed target", async () => {
    const { ownerSender, survivorSender, requestOpenHandler, detailOwnerRegistry } = await buildHarness();

    ownerSender.markDestroyed();
    ownerSender.emit('render-process-gone');

    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toBeNull();

    const destination = requestOpenHandler(
      { sender: new FakeWebContents(NEW_RENDERER_ID) },
      PROJECT_ID,
      TASK_ID,
      'monitor',
    );
    expect(destination.kind).toBe('open-here');

    expect(survivorSender.send).toHaveBeenCalledWith(IPC.DETAIL_REMOTE_OWNERS, []);
    expect(ownerSender.send).not.toHaveBeenCalled();
  });

  it("'did-start-navigation' on the main frame, not same-document (a reload), releases the claim and republishes to BOTH the reloaded and the survivor window", async () => {
    const { ownerSender, survivorSender, requestOpenHandler, detailOwnerRegistry } = await buildHarness();

    // A reload keeps the SAME webContents id alive - unlike 'destroyed' /
    // 'render-process-gone', ownerSender is never marked destroyed here.
    ownerSender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    } satisfies FakeNavigationDetails);

    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toBeNull();

    // The exact bug this closes: the reloaded page (same sender, same host)
    // re-asks for the task it thinks it might still own. Without the release,
    // this answers 'focused-existing' and nothing ever mounts, forever.
    const destination = requestOpenHandler({ sender: ownerSender }, PROJECT_ID, TASK_ID, 'board');
    expect(destination.kind).toBe('open-here');

    // Unlike the destroyed paths, the navigating window is still alive and must
    // also learn its claims are gone.
    expect(ownerSender.send).toHaveBeenCalledWith(IPC.DETAIL_REMOTE_OWNERS, []);
    expect(survivorSender.send).toHaveBeenCalledWith(IPC.DETAIL_REMOTE_OWNERS, []);
  });

  it("'did-start-navigation' for a SAME-DOCUMENT (hash) navigation does NOT release the claim", async () => {
    const { ownerSender, survivorSender, requestOpenHandler, detailOwnerRegistry } = await buildHarness();

    ownerSender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
    } satisfies FakeNavigationDetails);

    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toEqual<TaskDetailOwner>({
      webContentsId: OWNER_ID,
      host: 'board',
    });

    // The same surface re-asking for what it already owns still just focuses.
    const destination = requestOpenHandler({ sender: ownerSender }, PROJECT_ID, TASK_ID, 'board');
    expect(destination.kind).toBe('focused-existing');

    expect(ownerSender.send).not.toHaveBeenCalled();
    expect(survivorSender.send).not.toHaveBeenCalled();
  });

  it("'did-start-navigation' for a SUBFRAME navigation does NOT release the claim", async () => {
    const { ownerSender, survivorSender, requestOpenHandler, detailOwnerRegistry } = await buildHarness();

    ownerSender.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
    } satisfies FakeNavigationDetails);

    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toEqual<TaskDetailOwner>({
      webContentsId: OWNER_ID,
      host: 'board',
    });

    const destination = requestOpenHandler({ sender: ownerSender }, PROJECT_ID, TASK_ID, 'board');
    expect(destination.kind).toBe('focused-existing');

    expect(ownerSender.send).not.toHaveBeenCalled();
    expect(survivorSender.send).not.toHaveBeenCalled();
  });

  it("'did-start-navigation' stays armed across repeated reloads (registered with `on`, not `once`)", async () => {
    // The source comment calls this out explicitly: "a renderer can reload any
    // number of times", so the listener must survive past the first reload. A
    // `sender.once(...)` regression would release on the FIRST reload and then
    // silently do nothing on the second - the exact permanently-unopenable bug,
    // just delayed by one reload. `teardownWatched` already has this sender's id
    // from the initial sync, so the reloaded page's re-report does not rewire
    // the listener; the original registration has to still be the one that fires.
    const { ownerSender, syncOwnedHandler, detailOwnerRegistry } = await buildHarness();

    ownerSender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    } satisfies FakeNavigationDetails);
    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toBeNull();

    // The reloaded page comes back up and re-reports what it hosts.
    syncOwnedHandler({ sender: ownerSender }, 'board', [{ projectId: PROJECT_ID, taskId: TASK_ID }]);
    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toEqual<TaskDetailOwner>({
      webContentsId: OWNER_ID,
      host: 'board',
    });

    // A SECOND reload must release just as the first one did.
    ownerSender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    } satisfies FakeNavigationDetails);
    expect(detailOwnerRegistry.ownerOf(PROJECT_ID, TASK_ID)).toBeNull();
  });
});
