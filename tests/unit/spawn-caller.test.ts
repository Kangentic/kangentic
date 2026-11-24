import { afterEach, describe, expect, it } from 'vitest';
import {
  getEventLoopLagReport,
  isTimingSyncWork,
  startEventLoopLagMonitor,
  stopEventLoopLagMonitor,
} from '../../src/main/diagnostics/event-loop-lag';
import { stackCallerLabel } from '../../src/main/diagnostics/spawn-caller';

/**
 * `spawn-caller.ts` names the code that asked for a child process, for the lag
 * report's spawn spans. The label is what tells a developer which caller to
 * move when a start shows up on main's thread.
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

  it('answers unknown when no frame of the bundle is on the stack', () => {
    expect(stackCallerLabel(/no-such-bundle-file/)).toBe('unknown');
  });

  describe('its own timing span', () => {
    function spawnCallerSpanCount(): number {
      return getEventLoopLagReport().syncWorkByLabel['diag:spawn-caller']?.count ?? 0;
    }
    function startOfSpawn(): string {
      return stackCallerLabel(THIS_FILE);
    }

    afterEach(() => {
      stopEventLoopLagMonitor();
    });

    it('counts one span per call while the lag monitor times work, and leaves the label the one an untimed call gets', () => {
      const untimedLabel = startOfSpawn();
      expect(isTimingSyncWork()).toBe(false);
      expect(untimedLabel.split('<')[0]).toBe('startOfSpawn');

      startEventLoopLagMonitor();
      expect(isTimingSyncWork()).toBe(true);
      const countBefore = spawnCallerSpanCount();
      const timedLabel = startOfSpawn();
      const countAfterOne = spawnCallerSpanCount();
      startOfSpawn();
      const countAfterTwo = spawnCallerSpanCount();

      // A timeSyncWork wrapper would put its own frames on the stack and change the label.
      expect(timedLabel).toBe(untimedLabel);
      expect(countAfterOne).toBe(countBefore + 1);
      expect(countAfterTwo).toBe(countBefore + 2);
    });

    it('records no span while nothing times work', () => {
      stopEventLoopLagMonitor();
      expect(isTimingSyncWork()).toBe(false);
      const countBefore = spawnCallerSpanCount();

      startOfSpawn();

      expect(spawnCallerSpanCount()).toBe(countBefore);
    });
  });
});
