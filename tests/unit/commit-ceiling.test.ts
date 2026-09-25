import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

/**
 * readProcessCommitBytes (src/main/utility-process/commit-ceiling.ts) is the
 * real body behind every ceiling test in embed-client.test.ts and
 * dictation-client.test.ts - both inject a fake `readCommitBytes`, so this
 * function's own body has never run anywhere in the suite. Electron reports
 * `memory.privateBytes` in KILOBYTES, so a reverted `* 1024` would be a
 * 1024x error nothing else catches.
 */

interface FakeAppMetric {
  pid: number;
  memory: { privateBytes?: number };
}

const electronMock = vi.hoisted(() => ({
  metrics: [] as FakeAppMetric[],
}));

vi.mock('electron', () => ({
  app: { getAppMetrics: () => electronMock.metrics },
}));

import {
  readProcessCommitBytes,
  WORKER_COMMIT_CEILING_BYTES,
  HEAVY_IDLE_SHUTDOWN_MS,
} from '../../src/main/utility-process/commit-ceiling';

function setMetrics(entries: FakeAppMetric[]): void {
  electronMock.metrics = entries;
}

describe('readProcessCommitBytes', () => {
  beforeEach(() => {
    setMetrics([]);
  });

  it("converts the matched pid's privateBytes from kilobytes to an exact byte count", () => {
    setMetrics([{ pid: 4242, memory: { privateBytes: 1234 } }]);
    expect(readProcessCommitBytes(4242)).toBe(1_263_616);
  });

  it('returns null when the pid is absent from the process table', () => {
    setMetrics([{ pid: 111, memory: { privateBytes: 5000 } }]);
    expect(readProcessCommitBytes(222)).toBeNull();
  });

  it('returns null, not NaN or 0, for a matched entry with no privateBytes - the macOS/Linux shape, since the field is win32-only', () => {
    setMetrics([{ pid: 4242, memory: {} }]);
    expect(readProcessCommitBytes(4242)).toBeNull();
  });

  it('scans past a non-matching entry to find the target pid further down the table', () => {
    setMetrics([
      { pid: 111, memory: { privateBytes: 999 } },
      { pid: 4242, memory: { privateBytes: 2000 } },
    ]);
    expect(readProcessCommitBytes(4242)).toBe(2000 * 1024);
  });
});

describe('commit ceiling constants', () => {
  it('pins the ceiling at 1.5 GiB', () => {
    expect(WORKER_COMMIT_CEILING_BYTES).toBe(1.5 * 1024 * 1024 * 1024);
  });

  it('pins the heavy idle shutdown window at 120000ms', () => {
    expect(HEAVY_IDLE_SHUTDOWN_MS).toBe(120_000);
  });
});
