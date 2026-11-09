import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * scripts/main-bundle-staleness.js decides when a running `npm start` app is on
 * an older main-process build than the source on disk, which is what raises the
 * dev-only Restart notice. What a dogfood session loses if it breaks: either no
 * notice after a merge that changed main or preload (the renderer then calls a
 * preload method that does not exist), or a notice for a change that touched
 * nothing Electron runs.
 */
const require = createRequire(import.meta.url);
const {
  createStalenessChecker,
  hashBundleContents,
  hashWrittenBundles,
  staleBundleLabels,
} = require('../../scripts/main-bundle-staleness.js') as {
  createStalenessChecker: (options: {
    buildFreshHashes: () => Promise<Map<string, string | null>>;
    getRunningHashes: () => Map<string, string | null>;
    onStaleChange: (labels: string[]) => void;
    onBuildError?: (error: unknown) => void;
    debounceMs?: number;
    setTimer?: (callback: () => void, delayMs: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  }) => {
    noteSourceChange: () => void;
    current: () => string[];
    markCurrent: () => void;
    dispose: () => void;
  };
  hashBundleContents: (contents: string | Uint8Array) => string;
  hashWrittenBundles: (bundles: Array<{ label: string; outfile: string }>) => Map<string, string | null>;
  staleBundleLabels: (running: Map<string, string | null>, fresh: Map<string, string | null>) => string[];
};

/** A hand-run clock, so a test fires the debounce when it chooses. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    setTimer: (callback: () => void) => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fireAll: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: () => pending.size,
  };
}

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('staleBundleLabels', () => {
  it('names each bundle whose output changed, sorted, and nothing else', () => {
    const running = new Map([['preload', 'a'], ['main', 'b'], ['pty host', 'c']]);
    const fresh = new Map([['preload', 'a2'], ['main', 'b2'], ['pty host', 'c']]);
    expect(staleBundleLabels(running, fresh)).toEqual(['main', 'preload']);
  });

  it('treats a bundle that could not be read at boot as changed', () => {
    expect(staleBundleLabels(new Map([['main', null]]), new Map([['main', 'b']]))).toEqual(['main']);
  });
});

describe('hashWrittenBundles', () => {
  it('hashes the bytes on disk the way an in-memory build hashes its output', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-staleness-'));
    try {
      const outfile = path.join(directory, 'index.js');
      fs.writeFileSync(outfile, 'console.log("main");\n');
      const hashes = hashWrittenBundles([
        { label: 'main', outfile },
        { label: 'missing', outfile: path.join(directory, 'missing.js') },
      ]);
      expect(hashes.get('main')).toBe(hashBundleContents(new TextEncoder().encode('console.log("main");\n')));
      expect(hashes.get('missing')).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('createStalenessChecker', () => {
  it('debounces a burst of changes into one build and reports the stale bundles', async () => {
    const timers = manualTimers();
    const buildFreshHashes = vi.fn(async () => new Map([['main', 'new'], ['preload', 'same']]));
    const onStaleChange = vi.fn();
    const checker = createStalenessChecker({
      buildFreshHashes,
      getRunningHashes: () => new Map([['main', 'old'], ['preload', 'same']]),
      onStaleChange,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    checker.noteSourceChange();
    checker.noteSourceChange();
    expect(timers.pendingCount()).toBe(1);
    timers.fireAll();
    await flushPromises();

    expect(buildFreshHashes).toHaveBeenCalledTimes(1);
    expect(onStaleChange).toHaveBeenCalledWith(['main']);
    expect(checker.current()).toEqual(['main']);
  });

  it('raises nothing when the source changed but no output did', async () => {
    const timers = manualTimers();
    const onStaleChange = vi.fn();
    const checker = createStalenessChecker({
      buildFreshHashes: async () => new Map([['main', 'same']]),
      getRunningHashes: () => new Map([['main', 'same']]),
      onStaleChange,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();

    expect(onStaleChange).not.toHaveBeenCalled();
    expect(checker.current()).toEqual([]);
  });

  it('keeps the last answer while the source does not build', async () => {
    const timers = manualTimers();
    const onStaleChange = vi.fn();
    const onBuildError = vi.fn();
    let buildFails = false;
    const checker = createStalenessChecker({
      buildFreshHashes: async () => {
        if (buildFails) throw new Error('Expected ";" but found "}"');
        return new Map([['main', 'new']]);
      },
      getRunningHashes: () => new Map([['main', 'old']]),
      onStaleChange,
      onBuildError,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    buildFails = true;
    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();

    expect(onBuildError).toHaveBeenCalledTimes(1);
    expect(onStaleChange).toHaveBeenCalledTimes(1);
    expect(checker.current()).toEqual(['main']);
  });

  it('runs one more build for a change that lands mid-build, never two at once', async () => {
    const timers = manualTimers();
    let releaseBuild: () => void = () => {};
    let buildsInFlight = 0;
    let maximumInFlight = 0;
    let buildCount = 0;
    const buildFreshHashes = vi.fn(() => new Promise<Map<string, string | null>>((resolve) => {
      buildsInFlight += 1;
      buildCount += 1;
      maximumInFlight = Math.max(maximumInFlight, buildsInFlight);
      const hash = `build-${buildCount}`;
      releaseBuild = () => {
        buildsInFlight -= 1;
        resolve(new Map([['main', hash]]));
      };
    }));
    const onStaleChange = vi.fn();
    const checker = createStalenessChecker({
      buildFreshHashes,
      getRunningHashes: () => new Map([['main', 'build-1']]),
      onStaleChange,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    // A change lands while the first build runs.
    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    expect(buildFreshHashes).toHaveBeenCalledTimes(1);

    releaseBuild();
    await flushPromises();
    expect(buildFreshHashes).toHaveBeenCalledTimes(2);
    releaseBuild();
    await flushPromises();

    expect(maximumInFlight).toBe(1);
    expect(onStaleChange).toHaveBeenLastCalledWith(['main']);
  });

  it('reports an empty list once a restart runs a fresh build', async () => {
    const timers = manualTimers();
    const onStaleChange = vi.fn();
    const checker = createStalenessChecker({
      buildFreshHashes: async () => new Map([['preload', 'new']]),
      getRunningHashes: () => new Map([['preload', 'old']]),
      onStaleChange,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    checker.markCurrent();

    expect(onStaleChange.mock.calls).toEqual([[['preload']], [[]]]);
    expect(checker.current()).toEqual([]);
  });

  it('clears a pending debounce on dispose, and schedules nothing after it', () => {
    const timers = manualTimers();
    const buildFreshHashes = vi.fn(async () => new Map([['main', 'new']]));
    const checker = createStalenessChecker({
      buildFreshHashes,
      getRunningHashes: () => new Map([['main', 'old']]),
      onStaleChange: vi.fn(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    expect(timers.pendingCount()).toBe(1);
    checker.dispose();
    expect(timers.pendingCount(), 'the pending timer is cleared').toBe(0);

    checker.noteSourceChange();
    expect(timers.pendingCount(), 'nothing is scheduled after dispose').toBe(0);
    expect(buildFreshHashes).not.toHaveBeenCalled();
  });

  it('reports nothing from a build that resolves after dispose', async () => {
    const timers = manualTimers();
    let resolveBuild: (hashes: Map<string, string | null>) => void = () => {};
    const onStaleChange = vi.fn();
    const checker = createStalenessChecker({
      buildFreshHashes: () => new Promise((resolve) => { resolveBuild = resolve; }),
      getRunningHashes: () => new Map([['main', 'old']]),
      onStaleChange,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    checker.dispose();
    resolveBuild(new Map([['main', 'new']]));
    await flushPromises();

    expect(onStaleChange).not.toHaveBeenCalled();
  });

  it('raises no build error from a build that rejects after dispose', async () => {
    const timers = manualTimers();
    let rejectBuild: (reason: unknown) => void = () => {};
    const onBuildError = vi.fn();
    const checker = createStalenessChecker({
      buildFreshHashes: () => new Promise((_resolve, reject) => { rejectBuild = reject; }),
      getRunningHashes: () => new Map([['main', 'old']]),
      onStaleChange: vi.fn(),
      onBuildError,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    checker.dispose();
    rejectBuild(new Error('source does not build'));
    await flushPromises();

    expect(onBuildError).not.toHaveBeenCalled();
  });

  it('drops a build that was in flight when markCurrent ran, even if its hashes differ from the new running ones', async () => {
    const timers = manualTimers();
    let resolveBuild: (hashes: Map<string, string | null>) => void = () => {};
    let runningHashes = new Map<string, string | null>([['main', 'old']]);
    const onStaleChange = vi.fn();
    const checker = createStalenessChecker({
      buildFreshHashes: () => new Promise((resolve) => { resolveBuild = resolve; }),
      getRunningHashes: () => runningHashes,
      onStaleChange,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    // Something is stale first, so markCurrent has a change to report.
    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    resolveBuild(new Map([['main', 'build-a']]));
    await flushPromises();
    expect(checker.current()).toEqual(['main']);

    // A second build starts, then a restart lands before it finishes.
    checker.noteSourceChange();
    timers.fireAll();
    await flushPromises();
    runningHashes = new Map([['main', 'restart-build']]);
    checker.markCurrent();
    expect(onStaleChange).toHaveBeenLastCalledWith([]);
    const callsAfterMarkCurrent = onStaleChange.mock.calls.length;

    // The old build read the source before the restart's build; it would call
    // the restart's build stale.
    resolveBuild(new Map([['main', 'older-read']]));
    await flushPromises();

    expect(onStaleChange.mock.calls.length, 'the dropped build reports nothing').toBe(callsAfterMarkCurrent);
    expect(checker.current()).toEqual([]);
  });
});
