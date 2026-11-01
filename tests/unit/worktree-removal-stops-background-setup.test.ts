/**
 * A removal stops a background setup script (#955).
 *
 * In `ensureTaskWorktree`'s background mode the worktree is recorded and the
 * move returns while the post-worktree script keeps running, so no caller's
 * signal reaches it. `registerBackgroundSetup` holds the stop for that script
 * and `prepareWorktreeForRemoval` reaches it through `abortWorktreeSetup`,
 * before it waits for the creation's hold to end.
 *
 * The creation registry and `prepareWorktreeForRemoval` are real. Nothing here
 * touches git or a real directory: the worktree paths are unique names under
 * the OS temp directory that are never created, so the node_modules step of the
 * removal returns at once and the tests see only the stop and the wait.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { prepareWorktreeForRemoval } from '../../src/main/git/worktree-manager';
import {
  abortWorktreeSetup,
  registerBackgroundSetup,
  runWorktreeCreation,
} from '../../src/main/git/worktree-creation-registry';

let pathCounter = 0;

/** A worktree path nothing creates, unique per call because the registry is module-level. */
function uniqueWorktreePath(): string {
  pathCounter += 1;
  return path.join(os.tmpdir(), `kangentic-bg-setup-stop-${process.pid}-${Date.now()}-${pathCounter}`, '.kangentic', 'worktrees', '1');
}

// Registrations a test leaves behind are released here, so a failed assertion
// cannot leak a controller into the next test.
const pendingReleases: Array<() => void> = [];

function register(worktreePath: string, controller: AbortController): () => void {
  const release = registerBackgroundSetup(worktreePath, controller);
  pendingReleases.push(release);
  return release;
}

afterEach(() => {
  for (const release of pendingReleases.splice(0)) release();
  vi.restoreAllMocks();
});

describe('prepareWorktreeForRemoval stops the background setup script of the worktree it removes', () => {
  it('aborts the controller registered for the path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const worktreePath = uniqueWorktreePath();
    const controller = new AbortController();
    register(worktreePath, controller);
    expect(controller.signal.aborted).toBe(false);

    await prepareWorktreeForRemoval(worktreePath, 'moderate', Date.now() + 5_000);

    expect(controller.signal.aborted).toBe(true);
  });

  it('leaves the controller of another worktree running', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const removedPath = uniqueWorktreePath();
    const otherPath = uniqueWorktreePath();
    const removedController = new AbortController();
    const otherController = new AbortController();
    register(removedPath, removedController);
    register(otherPath, otherController);

    await prepareWorktreeForRemoval(removedPath, 'moderate', Date.now() + 5_000);

    expect(removedController.signal.aborted).toBe(true);
    expect(otherController.signal.aborted).toBe(false);
  });

  it('stops the script before it waits for the creation, so the wait ends once the script is gone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const worktreePath = uniqueWorktreePath();
    const controller = new AbortController();
    register(worktreePath, controller);

    // The creation's hold, as a running script keeps it: it ends only when the
    // script is stopped. A removal that waited before it stopped the script
    // would wait on this forever.
    const creation = runWorktreeCreation(worktreePath, undefined, () => new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    }));

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      prepareWorktreeForRemoval(worktreePath, 'moderate', Date.now() + 5_000).then(() => 'removed' as const),
      new Promise<'timed out'>((resolve) => { timeoutHandle = setTimeout(() => resolve('timed out'), 2_000); }),
    ]);
    clearTimeout(timeoutHandle);
    // Free the hold even when the removal did not, so the failure does not hang the file.
    controller.abort();
    await creation;

    expect(outcome).toBe('removed');
  });
});

describe('the release registerBackgroundSetup returns', () => {
  it('leaves nothing to stop, and a controller registered later is the one aborted', () => {
    const worktreePath = uniqueWorktreePath();
    const firstController = new AbortController();
    const releaseFirst = register(worktreePath, firstController);
    releaseFirst();

    expect(abortWorktreeSetup(worktreePath)).toBe(false);
    expect(firstController.signal.aborted).toBe(false);

    const laterController = new AbortController();
    register(worktreePath, laterController);

    expect(abortWorktreeSetup(worktreePath)).toBe(true);
    expect(laterController.signal.aborted).toBe(true);
    expect(firstController.signal.aborted).toBe(false);
  });

  it('is a no-op once a newer controller took the path, so a late release never drops the newer stop', () => {
    const worktreePath = uniqueWorktreePath();
    const olderController = new AbortController();
    const newerController = new AbortController();
    const releaseOlder = register(worktreePath, olderController);
    register(worktreePath, newerController);

    releaseOlder();

    expect(abortWorktreeSetup(worktreePath)).toBe(true);
    expect(newerController.signal.aborted).toBe(true);
    expect(olderController.signal.aborted).toBe(false);
  });

  it('reports false for a path nothing was ever registered for', () => {
    expect(abortWorktreeSetup(uniqueWorktreePath())).toBe(false);
  });
});
