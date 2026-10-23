/**
 * Unit coverage for `runEsbuildBundles` in scripts/build.js: a build that
 * uploads to Sentry runs its esbuild bundles one at a time.
 *
 * The esbuild Sentry plugin drives the `sentry` package in-process, and that
 * package keeps ONE module-global env. Every command installs its own copy
 * carrying the token, org and project, then puts `process.env` back in a
 * `finally`. Two uploads in flight at once share that slot, so the first to
 * finish strips the token from the other, which fails "Not authenticated".
 * v0.49.0's first release run failed that way on all five platforms, each
 * after one to six of the seven bundles had uploaded. A build that does not
 * upload keeps its bundles parallel.
 *
 * Tier: Unit.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// scripts/build.js is CJS; vite-node's require/import interop lets the named
// export through a plain ES import, as in assert-vendor-chunks-lazy.test.ts.
import { runEsbuildBundles } from '../../scripts/build.js';

// build.js pins process.env.NODE_ENV to 'production' at module load. Captured
// before the hoisted import above runs, and restored after, so the value does
// not leak into later files in this worker.
const originalNodeEnv = vi.hoisted(() => process.env.NODE_ENV);
afterAll(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

interface FakeBundle {
  name: string;
}

/** A stand-in for esbuild.build that records how many builds overlap. */
function createRecordingBuilder(): { buildBundle: (bundle: FakeBundle) => Promise<void>; maxInFlight: () => number; order: string[] } {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const buildBundle = async (bundle: FakeBundle): Promise<void> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`start ${bundle.name}`);
    // A real macrotask boundary, so a parallel caller has every build started before any ends.
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end ${bundle.name}`);
    inFlight--;
  };
  return { buildBundle, maxInFlight: () => maxInFlight, order };
}

const BUNDLES: FakeBundle[] = ['index', 'preload', 'embed-worker', 'line-count-worker', 'dictation-worker', 'retrieval-worker', 'pty-host']
  .map((name) => ({ name }));

describe('runEsbuildBundles', () => {
  it('runs one bundle at a time when the build uploads to Sentry', async () => {
    const recorder = createRecordingBuilder();
    await runEsbuildBundles(BUNDLES, recorder.buildBundle, { sequential: true });
    expect(recorder.maxInFlight()).toBe(1);
    // Each bundle ends before the next starts, in the order given.
    expect(recorder.order).toEqual(BUNDLES.flatMap((bundle) => [`start ${bundle.name}`, `end ${bundle.name}`]));
  });

  it('keeps the bundles parallel when the build does not upload', async () => {
    const recorder = createRecordingBuilder();
    await runEsbuildBundles(BUNDLES, recorder.buildBundle, { sequential: false });
    expect(recorder.maxInFlight()).toBe(BUNDLES.length);
  });

  it('stops at the first failed bundle when sequential, so a failed upload fails the build', async () => {
    const started: string[] = [];
    const failing = async (bundle: FakeBundle): Promise<void> => {
      started.push(bundle.name);
      if (bundle.name === 'embed-worker') throw new Error('Not authenticated');
    };
    await expect(runEsbuildBundles(BUNDLES, failing, { sequential: true })).rejects.toThrow('Not authenticated');
    expect(started).toEqual(['index', 'preload', 'embed-worker']);
  });

  it('is what build() runs its esbuild bundles through, sequential exactly when uploading', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'build.js'), 'utf-8');
    const buildBody = source.slice(source.indexOf('async function build()'), source.indexOf('require.main === module'));
    expect(buildBody).toMatch(/runEsbuildBundles\([\s\S]*?\{\s*sequential:\s*uploadSourcemaps\s*\}\s*\)/);
    // No esbuild.build call left outside the helper inside build().
    expect(buildBody).not.toMatch(/Promise\.all\(\[\s*esbuild\.build/);
  });
});
