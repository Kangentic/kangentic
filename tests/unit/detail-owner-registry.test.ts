import { describe, it, expect, beforeEach } from 'vitest';
import { DetailOwnerRegistry, detailKey } from '../../src/main/task-detail/detail-owner-registry';

// One rule, in one place: THE REQUESTER WINS. Whoever asks is where the detail
// goes, and any other surface holding it gives it up. So a monitor click opens in
// the monitor, and opening the same task on the board takes it back and closes
// the monitor's copy - no placement heuristic for the user to predict.
//
// The `host` half of an owner is load-bearing: the board's window layer and the
// monitor's BOTH live in the main window, so a webContents id alone cannot tell
// them apart and both would answer the same mount push. It is equally load-bearing
// in the other direction: the in-app monitor and the detached monitor pop-out are
// two RENDERERS both reporting host 'monitor', so the host alone cannot either.
//
// Ownership is DERIVED. A surface reports the complete set of details it has
// mounted (`syncOwned`) and main reconciles to match; there is deliberately no
// claim/release pair. Incremental bookkeeping could lose a release and strand a
// claim, which presented as a task answering `focused-existing` for a window that
// no longer existed - permanently unopenable, with nothing on screen to explain it.

const MAIN = 1;
const POP_OUT = 2;

const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';
const TASK = 'task-1';

