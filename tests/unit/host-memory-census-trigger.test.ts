/**
 * One census per low-memory spell (Sentry DESKTOP-5C, 5P): the real sampler
 * drives the real census through `onSpellStart`, with the host request and the
 * report injected. A census on every tick would scan every same-user process
 * once a minute for as long as memory stays low, and send an event each time;
 * none at all leaves the next spell as unexplained as the last.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHostMemorySampler } from '../../src/main/diagnostics/host-memory';
import { createHostMemoryCensus, type HostMemoryCensusRequester } from '../../src/main/diagnostics/host-memory-census';
import { emptyCensus, type HostMemoryCensusResult } from '../../src/main/pty/process-tag/memory-census';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/mock', getVersion: () => '0.0.0' } }));

const GB_IN_KB = 1024 * 1024;
const HEALTHY = { total: 16 * GB_IN_KB, free: 8 * GB_IN_KB, swapTotal: 38 * GB_IN_KB, swapFree: 20 * GB_IN_KB };
const LOW = { ...HEALTHY, swapFree: 0.2 * GB_IN_KB };

describe('the low-memory census trigger', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalInfo = (process as unknown as { getSystemMemoryInfo?: () => unknown }).getSystemMemoryInfo;
  let reading = HEALTHY;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    (process as unknown as { getSystemMemoryInfo: () => typeof reading }).getSystemMemoryInfo = () => reading;
    reading = HEALTHY;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalInfo) (process as unknown as { getSystemMemoryInfo: typeof originalInfo }).getSystemMemoryInfo = originalInfo;
    else delete (process as unknown as { getSystemMemoryInfo?: unknown }).getSystemMemoryInfo;
  });

  function run(platform: NodeJS.Platform, answer: () => Promise<HostMemoryCensusResult>) {
    const requests: number[][] = [];
    const reports: Array<Record<string, string>> = [];
    const failures: unknown[] = [];
    const requester: HostMemoryCensusRequester = async (request) => {
      requests.push(request.electronPids);
      return answer();
    };
    const census = createHostMemoryCensus({
      platform,
      requester: () => requester,
      electronPids: () => [10, 11],
      classify: () => 'unknown',
      report: (tags) => reports.push(tags),
      failureReporter: { report: (error) => { failures.push(error); } },
    });
    const dispose = startHostMemorySampler({ intervalMs: 1000, onSpellStart: () => { void census.onSpellStart(); } });
    return { requests, reports, failures, dispose };
  }

  it('sends exactly one census for a spell however long it lasts, and one more for the next spell', async () => {
    const { requests, reports, dispose } = run('win32', async () => ({ ...emptyCensus(true, false), otherSameUser: { bytes: 20 * 1024 ** 3, count: 300 } }));

    await vi.advanceTimersByTimeAsync(2000);
    expect(requests).toHaveLength(0);

    reading = LOW;
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toEqual([[10, 11]]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ census: 'ok', other_same_user_gb: '16-32', other_same_user_count: '100+' });

    reading = HEALTHY;
    await vi.advanceTimersByTimeAsync(2000);
    reading = LOW;
    await vi.advanceTimersByTimeAsync(3000);
    expect(reports).toHaveLength(2);
    dispose();
  });

  it('runs no census off Windows', async () => {
    const { requests, reports, dispose } = run('linux', async () => emptyCensus(true, false));
    reading = LOW;
    await vi.advanceTimersByTimeAsync(3000);

    expect(requests).toHaveLength(0);
    expect(reports).toHaveLength(0);
    dispose();
  });

  it('reports a host that did not answer once, and sends no census for it', async () => {
    const { reports, failures, dispose } = run('win32', async () => { throw new Error('host timed out'); });
    reading = LOW;
    await vi.advanceTimersByTimeAsync(3000);

    expect(failures).toHaveLength(1);
    expect(reports).toHaveLength(0);
    dispose();
  });

  it('sends a census the host could not take as failed, so a spell is never silent', async () => {
    const { reports, dispose } = run('win32', async () => emptyCensus(true, true));
    reading = LOW;
    await vi.advanceTimersByTimeAsync(2000);

    expect(reports).toEqual([expect.objectContaining({ census: 'failed' })]);
    dispose();
  });

  it('starts no second census while one is still running', async () => {
    vi.useRealTimers();
    let release: (result: HostMemoryCensusResult) => void = () => undefined;
    const requests: number[] = [];
    const census = createHostMemoryCensus({
      platform: 'win32',
      requester: () => async () => {
        requests.push(1);
        return new Promise<HostMemoryCensusResult>((resolve) => { release = resolve; });
      },
      electronPids: () => [],
      classify: () => 'unknown',
      report: () => undefined,
      failureReporter: { report: () => undefined },
    });
    const first = census.onSpellStart();
    await census.onSpellStart();
    expect(requests).toHaveLength(1);
    release(emptyCensus(true, false));
    await first;
    const next = census.onSpellStart();
    expect(requests).toHaveLength(2);
    release(emptyCensus(true, false));
    await next;
  });
});
