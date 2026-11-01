/**
 * The Done move's background deleter (`removed-worktrees.ts`): the edges a
 * review pass found no test standing on.
 *
 * The drain: a stop while it is parked on a running init script, a schedule
 * that lands while a stop is ending, a quit mid-tree, one copy that cannot be
 * deleted, and a rerun that must not walk that copy again. The walker: a failed
 * batch settles its siblings first, the Windows-only branches (faked here on
 * any OS by stubbing `process.platform`), a read-only parent on macOS and
 * Linux, and the name check for a child whose name starts with two dots.
 *
 * Three modules are replaced, each a pass-through unless a test says
 * otherwise:
 * - `original-fs` records every call the walker makes and lets a test answer
 *   one for a path (fail it, hold it, count it). `readdir` is sorted so the
 *   order copies are visited in does not depend on the filesystem.
 * - `shutdown-state` reads a flag the test flips.
 * - `spawn-with-abort` returns a promise the test holds, so an init script is
 *   "running" for exactly as long as the test wants, with no child process to
 *   clean up. `runInitScript` itself, and so `isAnyInitScriptRunning`, is real.
 *
 * Nothing waits on a timer: every wait polls a condition with a bound, or
 * rides a deferred the test controls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type nodeFs from 'node:fs';

type FsOperation = 'lstat' | 'readdir' | 'readlink' | 'unlink' | 'rmdir' | 'chmod';

/** Returns a promise to answer the call, or undefined to let the real one run. */
type FsInterceptor = (targetPath: string, extraArguments: unknown[]) => Promise<unknown> | undefined;

interface RecordedFsCall {
  operation: FsOperation;
  target: string;
  extraArguments: unknown[];
}

const { fsControl, shutdownControl, initScriptControl } = vi.hoisted(() => ({
  fsControl: {
    actual: null as typeof nodeFs | null,
    calls: [] as RecordedFsCall[],
    interceptors: {} as Partial<Record<FsOperation, FsInterceptor>>,
  },
  shutdownControl: { shuttingDown: false },
  initScriptControl: { releases: [] as Array<() => void> },
}));

vi.mock('../../src/main/git/original-fs', async () => {
  const actual = await vi.importActual<typeof nodeFs>('node:fs');
  fsControl.actual = actual;
  const actualPromises = actual.promises as unknown as Record<FsOperation, (...args: unknown[]) => Promise<unknown>>;
  const wrap = (operation: FsOperation) => async (targetPath: string, ...extraArguments: unknown[]): Promise<unknown> => {
    fsControl.calls.push({ operation, target: path.resolve(targetPath), extraArguments });
    const intercepted = fsControl.interceptors[operation]?.(targetPath, extraArguments);
    if (intercepted !== undefined) return intercepted;
    const result = await actualPromises[operation](targetPath, ...extraArguments);
    return operation === 'readdir' && Array.isArray(result) ? [...result].sort() : result;
  };
  const promises = {
    ...actual.promises,
    lstat: wrap('lstat'),
    readdir: wrap('readdir'),
    readlink: wrap('readlink'),
    unlink: wrap('unlink'),
    rmdir: wrap('rmdir'),
    chmod: wrap('chmod'),
  };
  return { default: { ...actual, promises } };
});

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => shutdownControl.shuttingDown,
  setShuttingDown: () => { shutdownControl.shuttingDown = true; },
}));

vi.mock('../../src/main/git/spawn-with-abort', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/git/spawn-with-abort')>();
  return {
    ...original,
    spawnWithAbort: () => new Promise<{ stdout: string; stderr: string }>((resolve) => {
      initScriptControl.releases.push(() => resolve({ stdout: '', stderr: '' }));
    }),
  };
});

import { isAnyInitScriptRunning, runInitScript } from '../../src/main/git/run-init-script';
import {
  assertRemovedWorktreeEntry,
  deleteTreeWithoutFollowingLinks,
  removedWorktreesRootFor,
  scheduleRemovedWorktreeDeletion,
  stopRemovedWorktreeDeletion,
  _removedWorktreeDeletionStateForTests,
  _resetRemovedWorktreeDeletionForTests,
  _setRemovedWorktreeBatchHookForTests,
  _whenRemovedWorktreeDeletionIdleForTests,
} from '../../src/main/git/removed-worktrees';

// Real files, and a few polls: give the file room under a loaded run.
vi.setConfig({ testTimeout: 30_000 });

