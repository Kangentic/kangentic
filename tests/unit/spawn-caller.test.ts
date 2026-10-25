import { describe, expect, it } from 'vitest';
import { describeSpawnCaller, stackCallerLabel, storedSpawnCaller, withSpawnCaller } from '../../src/main/diagnostics/spawn-caller';

/**
 * `spawn-caller.ts` names the code that asked for a child process, for the lag
 * report's spawn spans. A simple-git spawn's own stack names only simple-git's
 * scheduler, so the caller is stored where Kangentic code made the call and
 * read back across awaits.
 */

/** This test file's frames stand in for the app bundle's. */
const THIS_FILE = /spawn-caller\.test\.ts/;

describe('spawn caller', () => {
  it('names the nearest named frames of the bundle, innermost first, skipping the plumbing', () => {
    function refreshBranchSummary(): string {
      return execFileAsync();
    }
    function execFileAsync(): string {
      return stackCallerLabel(THIS_FILE);
    }
    // The wrapper is skipped, the function that wanted the process is named.
    const throughWrapper = refreshBranchSummary();
    expect(throughWrapper.split('<')[0]).toBe('refreshBranchSummary');
    expect(throughWrapper).not.toContain('execFileAsync');
  });

  it('keeps an awaiting caller, which V8 lists as an async frame', async () => {
    async function readCommitGraph(): Promise<string> {
      await Promise.resolve();
      return stackCallerLabel(THIS_FILE);
    }
    async function loadGraphPanel(): Promise<string> {
      return await readCommitGraph();
    }
    const label = await loadGraphPanel();
    expect(label.split('<')).toEqual(expect.arrayContaining(['readCommitGraph', 'loadGraphPanel']));
  });

  it('carries a stored caller across awaits and prefers it over the stack', async () => {
    expect(storedSpawnCaller()).toBeUndefined();
    const seen = await withSpawnCaller('getBranchSummary', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return describeSpawnCaller();
    });
    expect(seen).toBe('getBranchSummary');
    expect(storedSpawnCaller()).toBeUndefined();
  });

  it('answers unknown when no frame of the bundle is on the stack', () => {
    expect(stackCallerLabel(/no-such-bundle-file/)).toBe('unknown');
  });
});
