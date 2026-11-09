/**
 * Does the main-process build that Electron is running still match the source on
 * disk? scripts/dev.js asks this so a long `npm start` session can say when a
 * merge changed main, preload or worker code, which Vite's HMR cannot deliver.
 * The renderer shows a Restart notice (src/renderer/utils/dev-restart.ts).
 *
 * The answer comes from the BUILD OUTPUT, not the paths that changed: dev.js
 * builds every bundle again in memory (esbuild `write: false`) and compares each
 * output's hash with the one Electron booted on. A `src/shared` change only the
 * renderer imports, or a comment esbuild drops, leaves the output the same and
 * raises nothing. Nothing is written while Electron runs: a pop-out window loads
 * `preload.js` from disk when it opens, so a rebuilt file under a running app
 * would pair a new preload with the old main.
 *
 * Plain CommonJS with its clock and builder passed in, so
 * tests/unit/main-bundle-staleness.test.ts runs it as written.
 */
const crypto = require('crypto');
const fs = require('fs');

/** sha256 of one bundle's bytes. */
function hashBundleContents(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

/** Hashes of the bundles on disk, by label. A bundle that cannot be read hashes
 *  as null, so any later build of it reads as changed. */
function hashWrittenBundles(bundles) {
  const hashes = new Map();
  for (const bundle of bundles) {
    try {
      hashes.set(bundle.label, hashBundleContents(fs.readFileSync(bundle.outfile)));
    } catch {
      hashes.set(bundle.label, null);
    }
  }
  return hashes;
}

/** Labels whose fresh hash differs from the running one, sorted. */
function staleBundleLabels(runningHashes, freshHashes) {
  const stale = [];
  for (const [label, freshHash] of freshHashes) {
    if (runningHashes.get(label) !== freshHash) stale.push(label);
  }
  return stale.sort();
}

/**
 * Debounces source changes into in-memory builds and reports when the set of
 * stale bundles changes.
 *
 * - `buildFreshHashes()` resolves the fresh hashes by label. A rejection means
 *   the source does not build right now (mid-edit); the last answer stands.
 * - `getRunningHashes()` returns the hashes Electron booted on.
 * - `onStaleChange(labels)` fires only when the sorted label list changes, an
 *   empty list included.
 * - One build at a time: a change that lands during a build runs one more after
 *   it, never two at once.
 * - A build that was running when `markCurrent()` was called is dropped: it
 *   read the source before the restart's build, so it would call that build
 *   stale.
 */
function createStalenessChecker({
  buildFreshHashes,
  getRunningHashes,
  onStaleChange,
  onBuildError = () => {},
  debounceMs = 2000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let debounceTimer = null;
  let checking = false;
  let checkAgain = false;
  let disposed = false;
  let reported = [];
  /** Bumped by markCurrent(), so a build that started before it is dropped. */
  let baselineGeneration = 0;

  function report(labels) {
    if (labels.join('\n') === reported.join('\n')) return;
    reported = labels;
    onStaleChange(labels);
  }

  async function check() {
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      do {
        checkAgain = false;
        const generationAtStart = baselineGeneration;
        let freshHashes;
        try {
          freshHashes = await buildFreshHashes();
        } catch (buildError) {
          if (disposed) return;
          onBuildError(buildError);
          continue;
        }
        if (disposed) return;
        if (generationAtStart !== baselineGeneration) continue;
        report(staleBundleLabels(getRunningHashes(), freshHashes));
      } while (checkAgain && !disposed);
    } finally {
      checking = false;
    }
  }

  return {
    /** A watched source file changed. */
    noteSourceChange() {
      if (disposed) return;
      if (debounceTimer !== null) clearTimer(debounceTimer);
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        void check();
      }, debounceMs);
    },
    /** The stale labels last reported. */
    current() {
      return reported;
    },
    /** Electron now runs a fresh build: nothing is stale. */
    markCurrent() {
      baselineGeneration += 1;
      report([]);
    },
    dispose() {
      disposed = true;
      if (debounceTimer !== null) clearTimer(debounceTimer);
      debounceTimer = null;
    },
  };
}

module.exports = {
  hashBundleContents,
  hashWrittenBundles,
  staleBundleLabels,
  createStalenessChecker,
};
