import type { HostMemorySample } from '../../../src/shared/types';

export const GIBIBYTE = 1024 * 1024 * 1024;

/**
 * A Windows memory sample with this much commit left of a 64 GB limit. On that
 * limit memory reads low below 2 GB and recovered past 4 GB
 * (`memoryHeadroom`, `updateLowMemoryLatch`).
 */
export function windowsSample(remainingBytes: number, ts: string = new Date().toISOString()): HostMemorySample {
  return {
    ts,
    platform: 'win32',
    commitLimitBytes: 64 * GIBIBYTE,
    commitRemainingBytes: remainingBytes,
    physicalTotalBytes: 32 * GIBIBYTE,
    physicalFreeBytes: 4 * GIBIBYTE,
    physicalAvailableBytes: null,
  };
}
