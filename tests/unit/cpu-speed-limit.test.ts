/**
 * The CPU speed limit a screenshot timeout reports (DESKTOP-46). The bucket is a
 * Sentry tag, so its edges decide which runs group together, and a value the OS
 * sends outside 0 to 100 must still land in a bucket rather than read `unknown`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  cpuSpeedLimitBucket,
  noteCpuSpeedLimit,
  resetCpuSpeedLimitForTests,
} from '../../src/main/browser/cpu-speed-limit';

describe('cpuSpeedLimitBucket', () => {
  afterEach(() => {
    resetCpuSpeedLimitForTests();
  });

  it('is unknown before any speed-limit-change arrives', () => {
    expect(cpuSpeedLimitBucket()).toBe('unknown');
  });

  it.each([
    { limit: 140, bucket: '100' },
    { limit: 100, bucket: '100' },
    { limit: 99, bucket: '75-99' },
    { limit: 75, bucket: '75-99' },
    { limit: 74, bucket: '50-74' },
    { limit: 50, bucket: '50-74' },
    { limit: 49, bucket: '<50' },
    { limit: 0, bucket: '<50' },
  ])('buckets a limit of $limit as $bucket', ({ limit, bucket }) => {
    noteCpuSpeedLimit(limit);
    expect(cpuSpeedLimitBucket()).toBe(bucket);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '62', undefined])('reads %s as unknown', (limit) => {
    noteCpuSpeedLimit(62);
    noteCpuSpeedLimit(limit);
    expect(cpuSpeedLimitBucket()).toBe('unknown');
  });

  it('reports the latest limit, not the lowest', () => {
    noteCpuSpeedLimit(30);
    noteCpuSpeedLimit(100);
    expect(cpuSpeedLimitBucket()).toBe('100');
  });
});
