import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * getProcessMetrics() (src/main/diagnostics/process-metrics.ts) builds its
 * `main` block as a direct field-by-field copy of `process.memoryUsage()`.
 * Nothing exercised this function before this file, so a swapped mapping
 * (heapTotalBytes fed from heapUsed, say) would pass every other test in the
 * suite silently. Five distinguishable stub values make a swap visible;
 * equal values would let one pass unnoticed.
 */

const { mockGetAppMetrics, mockGetVersion } = vi.hoisted(() => ({
  mockGetAppMetrics: vi.fn(),
  mockGetVersion: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getAppMetrics: mockGetAppMetrics, getVersion: mockGetVersion },
}));

import { getProcessMetrics } from '../../src/main/diagnostics/process-metrics';

describe('getProcessMetrics', () => {
  let memoryUsageSpy: ReturnType<typeof vi.spyOn>;
  let uptimeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetAppMetrics.mockReset().mockReturnValue([]);
    mockGetVersion.mockReset().mockReturnValue('1.2.3');
  });

  afterEach(() => {
    memoryUsageSpy?.mockRestore();
    uptimeSpy?.mockRestore();
  });

  it("maps each main.* field from its own named process.memoryUsage() field, not a neighbour's", () => {
    // Five distinct values so a cross-wired mapping is visible rather than
    // masked by a shared number every field happens to agree on.
    memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 2_000_003,
      heapTotal: 3_000_017,
      heapUsed: 5_000_009,
      external: 7_000_003,
      arrayBuffers: 11_000_003,
    });

    const result = getProcessMetrics();

    expect(result.main).toEqual({
      rssBytes: 2_000_003,
      heapTotalBytes: 3_000_017,
      heapUsedBytes: 5_000_009,
      externalBytes: 7_000_003,
      arrayBuffersBytes: 11_000_003,
    });
  });

  it('reads uptime and version info straight from process/app, and stamps a real ISO timestamp', () => {
    uptimeSpy = vi.spyOn(process, 'uptime').mockReturnValue(4321.5);
    memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 1,
      heapTotal: 1,
      heapUsed: 1,
      external: 1,
      arrayBuffers: 1,
    });
    mockGetVersion.mockReturnValue('9.9.9');

    const result = getProcessMetrics();

    expect(result.uptimeSec).toBe(4321.5);
    expect(result.platform).toBe(process.platform);
    expect(result.arch).toBe(process.arch);
    expect(result.versions).toEqual({
      kangentic: '9.9.9',
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    });
    // A real, parseable ISO 8601 timestamp - not a hardcoded or malformed one.
    expect(new Date(result.ts).toISOString()).toBe(result.ts);
  });

  it("maps each processes[] entry field from its own named app.getAppMetrics() field, not a neighbour's", () => {
    memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 1,
      heapTotal: 1,
      heapUsed: 1,
      external: 1,
      arrayBuffers: 1,
    });
    mockGetAppMetrics.mockReturnValue([
      {
        pid: 4242,
        type: 'Utility',
        name: 'kangentic-embeddings',
        cpu: { percentCPUUsage: 12.5 },
        memory: { workingSetSize: 111, peakWorkingSetSize: 222, privateBytes: 333 },
        creationTime: 555,
      },
    ]);

    const [entry] = getProcessMetrics().processes;

    expect(entry).toEqual({
      pid: 4242,
      type: 'Utility',
      name: 'kangentic-embeddings',
      cpu: { percentCPUUsage: 12.5 },
      memory: { workingSetSize: 111, peakWorkingSetSize: 222, privateBytes: 333 },
      creationTime: 555,
    });
  });
});