const realPlatform = process.platform;
const realPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

let scratch = '';
let currentProject = '';
const pendingReleases: Array<() => void> = [];
const startedInitScripts: Array<Promise<unknown>> = [];
const readOnlyDirectories: string[] = [];

const noStop = { beforeBatch: async () => true, onRemoved: () => undefined };

beforeEach(() => {
  // The deleter logs each copy it finishes or fails; keep the run's output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  // Order matters: every one of these is process-wide state that would hang or
  // skew the next test if a failed assertion left it set.
  for (const release of pendingReleases.splice(0)) release();
  shutdownControl.shuttingDown = false;
  for (const release of initScriptControl.releases.splice(0)) release();
  await Promise.allSettled(startedInitScripts.splice(0));
  fsControl.interceptors = {};
  fsControl.calls.length = 0;
  _setRemovedWorktreeBatchHookForTests(null);
  if (currentProject) await _whenRemovedWorktreeDeletionIdleForTests(currentProject);
  _resetRemovedWorktreeDeletionForTests();
  Object.defineProperty(process, 'platform', realPlatformDescriptor);
  for (const directory of readOnlyDirectories.splice(0)) {
    try { fs.chmodSync(directory, 0o700); } catch { /* already gone */ }
  }
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  scratch = '';
  currentProject = '';
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScratch(): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-removed-drain-'));
  return scratch;
}

/** A project folder with an empty removed-worktrees folder, under a fresh scratch. */
function makeProject(): string {
  currentProject = path.join(makeScratch(), 'project');
  fs.mkdirSync(removedWorktreesRootFor(currentProject), { recursive: true });
  return currentProject;
}

/** A copy of `fileCount` files in the project's removed-worktrees folder. */
function makeCopy(projectPath: string, name: string, fileCount: number): string {
  const copy = path.join(removedWorktreesRootFor(projectPath), name);
  fs.mkdirSync(copy);
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    fs.writeFileSync(path.join(copy, `file-${String(fileIndex).padStart(2, '0')}.txt`), '\n');
  }
  return copy;
}

function deleterState(projectPath: string): ReturnType<typeof _removedWorktreeDeletionStateForTests> {
  return _removedWorktreeDeletionStateForTests(projectPath);
}

/** Poll a condition with a bound. For waits only, never as the assertion. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A few turns of the event loop, for anything that could still run to run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Track a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let isSettled = false;
  const tracked = promise.finally(() => { isSettled = true; });
  tracked.catch(() => undefined);
  return { promise: tracked, settled: () => isSettled };
}

/** A deferred the test releases; also released in afterEach so a failed test cannot leave it held. */
function createHold(): { released: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  pendingReleases.push(release);
  return { released, release };
}

/** Hold the deleter just before its `batchNumber`th batch (counted across the whole drain). */
function holdDeleterAtBatch(batchNumber: number): { reached: Promise<void>; release: () => void } {
  let batchesSeen = 0;
  let markReached: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const hold = createHold();
  _setRemovedWorktreeBatchHookForTests(async () => {
    batchesSeen += 1;
    if (batchesSeen === batchNumber) {
      markReached();
      await hold.released;
    }
  });
  return { reached, release: hold.release };
}

function simulatedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function actualFs(): typeof nodeFs {
  if (!fsControl.actual) throw new Error('the original-fs mock has not loaded');
  return fsControl.actual;
}

/** The recorded calls of `operation` on `target` itself, or anything below it. */
function callsWithin(operation: FsOperation, target: string): RecordedFsCall[] {
  const resolved = path.resolve(target);
  return fsControl.calls.filter((call) => call.operation === operation
    && (call.target === resolved || call.target.startsWith(resolved + path.sep)));
}

/** The recorded calls of `operation` on exactly `target`. */
function callsOn(operation: FsOperation, target: string): RecordedFsCall[] {
  const resolved = path.resolve(target);
  return fsControl.calls.filter((call) => call.operation === operation && call.target === resolved);
}

function isWithin(directory: string, target: string): boolean {
  return path.resolve(target).startsWith(path.resolve(directory) + path.sep);
}

function pretendPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

/** Start an init script that runs until the test releases it. */
function startBlockingInitScript(workingDirectory: string): Promise<unknown> {
  const running = runInitScript('install dependencies', workingDirectory, { timeoutMs: 60_000 }).catch(() => undefined);
  startedInitScripts.push(running);
  return running;
}