describe('DetailOwnerRegistry', () => {
  let registry: DetailOwnerRegistry;

  beforeEach(() => {
    registry = new DetailOwnerRegistry();
  });

  const resolve = (requesterWebContentsId: number, requesterHost: 'board' | 'monitor') =>
    registry.resolveOpen({
      projectId: PROJECT_A,
      taskId: TASK,
      requesterWebContentsId,
      requesterHost,
    });

  /** The common case: one surface reports it hosts exactly this one detail. */
  const hosts = (
    webContentsId: number,
    host: 'board' | 'monitor',
    ...details: Array<{ projectId: string; taskId: string }>
  ) => registry.syncOwned(webContentsId, host, details);

  const detailA = { projectId: PROJECT_A, taskId: TASK };

  describe('the requester wins', () => {
    it('opens in the monitor when the monitor asks', () => {
      expect(resolve(MAIN, 'monitor')).toEqual({
        kind: 'open-here',
        owner: { webContentsId: MAIN, host: 'monitor' },
        closedElsewhere: null,
      });
    });

    it('takes it back to the board, closing the monitor copy', () => {
      // The user's one exception: opening the task on the project board wins.
      hosts(MAIN, 'monitor', detailA);

      const result = resolve(MAIN, 'board');

      expect(result.kind).toBe('open-here');
      expect(result).toMatchObject({
        owner: { webContentsId: MAIN, host: 'board' },
        closedElsewhere: { webContentsId: MAIN, host: 'monitor' },
      });
    });

    it('moves it between renderers, closing the previous window', () => {
      hosts(MAIN, 'board', detailA);

      expect(resolve(POP_OUT, 'monitor')).toMatchObject({
        owner: { webContentsId: POP_OUT, host: 'monitor' },
        closedElsewhere: { webContentsId: MAIN, host: 'board' },
      });
    });

    it('distinguishes the two surfaces inside ONE renderer', () => {
      // Both layers live in the main window and listen to the same channel. If
      // ownership were keyed on webContents alone, this would read as "already
      // mine" and the board would never take the task from the monitor.
      hosts(MAIN, 'monitor', detailA);
      expect(resolve(MAIN, 'board').kind).toBe('open-here');
    });
  });

  describe('never mounted twice', () => {
    it('focuses instead of remounting when the SAME surface re-asks', () => {
      // A remount would tear down and re-attach a live agent's terminal.
      hosts(POP_OUT, 'monitor', detailA);
      expect(resolve(POP_OUT, 'monitor')).toEqual({
        kind: 'focused-existing',
        owner: { webContentsId: POP_OUT, host: 'monitor' },
      });
    });

    it('scopes ownership by project as well as task', () => {
      hosts(MAIN, 'board', detailA);
      expect(registry.ownerOf(PROJECT_B, TASK)).toBeNull();
      expect(detailKey(PROJECT_A, TASK)).not.toBe(detailKey(PROJECT_B, TASK));
    });
  });

  describe('syncOwned derives ownership from what a surface reports', () => {
    it('adds details the reporter did not own', () => {
      const result = hosts(MAIN, 'board', detailA);
      expect(registry.ownerOf(PROJECT_A, TASK)).toEqual({ webContentsId: MAIN, host: 'board' });
      expect(result.added).toEqual([detailKey(PROJECT_A, TASK)]);
      expect(result.removed).toEqual([]);
      expect(result.displaced).toEqual([]);
    });

    it('drops what the reporter no longer hosts, which is how a close frees a task', () => {
      hosts(MAIN, 'board', detailA);
      const result = hosts(MAIN, 'board');
      expect(registry.ownerOf(PROJECT_A, TASK)).toBeNull();
      expect(result.removed).toEqual([detailKey(PROJECT_A, TASK)]);
    });

    it('never removes a detail owned by a DIFFERENT surface', () => {
      // The old release guard, now structural. A surface that has since lost the
      // detail reports without it; that report must not erase the new owner, or the
      // detail would be open with nobody recorded as holding it.
      hosts(MAIN, 'monitor', detailA);
      hosts(MAIN, 'board', detailA);

      const result = hosts(MAIN, 'monitor');

      expect(registry.ownerOf(PROJECT_A, TASK)).toEqual({ webContentsId: MAIN, host: 'board' });
      expect(result.removed).toEqual([]);
    });

    it('scopes two renderers that both report host monitor independently', () => {
      // The in-app monitor and the detached pop-out are both 'monitor'. An empty
      // report from one must not free the other's windows.
      hosts(MAIN, 'monitor', detailA);
      hosts(POP_OUT, 'monitor', { projectId: PROJECT_B, taskId: 'task-2' });

      hosts(MAIN, 'monitor');

      expect(registry.ownerOf(PROJECT_A, TASK)).toBeNull();
      expect(registry.ownerOf(PROJECT_B, 'task-2')).toEqual({ webContentsId: POP_OUT, host: 'monitor' });
    });

    it('reports a displaced previous owner so the caller can close its window', () => {
      // Taking ownership is fine; leaving the loser's window mounted is not - that
      // would be the same task open twice, so two xterms on one PTY.
      hosts(MAIN, 'monitor', detailA);

      const result = hosts(MAIN, 'board', detailA);

      expect(result.displaced).toEqual([
        { projectId: PROJECT_A, taskId: TASK, previous: { webContentsId: MAIN, host: 'monitor' } },
      ]);
      expect(registry.ownerOf(PROJECT_A, TASK)).toEqual({ webContentsId: MAIN, host: 'board' });
    });

    it('is idempotent, so an unchanged report is a no-op the caller can skip', () => {
      hosts(MAIN, 'board', detailA);
      const result = hosts(MAIN, 'board', detailA);
      expect(result).toEqual({ added: [], removed: [], displaced: [] });
    });

    it('keeps an unchanged detail in place when another is added', () => {
      // `ownedElsewhere` iterates in insertion order and the renderer compares the
      // result, so re-inserting an unchanged entry would look like a change and
      // needlessly re-publish the focused-session set.
      hosts(MAIN, 'board', detailA);
      hosts(MAIN, 'board', detailA, { projectId: PROJECT_A, taskId: 'task-2' });
      expect(registry.ownedElsewhere(POP_OUT).map((entry) => entry.taskId)).toEqual([TASK, 'task-2']);
    });
  });

  describe('handover converges whichever report lands first', () => {
    // Main tells the old holder to close and the new one to open. Both then report,
    // in an order nobody controls, and the requester must win either way.
    it('old holder reports first', () => {
      hosts(MAIN, 'monitor', detailA);
      hosts(MAIN, 'monitor');
      hosts(MAIN, 'board', detailA);
      expect(registry.ownerOf(PROJECT_A, TASK)).toEqual({ webContentsId: MAIN, host: 'board' });
    });

    it('new holder reports first', () => {
      hosts(MAIN, 'monitor', detailA);
      hosts(MAIN, 'board', detailA);
      hosts(MAIN, 'monitor');
      expect(registry.ownerOf(PROJECT_A, TASK)).toEqual({ webContentsId: MAIN, host: 'board' });
    });
  });

  describe('renderer teardown', () => {
    it('drops every claim of a renderer that went away', () => {
      // A closed pop-out would otherwise pin its tasks forever, making them
      // permanently unopenable.
      hosts(POP_OUT, 'monitor', detailA, { projectId: PROJECT_B, taskId: 'task-2' });
      hosts(MAIN, 'board', { projectId: PROJECT_A, taskId: 'task-3' });

      registry.releaseAllFor(POP_OUT);

      expect(registry.size).toBe(1);
      expect(registry.ownerOf(PROJECT_A, 'task-3')).toEqual({ webContentsId: MAIN, host: 'board' });
    });

    it('lets a reloaded renderer re-establish exactly what it reports', () => {
      // The reload path: main drops everything for that webContents, and the fresh
      // page's first report is the new truth. Nothing has to be remembered across it.
      hosts(MAIN, 'board', detailA, { projectId: PROJECT_A, taskId: 'task-2' });
      registry.releaseAllFor(MAIN);
      hosts(MAIN, 'board', detailA);

      expect(registry.size).toBe(1);
      expect(registry.ownerOf(PROJECT_A, TASK)).toEqual({ webContentsId: MAIN, host: 'board' });
    });
  });

  it('resolveOpen does not mutate the registry', () => {
    // Ownership follows the reports, so a resolve that never results in a window
    // cannot leave a phantom owner behind.
    resolve(POP_OUT, 'monitor');
    expect(registry.size).toBe(0);
  });

  it('snapshot reports current owners without side effects', () => {
    // The devtools ownership view (`store_state?store=detailOwners`) is the only
    // read-only window into this; `resolveOpen` focuses and can mount, so probing
    // with it changed what was being measured.
    hosts(MAIN, 'board', detailA);
    const before = registry.snapshot();
    expect(before.owners).toEqual([
      { projectId: PROJECT_A, taskId: TASK, webContentsId: MAIN, host: 'board' },
    ]);
    expect(registry.snapshot().owners).toEqual(before.owners);
    expect(registry.size).toBe(1);
  });
});
