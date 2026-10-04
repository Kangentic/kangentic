/**
 * The WSL reap's shared script budget (src/main/pty/process-tag/wsl-reap.ts,
 * reapTaggedProcessesInWsl). Its script calls share one WSL_SCRIPT_TIMEOUT_MS:
 * each batch's wsl.exe gets what the earlier batches left, the listings are not
 * charged to it, and a batch that finds nothing left never runs. The reap then
 * hands "ran out of time" to onFailure once and still returns the pids the
 * earlier batches killed.
 *
 * task-process-tag.test.ts pins the exact timeouts across three batches. This
 * file pins the rest: the decrement as the constant minus the first call's own
 * time, the listings staying out of it, the zero-left boundary, the failure's
 * text, and the pids returned. A fake exec is injected and the clock is faked,
 * so it runs on every OS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WSL_SCRIPT_TIMEOUT_MS,
  batchWslReapTasks,
  reapTaggedProcessesInWsl,
  type WslExec,
  type WslReapTask,
} from '../../src/main/pty/process-tag/wsl-reap';

const START_OF_TIME_MS = 1_700_000_000_000;
const DEFAULT_DISTRO_LISTING = '  NAME      STATE      VERSION\n* Ubuntu    Running    2\n';

/** One task per index, each with its project and a `.kangentic\worktrees\<slug>` directory. */
function buildRealisticReapTasks(count: number): WslReapTask[] {
  return Array.from({ length: count }, (_unused, index) => {
    const project = `C:\\Users\\dev\\projects\\service-${index}`;
    return {
      taskId: `3f2b8c1e-5d7a-4c9b-8e1f-${index.toString(16).padStart(12, '0')}`,
      directories: [project, `${project}\\.kangentic\\worktrees\\implement-board-filter-${index}`],
    };
  });
}

/** What one script call "takes" on the fake clock, and what it prints. */
interface ScriptStep {
  elapsedMs: number;
  output: string;
}

interface ScriptCall {
  args: string[];
  timeoutMs: number;
}

let clockMs = START_OF_TIME_MS;

/**
 * A fake `exec` for a running Ubuntu distro. Each listing advances the clock by
 * `listingElapsedMs`; script call N (from 1) advances it by `steps[N - 1].elapsedMs`
 * and prints that step's output. A call past the steps takes no time and prints nothing.
 */
function createFakeWsl(steps: ScriptStep[], listingElapsedMs = 0): { exec: WslExec; scriptCalls: ScriptCall[] } {
  const scriptCalls: ScriptCall[] = [];
  const exec: WslExec = async (_file, args, options) => {
    if (args.includes('--running')) {
      clockMs += listingElapsedMs;
      return 'Ubuntu\n';
    }
    if (args.includes('-v')) {
      clockMs += listingElapsedMs;
      return DEFAULT_DISTRO_LISTING;
    }
    if (args[0] !== '-d') throw new Error(`unexpected wsl.exe call: ${args.join(' ')}`);
    scriptCalls.push({ args, timeoutMs: options.timeoutMs });
    const step = steps[scriptCalls.length - 1] ?? { elapsedMs: 0, output: '' };
    clockMs += step.elapsedMs;
    return step.output;
  };
  return { exec, scriptCalls };
}