// ---------------------------------------------------------------------------
// The per-project drain
// ---------------------------------------------------------------------------

describe('the removed-worktrees drain', () => {
  it('a stop resolves while the deleter is parked on a running init script, and leaves the copy on disk', async () => {
    const projectPath = makeProject();
    const copy = makeCopy(projectPath, 'parked-copy', 3);
    const script = startBlockingInitScript(scratch);
    expect(isAnyInitScriptRunning()).toBe(true);

    scheduleRemovedWorktreeDeletion(projectPath);
    // A deleter that ignored the script would finish instead, and fail the next line at once.
    await until(
      () => deleterState(projectPath).phase === 'waiting-for-init-script' || deleterState(projectPath).phase === 'idle',
      'the deleter to wait for the script or finish',
    );
    expect(deleterState(projectPath).phase).toBe('waiting-for-init-script');

    const stopping = track(stopRemovedWorktreeDeletion(projectPath));
    // The script is still running: the stop must not depend on it ending.
    await until(() => stopping.settled(), 'the stop to resolve while the script still runs');
    expect(isAnyInitScriptRunning()).toBe(true);
    expect(deleterState(projectPath).phase).toBe('idle');
    expect(fs.readdirSync(copy)).toHaveLength(3);

    for (const release of initScriptControl.releases.splice(0)) release();
    await script;
    expect(isAnyInitScriptRunning()).toBe(false);
  });

  it('a schedule that lands while a stop is ending starts no drain, and one after the stop has finished is honored', async () => {
    const projectPath = makeProject();
    const copy = makeCopy(projectPath, 'stop-then-schedule', 20);
    const hold = holdDeleterAtBatch(1);
    scheduleRemovedWorktreeDeletion(projectPath);
    await hold.reached;

    const stopping = track(stopRemovedWorktreeDeletion(projectPath));
    // The drain is still inside its held batch, so it is ending, not ended.
    scheduleRemovedWorktreeDeletion(projectPath);
    hold.release();
    await stopping.promise;

    // A drain started by that schedule would own the map entry by now.
    expect(deleterState(projectPath).phase).toBe('idle');
    const idle = track(_whenRemovedWorktreeDeletionIdleForTests(projectPath));
    await settle();
    expect(idle.settled()).toBe(true);
    expect(fs.readdirSync(copy)).toHaveLength(20);

    // The next schedule, after the stop finished, is an ordinary one.
    _setRemovedWorktreeBatchHookForTests(null);
    scheduleRemovedWorktreeDeletion(projectPath);
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('ends when the app is quitting, between batches and without a stop, and leaves the rest of the copy', async () => {
    const projectPath = makeProject();
    const copy = makeCopy(projectPath, 'quit-mid-tree', 20);
    let batchesSeen = 0;
    _setRemovedWorktreeBatchHookForTests(async () => {
      batchesSeen += 1;
      // The quit lands as the second batch is about to run: the first one's 8 files are gone.
      if (batchesSeen === 2) shutdownControl.shuttingDown = true;
    });

    scheduleRemovedWorktreeDeletion(projectPath);
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);

    expect(deleterState(projectPath).phase).toBe('idle');
    expect(batchesSeen).toBe(2);
    expect(fs.readdirSync(copy)).toHaveLength(12);
  });

  it('a copy that cannot be deleted does not stop the others, and a rerun in the same drain does not walk it again', async () => {
    const projectPath = makeProject();
    // Sorted listing, so the failing copy is visited first: a failure that
    // escaped its entry would leave the good copy unvisited.
    const badCopy = makeCopy(projectPath, 'a-undeletable', 1);
    const goodCopy = makeCopy(projectPath, 'b-deletable', 3);
    fsControl.interceptors.unlink = (targetPath) =>
      (isWithin(badCopy, targetPath) ? Promise.reject(simulatedError('EIO')) : undefined);
    const hold = holdDeleterAtBatch(1);

    scheduleRemovedWorktreeDeletion(projectPath);
    await hold.reached;
    // A second Done move lands while the drain runs: it lists the folder once more.
    scheduleRemovedWorktreeDeletion(projectPath);
    hold.release();
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);

    expect(deleterState(projectPath).phase).toBe('idle');
    expect(fs.existsSync(goodCopy)).toBe(false);
    expect(fs.existsSync(path.join(badCopy, 'file-00.txt'))).toBe(true);
    // The rerun did happen, so the skip below is a real one.
    expect(callsOn('readdir', removedWorktreesRootFor(projectPath))).toHaveLength(2);
    // The failed copy was tried once, in the first listing, and not in the second.
    expect(callsWithin('unlink', badCopy)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The tree walker
// ---------------------------------------------------------------------------

describe('the link-safe tree walker', () => {
  it('a failed batch ends the delete only after its siblings have settled', async () => {
    const tree = path.join(makeScratch(), 'tree');
    fs.mkdirSync(tree);
    const fileNames = ['file-0.txt', 'file-1.txt', 'file-2.txt', 'file-3.txt'];
    for (const fileName of fileNames) fs.writeFileSync(path.join(tree, fileName), '\n');
    const events: string[] = [];
    const siblingsMayFinish = createHold();
    fsControl.interceptors.unlink = (targetPath) => {
      const fileName = path.basename(targetPath);
      if (fileName === 'file-0.txt') return Promise.reject(simulatedError('EIO'));
      return (async () => {
        await siblingsMayFinish.released;
        await actualFs().promises.unlink(targetPath);
        events.push(`unlinked ${fileName}`);
      })();
    };

    const deletion = deleteTreeWithoutFollowingLinks(tree, noStop).then(
      () => 'resolved',
      (error: NodeJS.ErrnoException) => {
        events.push('delete rejected');
        return error.code;
      },
    );
    const tracked = track(deletion);
    // The failing unlink has rejected and the other three are pending.
    await until(() => callsWithin('unlink', tree).length === fileNames.length, 'all four unlinks to start');
    await settle();
    expect(tracked.settled()).toBe(false);
    expect(events).toEqual([]);

    siblingsMayFinish.release();
    expect(await deletion).toBe('EIO');
    expect(events.slice(0, 3).sort()).toEqual(['unlinked file-1.txt', 'unlinked file-2.txt', 'unlinked file-3.txt']);
    expect(events[3]).toBe('delete rejected');
    expect(fs.readdirSync(tree)).toEqual(['file-0.txt']);
  });

  describe('on Windows (the platform is stubbed, so it runs on any OS)', () => {
    // Each test builds its tree first and only then stubs the platform, so
    // nothing but the walker sees it.
    it('a read-only file whose unlink says EPERM gets chmod 0o666 and is unlinked again', async () => {
      const tree = path.join(makeScratch(), 'tree');
      fs.mkdirSync(tree);
      const lockedFile = path.join(tree, 'locked.txt');
      fs.writeFileSync(lockedFile, '\n');
      let attempts = 0;
      fsControl.interceptors.unlink = (targetPath) => {
        if (path.resolve(targetPath) !== path.resolve(lockedFile)) return undefined;
        attempts += 1;
        return attempts === 1 ? Promise.reject(simulatedError('EPERM')) : undefined;
      };
      pretendPlatform('win32');

      await expect(deleteTreeWithoutFollowingLinks(tree, noStop)).resolves.toBe('deleted');

      expect(fs.existsSync(tree)).toBe(false);
      const chmods = callsOn('chmod', lockedFile);
      expect(chmods).toHaveLength(1);
      expect(chmods[0].extraArguments).toEqual([0o666]);
      // The attribute is cleared before the second unlink, not after it.
      const unlinkIndexes = fsControl.calls
        .map((call, index) => (call.operation === 'unlink' && call.target === path.resolve(lockedFile) ? index : -1))
        .filter((index) => index >= 0);
      expect(unlinkIndexes).toHaveLength(2);
      expect(fsControl.calls.indexOf(chmods[0])).toBeGreaterThan(unlinkIndexes[0]);
      expect(fsControl.calls.indexOf(chmods[0])).toBeLessThan(unlinkIndexes[1]);
    });

    it('a directory link whose unlink says EPERM is removed with rmdir, and what it points at survives', async () => {
      const base = makeScratch();
      const target = path.join(base, 'outside');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
      const tree = path.join(base, 'tree');
      fs.mkdirSync(tree);
      const link = path.join(tree, 'linked');
      fs.symlinkSync(target, link, realPlatform === 'win32' ? 'junction' : 'dir');
      // Every time, as on a Node that refuses to unlink a directory link.
      fsControl.interceptors.unlink = (targetPath) =>
        (path.resolve(targetPath) === path.resolve(link) ? Promise.reject(simulatedError('EPERM')) : undefined);
      // A real rmdir on a POSIX symlink says ENOTDIR, so there the link goes by unlink.
      fsControl.interceptors.rmdir = (targetPath) =>
        (realPlatform !== 'win32' && path.resolve(targetPath) === path.resolve(link)
          ? actualFs().promises.unlink(targetPath)
          : undefined);
      pretendPlatform('win32');

      await expect(deleteTreeWithoutFollowingLinks(tree, noStop)).resolves.toBe('deleted');

      expect(callsOn('rmdir', link)).toHaveLength(1);
      expect(fs.existsSync(tree)).toBe(false);
      expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep\n');
      expect(callsWithin('readdir', link)).toEqual([]);
    });

    it('an entry lstat calls a directory is not entered when readlink cannot say whether it is a link', async () => {
      const tree = path.join(makeScratch(), 'tree');
      const ambiguous = path.join(tree, 'ambiguous');
      fs.mkdirSync(ambiguous, { recursive: true });
      fs.writeFileSync(path.join(ambiguous, 'inner.txt'), '\n');
      // Only the probed entry: every other directory answers EINVAL natively.
      fsControl.interceptors.readlink = (targetPath) =>
        (path.resolve(targetPath) === path.resolve(ambiguous) ? Promise.reject(simulatedError('EACCES')) : undefined);
      pretendPlatform('win32');

      await expect(deleteTreeWithoutFollowingLinks(tree, noStop)).rejects.toMatchObject({ code: 'EACCES' });

      expect(callsWithin('readdir', ambiguous)).toEqual([]);
      expect(callsWithin('unlink', ambiguous)).toEqual([]);
      expect(fs.existsSync(path.join(ambiguous, 'inner.txt'))).toBe(true);
    });

    it('an entry lstat calls a directory is entered as a real directory when readlink says EINVAL', async () => {
      const tree = path.join(makeScratch(), 'tree');
      const ordinary = path.join(tree, 'ordinary');
      fs.mkdirSync(ordinary, { recursive: true });
      fs.writeFileSync(path.join(ordinary, 'inner.txt'), '\n');
      fsControl.interceptors.readlink = (targetPath) =>
        (path.resolve(targetPath) === path.resolve(ordinary) ? Promise.reject(simulatedError('EINVAL')) : undefined);
      pretendPlatform('win32');

      await expect(deleteTreeWithoutFollowingLinks(tree, noStop)).resolves.toBe('deleted');

      expect(callsWithin('readdir', ordinary).length).toBeGreaterThan(0);
      expect(fs.existsSync(tree)).toBe(false);
    });
  });

  describe('on macOS and Linux', () => {
    const cannotShowReadOnlyParent = process.platform === 'win32' || process.getuid?.() === 0;

    // Windows has no read-only bit on a directory, and root ignores it: both
    // would pass without the walker doing anything.
    it.skipIf(cannotShowReadOnlyParent)('a read-only directory inside a copy is made writable once, and the whole copy goes', async () => {
      const projectPath = makeProject();
      const copy = path.join(removedWorktreesRootFor(projectPath), 'read-only-parent-copy');
      // Go's module cache is the real case: a 0o555 directory holding files and folders.
      const readOnlyDirectory = path.join(copy, 'module-cache');
      fs.mkdirSync(path.join(readOnlyDirectory, 'empty-subdirectory'), { recursive: true });
      fs.writeFileSync(path.join(readOnlyDirectory, 'file.txt'), '\n');
      fs.chmodSync(readOnlyDirectory, 0o555);
      readOnlyDirectories.push(readOnlyDirectory);

      await expect(deleteTreeWithoutFollowingLinks(copy, noStop)).resolves.toBe('deleted');

      expect(fs.existsSync(copy)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// The name check
// ---------------------------------------------------------------------------

describe('assertRemovedWorktreeEntry', () => {
  it('accepts a direct child whose name starts with two dots, and still refuses .., the root and a nested path', () => {
    // Path arithmetic only: nothing here touches the disk.
    const projectPath = path.join(os.tmpdir(), 'kangentic-removed-entry-check', 'project');
    const root = removedWorktreesRootFor(projectPath);

    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '..foo'))).not.toThrow();
    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '...hidden'))).not.toThrow();

    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '..'))).toThrow(/not a direct child/);
    expect(() => assertRemovedWorktreeEntry(projectPath, root)).toThrow(/not a direct child/);
    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '..foo', 'inner'))).toThrow(/not a direct child/);
    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '..', 'sibling'))).toThrow(/not a direct child/);
  });
});