beforeEach(() => {
  clockMs = START_OF_TIME_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the WSL reap script budget', () => {
  const manyTasks = buildRealisticReapTasks(400);

  // A fixture that fits fewer batches than a test needs would let it pass
  // vacuously, so each test states how many it needs.
  function expectBatchCountOfAtLeast(minimum: number): void {
    expect(batchWslReapTasks(manyTasks).length).toBeGreaterThanOrEqual(minimum);
  }

  describe('sharing the budget between batches', () => {
    it('charges only the script calls to the budget, not the two wsl.exe listings before them', async () => {
      expectBatchCountOfAtLeast(2);
      const listingMs = 3_000;
      const firstCallMs = 1_000;
      const { exec, scriptCalls } = createFakeWsl([{ elapsedMs: firstCallMs, output: '' }], listingMs);
      const failures: unknown[] = [];

      // `distro: null` makes the reap read the default distro, so both listings run and each takes 3 s.
      await reapTaggedProcessesInWsl({ distro: null }, manyTasks, exec, (error) => failures.push(error));

      expect(scriptCalls[0].timeoutMs).toBe(WSL_SCRIPT_TIMEOUT_MS);
      expect(scriptCalls[1].timeoutMs).toBe(WSL_SCRIPT_TIMEOUT_MS - firstCallMs);
      expect(failures).toEqual([]);
    });
  });

  describe('when a batch finds the budget spent', () => {
    it.each([
      ['exactly the whole budget', WSL_SCRIPT_TIMEOUT_MS],
      ['more than the whole budget', WSL_SCRIPT_TIMEOUT_MS + 2_500],
    ])('after a first call that took %s, runs no second call, reports ran out of time once, and returns the first batch\'s pids', async (_label, firstCallMs) => {
      expectBatchCountOfAtLeast(2);
      const { exec, scriptCalls } = createFakeWsl([{ elapsedMs: firstCallMs, output: ' 4242 4243\n' }]);
      const failures: unknown[] = [];

      const killedPids = await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, (error) => failures.push(error));

      expect(scriptCalls).toHaveLength(1);
      expect(scriptCalls[0].timeoutMs).toBe(WSL_SCRIPT_TIMEOUT_MS);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(Error);
      expect((failures[0] as Error).message).toMatch(/ran out of time/);
      expect(killedPids).toEqual([4242, 4243]);
    });

    it('returns the pids of every batch that ran before the budget ran out, and not a later batch\'s', async () => {
      expectBatchCountOfAtLeast(3);
      // The second call takes the last 7 s, so the third batch finds 0 ms left.
      const firstCallMs = 3_000;
      const secondCallMs = WSL_SCRIPT_TIMEOUT_MS - firstCallMs;
      const { exec, scriptCalls } = createFakeWsl([
        { elapsedMs: firstCallMs, output: ' 4242\n' },
        { elapsedMs: secondCallMs, output: ' 4343\n' },
        { elapsedMs: 0, output: ' 4444\n' },
      ]);
      const failures: unknown[] = [];

      const killedPids = await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, (error) => failures.push(error));

      expect(scriptCalls.map((call) => call.timeoutMs)).toEqual([WSL_SCRIPT_TIMEOUT_MS, WSL_SCRIPT_TIMEOUT_MS - firstCallMs]);
      expect(failures).toHaveLength(1);
      expect((failures[0] as Error).message).toMatch(/ran out of time/);
      expect(killedPids).toEqual([4242, 4343]);
    });

    it('does not report ran out of time when the last batch leaves the budget exactly spent', async () => {
      // Only a batch that still has to run finds the budget empty: a spent budget after the last one is a clean finish.
      const batchCount = batchWslReapTasks(manyTasks).length;
      expect(batchCount).toBeGreaterThanOrEqual(2);
      const steps: ScriptStep[] = Array.from({ length: batchCount }, (_unused, index) => ({
        elapsedMs: index === batchCount - 1 ? WSL_SCRIPT_TIMEOUT_MS - 1_000 * (batchCount - 1) : 1_000,
        output: ` ${5000 + index}\n`,
      }));
      const { exec, scriptCalls } = createFakeWsl(steps);
      const failures: unknown[] = [];

      const killedPids = await reapTaggedProcessesInWsl({ distro: 'Ubuntu' }, manyTasks, exec, (error) => failures.push(error));

      expect(scriptCalls).toHaveLength(batchCount);
      expect(failures).toEqual([]);
      expect(killedPids).toEqual(steps.map((_step, index) => 5000 + index));
    });
  });
});
